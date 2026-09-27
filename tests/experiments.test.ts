/**
 * Experiment branching end to end on real git repositories, with the model
 * layer mocked: a scripted solver per branch, or the real orchestrator
 * against the scripted provider for plan branches.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compareExperiment,
  createExperiment,
  discardExperiment,
  ExperimentError,
  listExperiments,
  listWorktrees,
  loadExperiment,
  promoteBranch,
  rankBranches,
  renderComparison,
  runExperiment,
  runPreparedExperiment,
  undoPromotion,
  type ExperimentBranch,
  type ExperimentEvent,
  type ExperimentRecord,
} from "@/lib/experiments";
import { diff as snapshotDiff, snapshot } from "@/lib/harness/snapshot";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import { PlanStore } from "@/lib/plans/store";
import { resetMemoryStoreForTests } from "@/lib/store";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

let repo: TmpRepo;
const records: ExperimentRecord[] = [];

beforeEach(() => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({
    "calc.js": "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n",
    "README.md": "# calc\n",
  });
});

afterEach(async () => {
  uninstallFakeProvider();
  for (const record of records.splice(0)) {
    await discardExperiment({ repo: record.repo, id: record.id }).catch(() => undefined);
  }
  repo.cleanup();
});

interface Behaviour {
  files?: Record<string, string>;
  status?: SolveResult["status"];
  fixed?: string[];
  regressed?: string[];
  tokens?: number;
  costUsd?: number;
  delayMs?: number;
}

/** A solveTask stand-in: edits the branch's work tree and reports the evidence it was told to. */
function scriptedSolver(byModel: Record<string, Behaviour>) {
  const seen: { model: string; root: string; task: string }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const solve = async (options: SolveOptions): Promise<SolveResult> => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      const root = options.handle.rootPath!;
      seen.push({ model: options.model, root, task: options.task });
      const behaviour = byModel[options.model] ?? {};
      const base = await snapshot(root);
      if (behaviour.delayMs) await new Promise((r) => setTimeout(r, behaviour.delayMs));
      for (const [file, content] of Object.entries(behaviour.files ?? {})) await writeFile(path.join(root, file), content);
      const result = emptySolveResult(behaviour.status ?? "resolved");
      result.diff = await snapshotDiff(root, base);
      result.filesChanged = Object.keys(behaviour.files ?? {});
      result.summary = `ran ${options.model}`;
      result.gate = { ...result.gate, enabled: true, fixed: behaviour.fixed ?? [], newFailures: behaviour.regressed ?? [], reason: "scripted" };
      result.metrics = { ...result.metrics, inputTokens: behaviour.tokens ?? 1000, outputTokens: 100, costUsd: behaviour.costUsd ?? 0.01, durationMs: 50 };
      return result;
    } finally {
      inFlight -= 1;
    }
  };
  return { solve, seen, max: () => maxInFlight };
}

const FIXED = "function add(a, b) {\n  return a + b;\n}\nmodule.exports = { add };\n";

async function run(input: Parameters<typeof runExperiment>[0], deps: Parameters<typeof runExperiment>[1]) {
  const record = await runExperiment({ testCmd: "true", ...input }, deps);
  records.push(record);
  return record;
}

describe("experiments", () => {
  it("runs each branch in its own worktree, leaves the main tree alone, and ranks by evidence", async () => {
    // Uncommitted work in the main tree is part of the fork point.
    repo.write("notes.txt", "draft\n");
    const solver = scriptedSolver({
      good: { files: { "calc.js": FIXED }, fixed: ["adds"], costUsd: 0.02 },
      noisy: { files: { "calc.js": FIXED, "extra.js": "// lots\n".repeat(30) }, fixed: ["adds"], costUsd: 0.01 },
      broken: { files: { "calc.js": "throw new Error('x');\n" }, status: "incomplete", regressed: ["zero"] },
    });
    const events: ExperimentEvent[] = [];
    const record = await run(
      {
        repo: repo.root,
        task: "add() subtracts",
        variants: [{ model: "broken" }, { model: "good" }, { model: "noisy" }],
        onEvent: (e) => events.push(e),
      },
      { solve: solver.solve },
    );

    expect(record.status).toBe("done");
    expect(record.branches.map((b) => b.status)).toEqual(["done", "done", "done"]);
    // Main tree untouched: same content, and git sees only the uncommitted note.
    expect(repo.read("calc.js")).toContain("a - b");
    expect(repo.git("status", "--porcelain").trim()).toBe("?? notes.txt");

    const roots = solver.seen.map((s) => s.root);
    expect(new Set(roots).size).toBe(3);
    for (const branch of record.branches) {
      expect(branch.worktree).toBeTruthy();
      expect(branch.worktree).not.toBe(repo.root);
      expect(roots).toContain(branch.worktree);
      expect(readFileSync(path.join(branch.worktree!, "notes.txt"), "utf8")).toBe("draft\n");
      expect(existsSync(path.join(branch.outDir, "result.json"))).toBe(true);
      expect(readFileSync(path.join(branch.outDir, "patch.diff"), "utf8")).not.toContain("notes.txt");
    }
    const good = record.branches.find((b) => b.variant.model === "good")!;
    expect(readFileSync(path.join(good.worktree!, "calc.js"), "utf8")).toBe(FIXED);

    // good and noisy both prove the fix; the smaller diff wins. broken regressed.
    expect(record.winner).toBe(good.id);
    const cmp = compareExperiment(record);
    expect(cmp.rows.map((r) => r.model)).toEqual(["good", "noisy", "broken"]);
    expect(cmp.rows[0]).toMatchObject({ rank: 1, verdict: "resolved", fixed: 1, regressed: 0, files: 1, adds: 1, removes: 1 });
    expect(cmp.rows[2]).toMatchObject({ verdict: "incomplete", regressed: 1 });
    const table = renderComparison(cmp);
    expect(table).toContain(`${good.id}*`);
    expect(table).toContain("winner");

    expect(events[0]!.type).toBe("experiment_start");
    expect(events.at(-1)!.type).toBe("experiment_done");
    expect(events.filter((e) => e.type === "branch_done")).toHaveLength(3);
    expect(events.some((e) => e.type === "branch_start" && e.worktree)).toBe(true);

    // The record round-trips from disk.
    const loaded = await loadExperiment(repo.root, record.id);
    expect(loaded.winner).toBe(good.id);
    expect((await listExperiments(repo.root)).map((e) => e.id)).toEqual([record.id]);
  });

  it("never runs more branches at once than the concurrency bound", async () => {
    const models = ["m1", "m2", "m3", "m4", "m5"];
    const solver = scriptedSolver(Object.fromEntries(models.map((m) => [m, { delayMs: 60, files: { [`${m}.txt`]: m } }])));
    const record = await run({ repo: repo.root, task: "t", variants: models.map((model) => ({ model })), concurrency: 2 }, { solve: solver.solve });
    expect(solver.max()).toBe(2);
    expect(record.concurrency).toBe(2);
    expect(record.branches.every((b) => b.status === "done")).toBe(true);

    const clamped = await createExperiment({ repo: repo.root, task: "t", variants: [{ model: "a" }], concurrency: 99 });
    expect(clamped.record.concurrency).toBe(4);
    records.push((await runPreparedExperiment(clamped)));
  });

  it("promotes the winner behind a snapshot and undoes it exactly", async () => {
    const solver = scriptedSolver({ good: { files: { "calc.js": FIXED, "new.js": "module.exports = 1;\n" }, fixed: ["adds"] } });
    const record = await run({ repo: repo.root, task: "fix", variants: [{ model: "good" }] }, { solve: solver.solve });
    const branchId = record.winner!;

    let checkpoints = 0;
    const promoted = await promoteBranch({
      repo: repo.root,
      id: record.id,
      branchId,
      checkpoint: async () => {
        checkpoints += 1;
        return "cp_test";
      },
    });
    expect(checkpoints).toBe(1);
    expect(promoted.promotion).toMatchObject({ branchId, checkpointId: "cp_test" });
    expect(repo.read("calc.js")).toBe(FIXED);
    expect(repo.read("new.js")).toBe("module.exports = 1;\n");
    // Only the work tree changed: nothing was staged or committed.
    expect(repo.git("diff", "--cached", "--name-only").trim()).toBe("");
    expect(repo.git("rev-list", "--count", "HEAD").trim()).toBe("1");
    expect(compareExperiment(promoted).rows[0]!.promoted).toBe(true);

    await expect(promoteBranch({ repo: repo.root, id: record.id, branchId })).rejects.toMatchObject({ code: "state" });

    const undone = await undoPromotion({ repo: repo.root, id: record.id });
    expect(undone.promotion!.undoneAt).toBeTruthy();
    expect(repo.read("calc.js")).toContain("a - b");
    expect(existsSync(path.join(repo.root, "new.js"))).toBe(false);
    await expect(undoPromotion({ repo: repo.root, id: record.id })).rejects.toMatchObject({ code: "state" });
  });

  it("undo after later edits reverses only the branch's patch", async () => {
    const solver = scriptedSolver({ good: { files: { "calc.js": FIXED }, fixed: ["adds"] } });
    const record = await run({ repo: repo.root, task: "fix", variants: [{ model: "good" }] }, { solve: solver.solve });
    await promoteBranch({ repo: repo.root, id: record.id, branchId: record.winner! });
    repo.write("README.md", "# calc\n\nEdited after promotion.\n");
    await undoPromotion({ repo: repo.root, id: record.id });
    expect(repo.read("calc.js")).toContain("a - b");
    expect(repo.read("README.md")).toContain("Edited after promotion.");
  });

  it("refuses to promote a patch that no longer applies", async () => {
    const solver = scriptedSolver({ good: { files: { "calc.js": FIXED }, fixed: ["adds"] } });
    const record = await run({ repo: repo.root, task: "fix", variants: [{ model: "good" }] }, { solve: solver.solve });
    repo.write("calc.js", "// rewritten meanwhile\n");
    const error = await promoteBranch({ repo: repo.root, id: record.id, branchId: record.winner! }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExperimentError);
    expect((error as ExperimentError).code).toBe("conflict");
    expect(repo.read("calc.js")).toBe("// rewritten meanwhile\n");
    expect((await loadExperiment(repo.root, record.id)).promotion).toBeUndefined();
  });

  it("discard removes every worktree; purge removes the record", async () => {
    const solver = scriptedSolver({ a: { files: { "a.txt": "a" } }, b: { files: { "b.txt": "b" } } });
    const record = await run({ repo: repo.root, task: "t", variants: [{ model: "a" }, { model: "b" }] }, { solve: solver.solve });
    const trees = record.branches.map((b) => b.worktree!);
    for (const tree of trees) expect(existsSync(tree)).toBe(true);
    expect(listWorktrees(repo.root)).toHaveLength(3);

    const discarded = await discardExperiment({ repo: repo.root, id: record.id });
    expect(discarded.status).toBe("discarded");
    expect(discarded.branches.every((b) => b.worktree === null)).toBe(true);
    for (const tree of trees) expect(existsSync(tree)).toBe(false);
    expect(listWorktrees(repo.root)).toHaveLength(1);
    // Evidence stays until purged.
    expect(existsSync(path.join(record.branches[0]!.outDir, "result.json"))).toBe(true);

    await discardExperiment({ repo: repo.root, id: record.id, purge: true });
    await expect(loadExperiment(repo.root, record.id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("discarding a running experiment cancels its branches and cleans up", async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    const solve = async (options: SolveOptions): Promise<SolveResult> => {
      started();
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return emptySolveResult("incomplete");
    };
    const prepared = await createExperiment({ repo: repo.root, task: "t", variants: [{ model: "a" }, { model: "b" }], concurrency: 1, testCmd: "true" }, { solve });
    const finished = runPreparedExperiment(prepared);
    await running;
    const discarded = await discardExperiment({ repo: repo.root, id: prepared.record.id });
    const record = await finished;
    expect(record.status).toBe("cancelled");
    expect(record.branches.map((b) => b.status)).toEqual(["cancelled", "cancelled"]);
    expect(discarded.status).toBe("discarded");
    expect(listWorktrees(repo.root)).toHaveLength(1);
    expect(repo.git("status", "--porcelain").trim()).toBe("");
  });

  it("keepWorktrees: false removes each worktree as its branch finishes", async () => {
    const solver = scriptedSolver({ a: { files: { "a.txt": "a" } } });
    const record = await run({ repo: repo.root, task: "t", variants: [{ model: "a" }], keepWorktrees: false }, { solve: solver.solve });
    expect(record.branches[0]!.worktree).toBeNull();
    expect(listWorktrees(repo.root)).toHaveLength(1);
    // The patch is still promotable from the bundle.
    await promoteBranch({ repo: repo.root, id: record.id, branchId: "b1" });
    expect(repo.read("a.txt")).toBe("a");
  });

  it("forks from a git ref and from a store checkpoint", async () => {
    repo.write("calc.js", "// second version\n");
    repo.git("commit", "-qam", "second");
    const solver = scriptedSolver({ m: {} });
    const fromRef = await run({ repo: repo.root, task: "t", source: { kind: "ref", ref: "HEAD~1" }, variants: [{ model: "m" }] }, { solve: solver.solve });
    expect(readFileSync(path.join(fromRef.branches[0]!.worktree!, "calc.js"), "utf8")).toContain("a - b");

    const { registerLocalWorkspace } = await import("@/lib/local-disk-workspace");
    const { openWorkspace } = await import("@/lib/workspace");
    const { createCheckpoint } = await import("@/lib/checkpoints");
    const handle = await openWorkspace((await registerLocalWorkspace(repo.root)).repoKey);
    repo.write("later.js", "// created before the checkpoint\n");
    const checkpoint = (await createCheckpoint(handle, "cp"))!;
    repo.write("calc.js", "// third version\n");
    repo.write("after.js", "// created after the checkpoint\n");
    const fromCheckpoint = await run(
      { repo: repo.root, task: "t", source: { kind: "checkpoint", checkpointId: checkpoint.id }, variants: [{ model: "m" }] },
      { solve: solver.solve },
    );
    const tree = fromCheckpoint.branches[0]!.worktree!;
    expect(readFileSync(path.join(tree, "calc.js"), "utf8")).toBe("// second version\n");
    expect(existsSync(path.join(tree, "later.js"))).toBe(true);
    expect(existsSync(path.join(tree, "after.js"))).toBe(false);

    await expect(createExperiment({ repo: repo.root, task: "t", source: { kind: "ref", ref: "--upload-pack=x" }, variants: [{}] })).rejects.toMatchObject({ code: "invalid" });
    await expect(createExperiment({ repo: repo.root, task: "t", source: { kind: "checkpoint", checkpointId: "cp_nope" }, variants: [{}] })).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates its input", async () => {
    await expect(createExperiment({ repo: repo.root, task: "t", variants: [] })).rejects.toMatchObject({ code: "invalid" });
    await expect(createExperiment({ repo: repo.root, variants: [{ model: "a" }] })).rejects.toMatchObject({ code: "invalid" });
    await expect(createExperiment({ repo: repo.root, task: "t", variants: Array.from({ length: 9 }, () => ({})) })).rejects.toMatchObject({ code: "invalid" });
    const plain = makeTmpRepo({ "x.txt": "x" }, { git: false });
    try {
      await expect(createExperiment({ repo: plain.root, task: "t", variants: [{}] })).rejects.toMatchObject({ code: "not_git" });
    } finally {
      plain.cleanup();
    }
    await expect(loadExperiment(repo.root, "../../etc")).rejects.toMatchObject({ code: "invalid" });
  });

  it("runs plan branches through the orchestrator, gates them, and versions each plan variant", async () => {
    const store = new PlanStore(repo.root);
    const { version: source } = await store.create({
      plan: {
        summary: "Fix add.",
        steps: [{ id: "fix", title: "Fix add", role: "backend", detail: "Make add add.", files: ["calc.js"], dependsOn: [] }],
        waves: [["fix"]],
      },
      prompt: "add() subtracts",
      model: "claude-opus-5",
      origin: "planned",
    });
    const edited = {
      summary: "Fix add and document it.",
      steps: [{ id: "fix", title: "Fix add", role: "generalist" as const, detail: "Make add add, carefully.", files: ["calc.js"], dependsOn: [] }],
      waves: [["fix"]],
    };
    // One scripted specialist per branch (branches run one at a time here).
    installFakeProvider([
      { calls: [{ name: "write_file", input: { path: "calc.js", content: FIXED, summary: "fix" } }] },
      { text: "Fixed add." },
      { calls: [{ name: "write_file", input: { path: "calc.js", content: FIXED.replace("a + b", "b + a"), summary: "fix" } }] },
      { text: "Fixed add, commutatively." },
    ]);
    const record = await run(
      {
        repo: repo.root,
        source: { kind: "plan", versionId: source.id },
        variants: [{ model: "claude-opus-5" }, { model: "claude-opus-5", plan: edited, label: "edited" }],
        concurrency: 1,
        testCmd: `node -e "process.exit(require('./calc').add(2, 3) === 5 ? 0 : 1)"`,
      },
      {},
    );
    expect(record.task).toBe("add() subtracts");
    const [plain, variant] = record.branches;
    expect(plain!.variant).toMatchObject({ mode: "plan", planVersionId: source.id });
    expect(variant!.variant.mode).toBe("plan");
    expect(variant!.variant.planVersionId).not.toBe(source.id);
    expect(variant!.label).toBe("edited");
    for (const branch of record.branches) {
      expect(branch.evidence).toMatchObject({ status: "resolved", filesChanged: ["calc.js"] });
    }
    expect(repo.read("calc.js")).toContain("a - b");

    const child = await store.get(variant!.variant.planVersionId!);
    expect(child).toMatchObject({ origin: "experiment", parentId: source.id });
    const outcomes = await store.outcomes(source.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.experiment).toEqual({ id: record.id, branchId: "b1" });
    expect((await store.outcomes(child.id))[0]!.experiment).toEqual({ id: record.id, branchId: "b2" });
  });
});

describe("rankBranches", () => {
  const branch = (id: string, evidence: Partial<NonNullable<ExperimentBranch["evidence"]>>): ExperimentBranch => ({
    id,
    label: id,
    variant: { model: id, mode: "solve" },
    status: "done",
    worktree: null,
    outDir: "",
    evidence: {
      status: "resolved",
      summary: "",
      gateReason: "",
      fixed: [],
      regressed: [],
      filesChanged: ["x"],
      diff: { files: 1, adds: 1, removes: 1 },
      tokens: 100,
      inputTokens: 90,
      outputTokens: 10,
      costUsd: 0.01,
      durationMs: 1000,
      modelCalls: 1,
      ...evidence,
    },
  });

  it("orders by verdict, then regressions, fixed, diff size, cost, tokens and time", () => {
    const branches = [
      branch("unverified", { status: "unverified" }),
      branch("slow", { durationMs: 9000 }),
      branch("fast", { durationMs: 10 }),
      branch("big", { diff: { files: 3, adds: 40, removes: 2 } }),
      branch("pricey", { costUsd: 1 }),
      branch("fixes-more", { fixed: ["a", "b"] }),
      branch("error", { status: "error", filesChanged: [] }),
    ];
    const winner = rankBranches(branches);
    const order = [...branches].sort((a, b) => a.score!.rank - b.score!.rank).map((b) => b.id);
    expect(order).toEqual(["fixes-more", "fast", "slow", "pricey", "big", "unverified", "error"]);
    expect(winner).toBe("fixes-more");
    expect(branches.find((b) => b.id === "fixes-more")!.score!.value).toBeGreaterThan(branches.find((b) => b.id === "unverified")!.score!.value);
  });

  it("names no winner when the best branch regressed or changed nothing", () => {
    expect(rankBranches([branch("r", { regressed: ["t"] })])).toBeNull();
    expect(rankBranches([branch("n", { status: "failed", filesChanged: [] })])).toBeNull();
    expect(rankBranches([])).toBeNull();
  });

  it("scores unfinished branches not at all", () => {
    const pending: ExperimentBranch = { ...branch("p", {}), status: "error", evidence: undefined };
    const done = branch("d", {});
    expect(rankBranches([pending, done])).toBe("d");
    expect(pending.score).toBeUndefined();
  });
});
