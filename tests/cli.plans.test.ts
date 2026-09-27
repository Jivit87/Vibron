import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { experimentCommand, parseExperimentArgs, parsePlanArgs, parseVariantSpec, planCommand } from "@/cli/plans";
import { CliError, parseCliArgs, USAGE } from "@/cli/viberon";
import type { RunPlan } from "@/lib/agents/events";
import { discardExperiment, runExperiment } from "@/lib/experiments";
import { diff as snapshotDiff, snapshot } from "@/lib/harness/snapshot";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import { PlanStore } from "@/lib/plans/store";
import { resetMemoryStoreForTests } from "@/lib/store";
import { applyExperimentEvent, variantsFromForm } from "@/lib/client/plans";
import { createRun, reduceRun } from "@/lib/client/run-reducer";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

describe("CLI parsing", () => {
  it("parses plan list/show/diff", () => {
    expect(parseCliArgs(["plan"])).toEqual({ command: "plan", action: "list", repo: ".", json: false });
    expect(parseCliArgs(["plan", "show", "pv_a", "--repo", "/r", "--json"])).toEqual({ command: "plan", action: "show", repo: "/r", id: "pv_a", json: true });
    expect(parsePlanArgs(["diff", "a", "b"])).toMatchObject({ action: "diff", a: "a", b: "b" });
    expect(() => parseCliArgs(["plan", "diff", "a"])).toThrow(CliError);
    expect(() => parseCliArgs(["plan", "show"])).toThrow(/version id/);
    expect(() => parseCliArgs(["plan", "list", "--bogus", "1"])).toThrow(/Unknown option/);
    expect(() => parseCliArgs(["plan", "list", "--repo"])).toThrow(/needs a value/);
    expect(parseCliArgs(["plan", "--help"])).toEqual({ command: "help" });
    expect(USAGE).toContain("viberon experiment run");
  });

  it("parses experiment run with a variants spec", () => {
    const args = parseExperimentArgs(["run", "--repo", "/r", "--task", "fix it", "--variants", "models=a,b;plans=pv_x", "--concurrency", "3", "--json"]);
    expect(args).toMatchObject({
      action: "run",
      repo: "/r",
      task: "fix it",
      concurrency: 3,
      json: true,
      keepWorktrees: false,
      variants: [
        { model: "a", planVersionId: "pv_x" },
        { model: "b", planVersionId: "pv_x" },
      ],
    });
    expect(parseExperimentArgs(["run", "--repo", "/r", "--plan", "pv_y"])).toMatchObject({ plan: "pv_y", variants: [{}] });
    expect(() => parseExperimentArgs(["run", "--task", "t"])).toThrow(/--repo/);
    expect(() => parseExperimentArgs(["run", "--repo", "/r"])).toThrow(/--task or --plan/);
    expect(() => parseExperimentArgs(["run", "--repo", "/r", "--task", "t", "--concurrency", "9"])).toThrow(/at most 4/);
    expect(() => parseVariantSpec("temps=1")).toThrow(/unknown key/);
    expect(() => parseVariantSpec("models=")).toThrow(/no values/);
    expect(parseExperimentArgs(["promote", "ex_1", "b2"])).toMatchObject({ action: "promote", id: "ex_1", branch: "b2" });
    expect(parseExperimentArgs(["discard", "ex_1", "--purge"])).toMatchObject({ action: "discard", purge: true });
    expect(() => parseExperimentArgs(["show", "ex_1", "--purge"])).toThrow(/only applies to discard/);
    expect(() => parseExperimentArgs(["promote", "ex_1"])).toThrow(/branch id/);
    expect(() => parseExperimentArgs(["fly"])).toThrow(/unknown action/);
  });
});

describe("CLI commands", () => {
  let repo: TmpRepo;
  let out: string;
  const io = { out: (t: string) => void (out += t), err: () => {} };
  beforeEach(() => {
    resetMemoryStoreForTests();
    repo = makeTmpRepo({ "a.txt": "one\n" });
    out = "";
  });
  afterEach(() => repo.cleanup());

  it("plan list, show and diff", async () => {
    const store = new PlanStore(repo.root);
    const plan: RunPlan = { summary: "s", steps: [{ id: "x", title: "X", role: "backend", detail: "", files: ["x.ts"], dependsOn: [] }], waves: [["x"]] };
    const { version: a } = await store.create({ plan, prompt: "Make x", model: "m", origin: "planned" });
    const { version: b } = await store.create({ plan: { ...plan, steps: [{ ...plan.steps[0]!, role: "frontend" }] }, prompt: "Make x", model: "m", origin: "edited", parentId: a.id });

    expect(await planCommand({ command: "plan", action: "list", repo: repo.root, json: false }, io)).toBe(0);
    expect(out).toContain(a.id);
    expect(out).toContain("edited");
    out = "";
    await planCommand({ command: "plan", action: "show", repo: repo.root, id: b.id, json: false }, io);
    expect(out).toContain(`from ${a.id}`);
    expect(out).toContain("files: x.ts");
    out = "";
    await planCommand({ command: "plan", action: "diff", repo: repo.root, a: a.id, b: b.id, json: false }, io);
    expect(out).toContain("role backend -> frontend");
    out = "";
    await planCommand({ command: "plan", action: "diff", repo: repo.root, a: a.id, b: b.id, json: true }, io);
    expect(JSON.parse(out).changed[0].fields).toEqual(["role"]);
  });

  it("experiment show, promote, undo and discard", async () => {
    const record = await runExperiment(
      { repo: repo.root, task: "t", variants: [{ model: "m" }], testCmd: "true" },
      {
        solve: async (options: SolveOptions) => {
          const root = options.handle.rootPath!;
          const base = await snapshot(root);
          await writeFile(path.join(root, "a.txt"), "two\n");
          const result = emptySolveResult("resolved");
          result.diff = await snapshotDiff(root, base);
          result.filesChanged = ["a.txt"];
          return result;
        },
      },
    );
    try {
      await experimentCommand({ command: "experiment", action: "show", repo: repo.root, id: record.id, json: false }, io, () => {});
      expect(out).toContain("b1*");
      out = "";
      await experimentCommand({ command: "experiment", action: "list", repo: repo.root, json: true }, io, () => {});
      expect(JSON.parse(out).experiments[0].id).toBe(record.id);
      out = "";
      await experimentCommand({ command: "experiment", action: "promote", repo: repo.root, id: record.id, branch: "b1", json: false }, io, () => {});
      expect(repo.read("a.txt")).toBe("two\n");
      expect(out).toContain("viberon experiment undo");
      await experimentCommand({ command: "experiment", action: "undo", repo: repo.root, id: record.id, json: false }, io, () => {});
      expect(repo.read("a.txt")).toBe("one\n");
      out = "";
      await experimentCommand({ command: "experiment", action: "discard", repo: repo.root, id: record.id, purge: false, json: true }, io, () => {});
      expect(JSON.parse(out).experiment.status).toBe("discarded");
    } finally {
      await discardExperiment({ repo: repo.root, id: record.id }).catch(() => undefined);
    }
  });
});

describe("client helpers", () => {
  it("builds variants as models × prompts", () => {
    expect(variantsFromForm("", "")).toEqual([{}]);
    expect(variantsFromForm("a, b a", "")).toEqual([{ model: "a" }, { model: "b" }]);
    const v = variantsFromForm("a,b", "short\nlong prompt");
    expect(v).toHaveLength(4);
    expect(v[0]).toMatchObject({ model: "a", prompt: "short" });
    expect(variantsFromForm("1 2 3 4 5 6 7 8 9", "")).toHaveLength(8);
  });

  it("folds live experiment events into the record", () => {
    const base = {
      schemaVersion: 1,
      id: "ex_1",
      repo: "/r",
      task: "t",
      source: { kind: "workspace" as const },
      baseTree: "t",
      concurrency: 1,
      createdAt: 1,
      status: "running" as const,
      winner: null,
      branches: [{ id: "b1", label: "a", variant: { model: "a", mode: "solve" as const }, status: "queued" as const, worktree: null, outDir: "" }],
    };
    const started = applyExperimentEvent(base, { type: "branch_start", branchId: "b1", worktree: "/tmp/w" });
    expect(started!.branches[0]).toMatchObject({ status: "running", worktree: "/tmp/w" });
    const done = applyExperimentEvent(started, { type: "branch_done", branch: { ...started!.branches[0]!, status: "done" } });
    expect(done!.branches[0]!.status).toBe("done");
    expect(applyExperimentEvent(done, { type: "experiment_done", experiment: { ...base, status: "done" } })!.status).toBe("done");
    expect(applyExperimentEvent(done, { type: "experiment_error", message: "x" })).toBe(done);
  });

  it("the run reducer keeps the plan's version id", () => {
    const run = createRun({ id: "r", prompt: "p", model: "m", mode: "plan", now: 1 });
    const plan: RunPlan = { summary: "", steps: [], waves: [] };
    const next = reduceRun(run, { type: "plan", plan, awaitingApproval: true, versionId: "pv_abc123_def456" }, { now: 2, nextId: (p) => p });
    expect(next.planVersionId).toBe("pv_abc123_def456");
  });
});
