import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { RunPlan } from "@/lib/agents/events";
import { diffPlans, renderPlanDiff } from "@/lib/plans/diff";
import { hashPlan, isPlanVersionId, PlanStore, PlanStoreError } from "@/lib/plans/store";

const PLAN: RunPlan = {
  summary: "Two steps.",
  steps: [
    { id: "api", title: "API", role: "backend", detail: "Build it", files: ["src/api.ts"], dependsOn: [] },
    { id: "ui", title: "UI", role: "frontend", detail: "Show it", files: ["src/ui.tsx"], dependsOn: ["api"] },
  ],
  waves: [["api"], ["ui"]],
};

let root: string;
let store: PlanStore;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "viberon-plans-"));
  store = new PlanStore(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("PlanStore", () => {
  it("persists a version with id, parent, prompt, steps, model and timestamp", async () => {
    const { version, created } = await store.create({ plan: PLAN, prompt: "Add a feature", model: "m1", origin: "planned", runId: "r1" });
    expect(created).toBe(true);
    expect(isPlanVersionId(version.id)).toBe(true);
    const file = path.join(root, ".viberon", "plans", "versions", `${version.id}.json`);
    expect(existsSync(file)).toBe(true);

    // A fresh store (another process) reads the same thing back.
    const again = await new PlanStore(root).get(version.id);
    expect(again).toMatchObject({ parentId: null, origin: "planned", prompt: "Add a feature", model: "m1", runId: "r1" });
    expect(again.plan.steps.map((s) => [s.id, s.role, s.files])).toEqual([
      ["api", "backend", ["src/api.ts"]],
      ["ui", "frontend", ["src/ui.tsx"]],
    ]);
    expect(again.createdAt).toBeGreaterThan(0);
    expect(again.hash).toBe(hashPlan(PLAN, "Add a feature"));
  });

  it("is immutable: read-only files, no overwrite, and tampering is detected", async () => {
    const { version } = await store.create({ plan: PLAN, prompt: "p", model: "m", origin: "planned" });
    const file = path.join(root, ".viberon", "plans", "versions", `${version.id}.json`);
    expect(statSync(file).mode & 0o222).toBe(0);
    await expect(store.commit(version)).rejects.toMatchObject({ code: "exists" });

    // Mutating the caller's object does not reach the stored version.
    version.plan.steps[0]!.title = "changed";
    expect((await store.get(version.id)).plan.steps[0]!.title).toBe("API");

    // Hand-editing the file breaks its hash.
    chmodSync(file, 0o644);
    writeFileSync(file, readFileSync(file, "utf8").replace('"Build it"', '"Something else"'));
    await expect(store.get(version.id)).rejects.toMatchObject({ code: "modified" });
    const [summary] = await store.list();
    expect(summary!.intact).toBe(false);
  });

  it("refuses a hand-built record whose hash does not match", async () => {
    const version = PlanStore.prepare({ plan: PLAN, prompt: "p", model: "m", origin: "planned" });
    await expect(store.commit({ ...version, prompt: "other" })).rejects.toBeInstanceOf(PlanStoreError);
  });

  it("dedupes an unchanged plan against its parent and links edits to it", async () => {
    const { version: v1 } = await store.create({ plan: PLAN, prompt: "p", model: "m", origin: "planned" });
    const same = await store.create({ plan: PLAN, prompt: "p", model: "other-model", origin: "edited", parentId: v1.id, dedupe: true });
    expect(same).toMatchObject({ created: false, version: { id: v1.id } });

    const edited: RunPlan = { ...PLAN, steps: [PLAN.steps[0]!] };
    const { version: v2 } = await store.create({ plan: edited, prompt: "p", model: "m", origin: "edited", parentId: v1.id, dedupe: true });
    expect(v2.parentId).toBe(v1.id);
    expect((await store.lineage(v2.id)).map((v) => v.id)).toEqual([v2.id, v1.id]);
    expect((await store.children(v1.id)).map((v) => v.id)).toEqual([v2.id]);
  });

  it("lists newest first with run counts and the last outcome", async () => {
    const { version: a } = await store.create({ plan: PLAN, prompt: "a", model: "m", origin: "planned" });
    await new Promise((r) => setTimeout(r, 5));
    const { version: b } = await store.create({ plan: PLAN, prompt: "b", model: "m", origin: "planned" });
    const outcome = {
      versionId: a.id,
      runId: "r",
      status: "done" as const,
      model: "m",
      startedAt: 1,
      finishedAt: 2,
      durationMs: 1,
      filesChanged: 2,
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 5,
      steps: [{ id: "api", outcome: "done" as const }],
      replans: 0,
    };
    await store.recordOutcome(outcome);
    await store.recordOutcome({ ...outcome, runId: "r2", status: "failed" });
    const list = await store.list();
    expect(list.map((v) => v.id)).toEqual([b.id, a.id]);
    expect(list[1]).toMatchObject({ runs: 2, steps: 2, waves: 2, files: 2, lastOutcome: { runId: "r2", status: "failed" }, intact: true });
    expect((await store.outcomes(a.id)).map((o) => o.runId)).toEqual(["r", "r2"]);
    // The version itself did not change.
    expect((await store.get(a.id)).hash).toBe(a.hash);
  });

  it("rejects ids that could escape the store and outcomes for unknown versions", async () => {
    await expect(store.get("../../etc/passwd")).rejects.toMatchObject({ code: "invalid_id" });
    await expect(store.get("pv_zzzzzz_zzzzzz")).rejects.toMatchObject({ code: "not_found" });
    await expect(
      store.recordOutcome({ versionId: "pv_zzzzzz_zzzzzz" } as never),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await store.list()).toEqual([]);
  });

  it("skips a torn last line in the run log", async () => {
    const { version } = await store.create({ plan: PLAN, prompt: "p", model: "m", origin: "planned" });
    await store.recordOutcome({ versionId: version.id, runId: "ok" } as never);
    writeFileSync(path.join(root, ".viberon", "plans", "runs", `${version.id}.jsonl`), '{"runId":"ok"}\n{"runId":', { flag: "w" });
    expect((await store.outcomes(version.id)).map((o) => o.runId)).toEqual(["ok"]);
  });
});

describe("diffPlans", () => {
  const step = (id: string, over: Partial<RunPlan["steps"][number]> = {}) => ({
    id,
    title: id.toUpperCase(),
    role: "backend" as const,
    detail: "",
    files: [`src/${id}.ts`],
    dependsOn: [] as string[],
    ...over,
  });

  it("finds added, removed and changed steps with field-level detail", () => {
    const a: RunPlan = { summary: "s", steps: [step("a"), step("b"), step("c")], waves: [["a", "b", "c"]] };
    const b: RunPlan = {
      summary: "s2",
      steps: [step("a", { role: "frontend", files: ["src/a.ts", "src/a2.ts"] }), step("c"), step("d", { dependsOn: ["a"] })],
      waves: [["a", "c"], ["d"]],
    };
    const d = diffPlans(a, b);
    expect(d.added.map((s) => s.id)).toEqual(["d"]);
    expect(d.removed.map((s) => s.id)).toEqual(["b"]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]).toMatchObject({ id: "a", fields: ["role", "files"], filesAdded: ["src/a2.ts"], filesRemoved: [] });
    expect(d.unchanged).toEqual(["c"]);
    expect(d.summaryChanged).toBe(true);
    expect(d.wavesChanged).toBe(true);
    expect(d.identical).toBe(false);
    expect(d.ownership).toEqual([
      { file: "src/a2.ts", before: null, after: "a" },
      { file: "src/b.ts", before: "b", after: null },
      { file: "src/d.ts", before: null, after: "d" },
    ]);
    const text = renderPlanDiff(d);
    expect(text).toContain("+ d  D");
    expect(text).toContain("- b  B");
    expect(text).toContain("role backend -> frontend");
  });

  it("reports a file moving between steps as an ownership change", () => {
    const a: RunPlan = { summary: "", steps: [step("a", { files: ["x.ts"] }), step("b", { files: [] })], waves: [] };
    const b: RunPlan = { summary: "", steps: [step("a", { files: [] }), step("b", { files: ["x.ts"] })], waves: [] };
    const d = diffPlans(a, b);
    expect(d.ownership).toEqual([{ file: "x.ts", before: "a", after: "b" }]);
    expect(d.changed.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("matches a renamed step by title, and a rename alone is not an ownership change", () => {
    const a: RunPlan = { summary: "", steps: [step("api", { title: "Build API" })], waves: [] };
    const b: RunPlan = { summary: "", steps: [step("backend", { title: "Build API", files: ["src/api.ts"] })], waves: [] };
    const d = diffPlans(a, b);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.changed[0]).toMatchObject({ id: "backend", previousId: "api", fields: [] });
    expect(d.ownership).toEqual([]);
  });

  it("detects reordering and compares prompt and model on versions", async () => {
    const a: RunPlan = { summary: "", steps: [step("a"), step("b")], waves: [["a", "b"]] };
    const b: RunPlan = { summary: "", steps: [step("b"), step("a")], waves: [["b", "a"]] };
    expect(diffPlans(a, b)).toMatchObject({ reordered: true, identical: false, changed: [] });
    expect(diffPlans(a, a).identical).toBe(true);

    const { version: v1 } = await store.create({ plan: a, prompt: "one", model: "m1", origin: "planned" });
    const { version: v2 } = await store.create({ plan: a, prompt: "one", model: "m2", origin: "planned" });
    const d = diffPlans(v1, v2);
    expect(d).toMatchObject({ identical: true, modelChanged: true, promptChanged: false, a: { id: v1.id }, b: { id: v2.id } });
    expect(renderPlanDiff(d)).toContain("only the model differs");
  });
});
