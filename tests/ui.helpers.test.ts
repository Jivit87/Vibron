import { describe, expect, it } from "vitest";

import {
  expandTemplate,
  findMentionTrigger,
  findSlashTrigger,
  fuzzyScore,
  inferCodeBlockPath,
  parseCommandFile,
  parseSlashCommand,
  removeTrigger,
} from "@/lib/composer/parsing";
import { diffLines, withContext } from "@/lib/client/line-diff";
import { addStep, moveStep, removeStep, updateStep } from "@/lib/client/plan-edit";
import { applyTerminalEvent, stripAnsi } from "@/lib/client/terminal-stream";
import { groupProblems, groupScmFiles, problemsToText } from "@/lib/client/workspace-types";
import { mergeRecent } from "@/lib/client/recent-workspaces";
import type { RunPlan } from "@/lib/agents/events";
import type { TerminalSessionView } from "@/store/viberon";

describe("composer parsing", () => {
  it("finds @mentions only at word starts", () => {
    expect(findMentionTrigger("see @src/a", 10)).toEqual({ start: 4, query: "src/a" });
    expect(findMentionTrigger("me@example.com", 14)).toBeNull();
    expect(findMentionTrigger("@a b", 4)).toBeNull();
  });

  it("removes a trigger without leaving a double space", () => {
    expect(removeTrigger("fix @foo now", 4, 8)).toEqual({ text: "fix now", caret: 4 });
  });

  it("parses slash commands and templates", () => {
    expect(findSlashTrigger("/fi", 3)).toEqual({ start: 0, query: "fi" });
    expect(parseSlashCommand("/Fix the bug")).toEqual({ name: "fix", args: "the bug" });
    expect(expandTemplate("Review $1 then $ARGUMENTS", '"a b" c')).toBe('Review a b then "a b" c');
    expect(expandTemplate("Review", "auth")).toBe("Review\n\nauth");
    const cmd = parseCommandFile("review.md", "---\ndescription: Review code\nintent: ask\n---\nLook at $ARGUMENTS");
    expect(cmd).toMatchObject({ name: "review", description: "Review code", intent: "ask" });
  });

  it("ranks basename matches above path matches", () => {
    expect(fuzzyScore("src/index.ts", "index")).toBeGreaterThan(fuzzyScore("index/src.ts", "index"));
    expect(fuzzyScore("abc", "zzz")).toBe(-1);
  });

  it("infers code block targets", () => {
    expect(inferCodeBlockPath("ts", "path=src/a.ts", "")).toBe("src/a.ts");
    expect(inferCodeBlockPath("ts", undefined, "// src/b.ts\nx")).toBe("src/b.ts");
    expect(inferCodeBlockPath("ts", undefined, "const x = 1")).toBeNull();
  });
});

describe("line diff", () => {
  it("marks adds and deletes around common lines", () => {
    const lines = diffLines("a\nb\nc", "a\nx\nc");
    expect(lines.filter((l) => l.kind === "add").map((l) => (l as { text: string }).text)).toEqual(["x"]);
    expect(lines.filter((l) => l.kind === "del").map((l) => (l as { text: string }).text)).toEqual(["b"]);
  });

  it("treats a new file as all additions and collapses context", () => {
    expect(diffLines(null, "a\nb").every((l) => l.kind === "add")).toBe(true);
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const after = [...long];
    after[10] = "changed";
    const ctx = withContext(diffLines(long.join("\n"), after.join("\n")), 1);
    expect(ctx[0]).toEqual({ kind: "gap", hidden: 9 });
    expect(ctx.at(-1)).toEqual({ kind: "gap", hidden: 8 });
  });
});

describe("plan edits", () => {
  const plan: RunPlan = {
    summary: "s",
    steps: [
      { id: "a", title: "A", role: "frontend", detail: "", files: [], dependsOn: [] },
      { id: "b", title: "B", role: "frontend", detail: "", files: [], dependsOn: ["a"] },
    ],
    waves: [["a"], ["b"]],
  };

  it("drops dangling dependencies and recomputes waves on remove", () => {
    const next = removeStep(plan, "a");
    expect(next.steps[0].dependsOn).toEqual([]);
    expect(next.waves).toEqual([["b"]]);
  });

  it("updates, moves and adds steps", () => {
    expect(updateStep(plan, "a", { title: "Z", id: "nope" }).steps[0]).toMatchObject({ id: "a", title: "Z" });
    expect(moveStep(plan, "b", -1).steps.map((s) => s.id)).toEqual(["b", "a"]);
    expect(moveStep(plan, "a", -1)).toBe(plan);
    const added = addStep(plan, "New");
    expect(added.steps).toHaveLength(3);
    expect(added.waves[0]).toContain(added.steps[2].id);
  });
});

describe("terminal stream", () => {
  const session: TerminalSessionView = {
    id: "t",
    command: "ls",
    status: "running",
    exitCode: null,
    output: "",
    detectedUrl: null,
    startedAt: 0,
  };

  it("replaces on fresh history, appends on resume, and drops replayed chunks", () => {
    let s = applyTerminalEvent(session, { type: "history", text: "abc", offset: 3 }, false);
    expect(s).toMatchObject({ output: "abc", offset: 3 });
    s = applyTerminalEvent(s, { type: "chunk", text: "abc", offset: 3 }, false);
    expect(s.output).toBe("abc");
    s = applyTerminalEvent(s, { type: "chunk", text: "de", offset: 5 }, false);
    expect(s).toMatchObject({ output: "abcde", offset: 5 });
    s = applyTerminalEvent(s, { type: "history", text: "f", offset: 6 }, true);
    expect(s.output).toBe("abcdef");
    s = applyTerminalEvent(s, { type: "end", status: "exited", exitCode: 0 }, true);
    expect(s).toMatchObject({ status: "exited", exitCode: 0 });
  });

  it("strips ANSI but keeps bracketed text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m [exited with code 0]")).toBe("red [exited with code 0]");
  });
});

describe("workspace helpers", () => {
  it("groups problems errors-first and dedupes", () => {
    const p = (file: string, severity: "error" | "warning", line = 1) => ({
      file,
      line,
      col: 1,
      severity,
      message: "m",
      source: "ts",
    });
    const groups = groupProblems([p("b.ts", "warning"), p("a.ts", "error"), p("a.ts", "error")]);
    expect(groups.map((g) => g.file)).toEqual(["a.ts", "b.ts"]);
    expect(groups[0].problems).toHaveLength(1);
    expect(problemsToText([p("a.ts", "error", 3)])).toBe("a.ts:3:1 error: m");
  });

  it("orders SCM sections like VS Code", () => {
    const sections = groupScmFiles([
      { path: "b", group: "changes", letter: "M" },
      { path: "a", group: "staged", letter: "A" },
    ]);
    expect(sections.map((s) => s.label)).toEqual(["Staged Changes", "Changes"]);
  });

  it("keeps recent workspaces unique and newest first", () => {
    const list = mergeRecent([{ repoKey: "a", label: "A", openedAt: 1 }], { repoKey: "a", label: "A", openedAt: 2 });
    expect(list).toEqual([{ repoKey: "a", label: "A", openedAt: 2 }]);
  });
});
