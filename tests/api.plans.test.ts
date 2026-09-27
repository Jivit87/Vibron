/**
 * The /api/plans and /api/experiments routes against a real registered
 * workspace, with the model layer scripted or the solver injected.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as listPlans } from "@/app/api/plans/route";
import { GET as getPlan } from "@/app/api/plans/[id]/route";
import { GET as diffPlans } from "@/app/api/plans/diff/route";
import { POST as rerunPlan } from "@/app/api/plans/[id]/rerun/route";
import { GET as listExperiments, POST as createExperimentRoute } from "@/app/api/experiments/route";
import { GET as getExperimentRoute } from "@/app/api/experiments/[id]/route";
import { GET as compareRoute } from "@/app/api/experiments/[id]/compare/route";
import { GET as eventsRoute } from "@/app/api/experiments/[id]/events/route";
import { POST as promoteRoute } from "@/app/api/experiments/[id]/promote/route";
import { POST as discardRoute } from "@/app/api/experiments/[id]/discard/route";
import type { RunPlan } from "@/lib/agents/events";
import { discardExperiment, runExperiment, type ExperimentEvent } from "@/lib/experiments";
import { startExperiment, subscribeExperiment } from "@/lib/experiments/live";
import { diff as snapshotDiff, snapshot } from "@/lib/harness/snapshot";
import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { PlanStore } from "@/lib/plans/store";
import { resetMemoryStoreForTests } from "@/lib/store";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const PLAN: RunPlan = {
  summary: "One step.",
  steps: [{ id: "only", title: "Only", role: "backend", detail: "Write x", files: ["x.ts"], dependsOn: [] }],
  waves: [["only"]],
};

let repo: TmpRepo;
let repoKey: string;
let store: PlanStore;
const experiments: string[] = [];

beforeEach(async () => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({ "app.ts": "export const a = 1;\n" });
  repoKey = (await registerLocalWorkspace(repo.root)).repoKey;
  store = new PlanStore(repo.root);
});
afterEach(async () => {
  uninstallFakeProvider();
  for (const id of experiments.splice(0)) await discardExperiment({ repo: repo.root, id }).catch(() => undefined);
  repo.cleanup();
});

const url = (p: string) => `http://localhost${p}`;
const params = (id: string) => ({ params: Promise.resolve({ id }) });
// Route bodies are untyped JSON; the assertions spell out the shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, Json> });
const postJson = (p: string, body: unknown) =>
  new Request(url(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function solver(content: string) {
  return async (options: SolveOptions): Promise<SolveResult> => {
    const root = options.handle.rootPath!;
    const base = await snapshot(root);
    await writeFile(path.join(root, "app.ts"), content);
    const result = emptySolveResult("resolved");
    result.diff = await snapshotDiff(root, base);
    result.filesChanged = ["app.ts"];
    result.gate = { ...result.gate, fixed: ["t"], reason: "ok" };
    return result;
  };
}

async function readSse(res: Response): Promise<Json[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((f) => f.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join(""))
    .filter(Boolean)
    .map((p) => JSON.parse(p));
}

describe("/api/plans", () => {
  it("lists, gets and diffs versions", async () => {
    const { version: a } = await store.create({ plan: PLAN, prompt: "Make x", model: "m", origin: "planned" });
    const { version: b } = await store.create({
      plan: { ...PLAN, steps: [...PLAN.steps, { id: "two", title: "Two", role: "docs", detail: "", files: ["README.md"], dependsOn: ["only"] }] },
      prompt: "Make x",
      model: "m",
      origin: "edited",
      parentId: a.id,
    });

    const list = await json(await listPlans(new Request(url(`/api/plans?repoKey=${repoKey}`))));
    expect(list.status).toBe(200);
    expect(list.body.versions.map((v: { id: string }) => v.id)).toEqual([b.id, a.id]);

    const one = await json(await getPlan(new Request(url(`/api/plans/${b.id}?repoKey=${repoKey}`)), params(b.id)));
    expect(one.body.version.id).toBe(b.id);
    expect(one.body.lineage.map((l: { id: string }) => l.id)).toEqual([b.id, a.id]);
    expect(one.body.outcomes).toEqual([]);

    const diff = await json(await diffPlans(new Request(url(`/api/plans/diff?repoKey=${repoKey}&a=${a.id}&b=${b.id}`))));
    expect(diff.body.diff.added.map((s: { id: string }) => s.id)).toEqual(["two"]);
    expect(diff.body.diff.ownership).toEqual([{ file: "README.md", before: null, after: "two" }]);
  });

  it("answers bad input with 4xx", async () => {
    expect((await listPlans(new Request(url("/api/plans")))).status).toBe(400);
    expect((await getPlan(new Request(url(`/api/plans/x?repoKey=${repoKey}`)), params("../x"))).status).toBe(400);
    expect((await getPlan(new Request(url(`/api/plans/x?repoKey=${repoKey}`)), params("pv_zzzzzz_zzzzzz"))).status).toBe(404);
    expect((await diffPlans(new Request(url(`/api/plans/diff?repoKey=${repoKey}&a=1&b=2`)))).status).toBe(400);
    expect((await rerunPlan(postJson("/api/plans/x/rerun", { repoKey }), params("pv_zzzzzz_zzzzzz"))).status).toBe(404);
  });

  it("re-runs a version over SSE and records the run on it", async () => {
    const { version } = await store.create({ plan: PLAN, prompt: "Make x", model: "claude-opus-5", origin: "planned" });
    installFakeProvider([{ text: "Done." }]);
    const res = await rerunPlan(postJson(`/api/plans/${version.id}/rerun`, { repoKey, commandPolicy: "never" }), params(version.id));
    expect(res.headers.get("X-Run-Id")).toBeTruthy();
    const events = await readSse(res);
    expect(events.find((e) => e.type === "checkpoint")).toBeTruthy();
    expect(events.find((e) => e.type === "plan")).toMatchObject({ versionId: version.id, awaitingApproval: false });
    expect(events.at(-1)).toMatchObject({ type: "run_done", status: "done" });
    const outcomes = await store.outcomes(version.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.runId).toBe(res.headers.get("X-Run-Id"));
  });
});

describe("/api/experiments", () => {
  it("validates the create body", async () => {
    const bad = async (body: unknown) => (await createExperimentRoute(postJson("/api/experiments", body))).status;
    expect(await bad({ task: "t", variants: [{}] })).toBe(400);
    expect(await bad({ repoKey, task: "t", variants: [] })).toBe(400);
    expect(await bad({ repoKey, task: "t", variants: [{ planVersionId: "../x" }] })).toBe(400);
    expect(await bad({ repoKey, task: "t", source: { kind: "space" }, variants: [{}] })).toBe(400);
    expect(await bad({ repoKey, task: "t", source: { kind: "plan", versionId: "pv_zzzzzz_zzzzzz" }, variants: [{}] })).toBe(404);
  });

  it("shows status and comparison, streams a finished experiment, promotes, undoes and discards", async () => {
    const record = await runExperiment(
      { repo: repo.root, task: "change a", variants: [{ model: "a" }, { model: "b" }], testCmd: "true" },
      { solve: solver("export const a = 2;\n") },
    );
    experiments.push(record.id);

    const list = await json(await listExperiments(new Request(url(`/api/experiments?repoKey=${repoKey}`))));
    expect(list.body.experiments.map((e: { id: string }) => e.id)).toEqual([record.id]);

    const status = await json(await getExperimentRoute(new Request(url(`/api/experiments/${record.id}?repoKey=${repoKey}`)), params(record.id)));
    expect(status.body).toMatchObject({ active: false, experiment: { status: "done" } });
    expect(status.body.comparison.rows).toHaveLength(2);

    const cmp = await json(await compareRoute(new Request(url(`/api/experiments/${record.id}/compare?repoKey=${repoKey}&patches=1`)), params(record.id)));
    expect(cmp.body.patches.b1).toContain("+export const a = 2;");

    const events = await readSse(await eventsRoute(new Request(url(`/api/experiments/${record.id}/events?repoKey=${repoKey}`)), params(record.id)));
    expect(events).toEqual([expect.objectContaining({ type: "experiment_done" })]);

    const promoted = await json(await promoteRoute(postJson(`/api/experiments/${record.id}/promote`, { repoKey, branchId: record.winner }), params(record.id)));
    expect(promoted.status).toBe(200);
    expect(promoted.body.experiment.promotion.checkpointId).toMatch(/^cp_/);
    expect(repo.read("app.ts")).toBe("export const a = 2;\n");
    const again = await promoteRoute(postJson(`/api/experiments/${record.id}/promote`, { repoKey, branchId: "b2" }), params(record.id));
    expect(again.status).toBe(409);

    await promoteRoute(postJson(`/api/experiments/${record.id}/promote`, { repoKey, undo: true }), params(record.id));
    expect(repo.read("app.ts")).toBe("export const a = 1;\n");

    const discarded = await json(await discardRoute(postJson(`/api/experiments/${record.id}/discard`, { repoKey }), params(record.id)));
    expect(discarded.body.experiment.status).toBe("discarded");
    expect(discarded.body.experiment.branches.every((b: { worktree: unknown }) => b.worktree === null)).toBe(true);
  });

  it("follows a live experiment: replay for late subscribers, then the tail", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = solver("export const a = 3;\n");
    const record = await startExperiment(
      { repo: repo.root, task: "t", variants: [{ model: "a" }], testCmd: "true" },
      {
        solve: async (options) => {
          await gate;
          return inner(options);
        },
      },
    );
    experiments.push(record.id);
    const seen: ExperimentEvent[] = [];
    const ended = new Promise<void>((resolve) => subscribeExperiment(record.id, (e) => seen.push(e), resolve));
    // Give the branch time to start before releasing it.
    await new Promise((r) => setTimeout(r, 200));
    const live = await json(await getExperimentRoute(new Request(url(`/api/experiments/${record.id}?repoKey=${repoKey}`)), params(record.id)));
    expect(live.body.active).toBe(true);
    release();
    await ended;
    expect(seen[0]!.type).toBe("experiment_start");
    expect(seen.at(-1)!.type).toBe("experiment_done");

    const late: ExperimentEvent[] = [];
    await new Promise<void>((resolve) => subscribeExperiment(record.id, (e) => late.push(e), resolve));
    expect(late.map((e) => e.type)).toEqual(seen.map((e) => e.type));
  });
});
