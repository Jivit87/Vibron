import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { EMPTY_USAGE, type AiTurnRequest } from "@/lib/ai";
import { addEntry, clearMemoryGraphCache, getMemoryGraph } from "@/lib/memory/graph";
import {
  compressDiff,
  describeDiff,
  groundedIn,
  improveDiff,
  learnReviewStyle,
  reviewDiff,
  reviewModel,
  ReviewOutputError,
  type RunTurnFn,
} from "@/lib/review";
import { parseUnifiedDiff } from "@/lib/review/diff";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const x = 1;
-const y = 2;
+const y = 3;
+const z = 4;
 export { x };
@@ -10,3 +11,2 @@ function f() {
 a
---- sql comment
 c
diff --git a/old.ts b/old.ts
deleted file mode 100644
index 3333333..0000000
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-gone
-gone too
diff --git a/docs/readme.md b/docs/readme.md
new file mode 100644
--- /dev/null
+++ b/docs/readme.md
@@ -0,0 +1,2 @@
+# Title
+Some words.
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
`;

function fakeTurns(...texts: string[]) {
  const requests: AiTurnRequest[] = [];
  const runTurn: RunTurnFn = async (request) => {
    requests.push(structuredClone({ ...request, signal: undefined }));
    return { text: texts.shift() ?? "", usage: { ...EMPTY_USAGE, inputTokens: 10 }, cost: 0.001 };
  };
  const prompt = (i: number) => (requests[i].messages[0].content[0] as { text: string }).text;
  return { requests, runTurn, prompt };
}

const tmpRoots: string[] = [];
function tmpRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vb-review-"));
  tmpRoots.push(root);
  return root;
}
afterEach(() => {
  clearMemoryGraphCache();
  uninstallFakeProvider();
  for (const r of tmpRoots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("compressDiff", () => {
  it("parses files, keeps a removed line that looks like a header inside its hunk", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ["src/a.ts", "modified", false],
      ["old.ts", "deleted", false],
      ["docs/readme.md", "added", false],
      ["img.png", "modified", true],
    ]);
    expect(files[0].hunks[1].lines).toEqual([" a", "---- sql comment", " c"]);
  });

  it("numbers new-side lines, drops delete-only hunks and deleted files, lists what is left out", () => {
    const out = compressDiff(DIFF, 10_000);
    expect(out.included).toEqual(["src/a.ts", "docs/readme.md"]);
    expect(out.omitted).toEqual(["img.png"]);
    expect(out.text).toContain("## File: 'src/a.ts'");
    expect(out.text).toContain("__new hunk__\n1  const x = 1;\n2 +const y = 3;\n3 +const z = 4;\n4  export { x };");
    expect(out.text).toContain("__old hunk__\n const x = 1;\n-const y = 2;");
    expect(out.text).not.toContain("sql comment");
    expect(out.text).not.toContain("gone");
    expect(out.text).toContain("Deleted files: old.ts");
    expect(out.tokens).toBeGreaterThan(0);
  });

  it("orders by language share then size, and packs to the budget", () => {
    const file = (p: string, lines: number) =>
      `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1,0 +1,${lines} @@\n${Array.from({ length: lines }, (_, i) => `+line ${i} of ${p}`).join("\n")}\n`;
    const diff = file("a.ts", 3) + file("b.ts", 8) + file("c.md", 6);
    expect(compressDiff(diff, 10_000).included).toEqual(["b.ts", "a.ts", "c.md"]);
    const tight = compressDiff(diff, compressDiff(file("b.ts", 8), 10_000).tokens + 3);
    expect(tight.included).toEqual(["b.ts"]);
    expect(tight.omitted).toEqual(["a.ts", "c.md"]);
    expect(tight.text).toContain("not shown (budget): a.ts, c.md");
  });
});

const REVIEW_JSON = {
  summary: "Changes y and adds z.",
  effort: 2,
  findings: [
    { file: "src/a.ts", line: 3, severity: "low", title: "L1", detail: "" },
    { file: "src/a.ts", line: 2, severity: "high", title: "H1", detail: "y is wrong" },
    { file: "src/a.ts", severity: "medium", title: "M1", detail: "" },
    { file: "src/a.ts", severity: "low", title: "L2", detail: "" },
  ],
  security: "None",
  tests: "missing",
};

describe("reviewDiff", () => {
  it("parses fenced JSON with prose, caps findings (severe first) and reports usage", async () => {
    const fake = fakeTurns(`Here you go:\n\`\`\`json\n${JSON.stringify(REVIEW_JSON)}\n\`\`\`\nThanks.`);
    const turns: number[] = [];
    const review = await reviewDiff({ diff: DIFF, task: "fix y", model: "claude-haiku-4-5", runTurn: fake.runTurn, onTurn: (t) => turns.push(t.cost) });
    expect(review.findings.map((f) => f.title)).toEqual(["H1", "M1", "L1"]);
    expect(review.findings[0]).toEqual({ file: "src/a.ts", line: 2, severity: "high", title: "H1", detail: "y is wrong" });
    expect(review).toMatchObject({ effort: 2, security: null, tests: "missing" });
    expect(turns).toEqual([0.001]);
    expect(fake.requests[0].model).toBe("claude-haiku-4-5");
    expect(fake.prompt(0)).toContain("<task>\nfix y\n</task>");
    expect(fake.prompt(0)).toContain("2 +const y = 3;");
  });

  it("repairs invalid output once, then gives up with a clear error", async () => {
    const ok = fakeTurns('{"summary": "x", "effort": 9}', JSON.stringify(REVIEW_JSON));
    await expect(reviewDiff({ diff: DIFF, model: "m", runTurn: ok.runTurn })).resolves.toMatchObject({ summary: "Changes y and adds z." });
    expect(ok.requests).toHaveLength(2);
    expect(JSON.stringify(ok.requests[1].messages.at(-1))).toMatch(/invalid: `effort` must be an integer 1-5/);

    const bad = fakeTurns("not json", "still not json");
    await expect(reviewDiff({ diff: DIFF, model: "m", runTurn: bad.runTurn })).rejects.toBeInstanceOf(ReviewOutputError);
    expect(bad.requests).toHaveLength(2);
  });

  it("refuses a diff with nothing to review, without calling the model", async () => {
    const fake = fakeTurns();
    const onlyDeletes = DIFF.split("diff --git a/docs")[0].replace(/\+const y = 3;\n\+const z = 4;\n/, "");
    await expect(reviewDiff({ diff: onlyDeletes, model: "m", runTurn: fake.runTurn })).rejects.toThrow(/no added or changed code/);
    expect(fake.requests).toHaveLength(0);
  });

  it("includes convention notes near the changed files and repo-wide ones", async () => {
    const root = tmpRoot();
    addEntry(root, { kind: "convention", text: "Use const enums in src.", anchors: ["src/b.ts"] });
    addEntry(root, { kind: "convention", text: "Prefer early returns.", anchors: [] });
    addEntry(root, { kind: "convention", text: "Lib files need docs.", anchors: ["lib/x.ts"] });
    addEntry(root, { kind: "fact", text: "Not a convention.", anchors: ["src/a.ts"] });
    const fake = fakeTurns(JSON.stringify(REVIEW_JSON));
    await reviewDiff({ diff: DIFF, model: "m", runTurn: fake.runTurn, root });
    const prompt = fake.prompt(0);
    expect(prompt).toContain("<conventions>");
    expect(prompt).toContain("Use const enums in src.");
    expect(prompt).toContain("Prefer early returns.");
    expect(prompt).not.toContain("Lib files need docs.");
    expect(prompt).not.toContain("Not a convention.");
  });
});

describe("describeDiff", () => {
  it("returns a validated title, body and type", async () => {
    const fake = fakeTurns(
      '{"title": "Change", "body": "b", "type": "bogus"}',
      '{"title": "Bump y and add z\\n", "body": "Summary.\\n\\n- y is 3", "type": "Feature"}',
    );
    expect(await describeDiff({ diff: DIFF, model: "m", runTurn: fake.runTurn })).toEqual({
      title: "Bump y and add z",
      body: "Summary.\n\n- y is 3",
      type: "feature",
    });
  });
});

describe("improveDiff", () => {
  it("drops ungrounded suggestions before self-reflection and low scores after it", async () => {
    const suggestions = [
      { file: "src/a.ts", startLine: 2, endLine: 3, existing: "const y = 3;\n  const z = 4;", improved: "const [y, z] = [3, 4];", why: "shorter" },
      { file: "src/a.ts", startLine: 5, endLine: 5, existing: "const invented = true;", improved: "x", why: "made up" },
      { file: "docs/readme.md", startLine: 1, endLine: 1, existing: "# Title", improved: "# Better title", why: "clearer" },
      { file: "src/a.ts", startLine: 1, endLine: 1, existing: "const x = 1;", improved: "const x = 1;", why: "no-op" },
    ];
    const fake = fakeTurns(JSON.stringify({ suggestions }), '{"scores": [3, {"score": 9}]}');
    const out = await improveDiff({ diff: DIFF, model: "m", runTurn: fake.runTurn });
    expect(out).toEqual([{ ...suggestions[2], score: 9 }]);
    expect(fake.requests).toHaveLength(2);
    const reflection = fake.prompt(1);
    expect(reflection).toContain("1. src/a.ts:2-3: shorter");
    expect(reflection).not.toContain("made up");
    expect(fake.requests[1].system[0].text).toMatch(/score 0-10/);
  });

  it("makes no reflection call when nothing is grounded, and honours the threshold", async () => {
    const none = fakeTurns('{"suggestions": [{"file": "nope.ts", "startLine": 1, "endLine": 1, "existing": "a", "improved": "b"}]}');
    expect(await improveDiff({ diff: DIFF, model: "m", runTurn: none.runTurn })).toEqual([]);
    expect(none.requests).toHaveLength(1);

    const s = { file: "src/a.ts", startLine: 2, endLine: 2, existing: "const y = 3;", improved: "const y = 4;", why: "w" };
    const low = fakeTurns(JSON.stringify({ suggestions: [s] }), '{"scores": [5]}');
    expect(await improveDiff({ diff: DIFF, model: "m", runTurn: low.runTurn, threshold: 5 })).toHaveLength(1);
  });

  it("grounds whitespace-insensitively and only in new-side code", () => {
    expect(groundedIn(DIFF, "src/a.ts", "  const y = 3;\n\n const z = 4;")).toBe(true);
    expect(groundedIn(DIFF, "src/a.ts", "const y = 2;")).toBe(false);
    expect(groundedIn(DIFF, "src/a.ts", "const x = 1;\nconst z = 4;")).toBe(false);
  });
});

describe("reviewModel", () => {
  it("keeps an explicit model and otherwise picks the cheapest agentic one", async () => {
    expect(await reviewModel("claude-opus-5")).toBe("claude-opus-5");
    installFakeProvider();
    expect(await reviewModel("auto")).toBe("claude-haiku-4-5");
  });
});

describe("learnReviewStyle", () => {
  it("extracts conventions from review comments and stores them as anchored memory", async () => {
    const root = tmpRoot();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return Response.json([
        { body: "Please use the logger, not console.log.", path: "src/server/api.ts", user: { login: "alice" }, created_at: "" },
        { body: "Same here: logger.", path: "src/server/db.ts", user: { login: "bob" }, created_at: "" },
        { body: "Automated nit", path: "x.ts", user: { login: "lint[bot]" }, created_at: "" },
        { body: "  ", path: "y.ts", user: null, created_at: "" },
      ]);
    }) as unknown as typeof fetch;
    const fake = fakeTurns(
      JSON.stringify({
        conventions: [
          { text: "Log through the shared logger, never console.log.", paths: ["src/server", "src/**/*.ts"] },
          { text: "Keep functions small.", paths: [] },
          { text: "" },
        ],
      }),
    );
    const result = await learnReviewStyle({
      root,
      repo: { owner: "o", repo: "r" },
      limit: 20,
      model: "m",
      runTurn: fake.runTurn,
      github: { token: "t", fetchImpl },
    });
    expect(urls[0]).toBe("https://api.github.com/repos/o/r/pulls/comments?sort=created&direction=desc&per_page=20");
    expect(result.comments).toBe(2);
    expect(result.conventions).toEqual([
      { text: "Log through the shared logger, never console.log.", paths: ["src/server"] },
      { text: "Keep functions small.", paths: [] },
    ]);
    expect(fake.prompt(0)).not.toContain("Automated nit");
    const stored = getMemoryGraph(root).entries.filter((e) => e.kind === "convention");
    expect(stored.map((e) => e.id).sort()).toEqual([...result.entryIds].sort());
    expect(stored[0].anchors.map((a) => a.ref)).toEqual(["src/server"]);
    expect(stored[0].evidence).toMatch(/2 review comments on o\/r/);

    // A later review of a file under that directory picks the convention up.
    const review = fakeTurns(JSON.stringify(REVIEW_JSON));
    const diff = DIFF.replaceAll("src/a.ts", "src/server/api.ts");
    await reviewDiff({ diff, model: "m", runTurn: review.runTurn, root });
    expect(review.prompt(0)).toContain("Log through the shared logger");
  });

  it("skips the model call when there are no usable comments", async () => {
    const fake = fakeTurns();
    const fetchImpl = (async () => Response.json([])) as unknown as typeof fetch;
    const result = await learnReviewStyle({ root: tmpRoot(), repo: { owner: "o", repo: "r" }, model: "m", runTurn: fake.runTurn, github: { token: null, fetchImpl } });
    expect(result).toEqual({ comments: 0, conventions: [], entryIds: [] });
    expect(fake.requests).toHaveLength(0);
  });
});
