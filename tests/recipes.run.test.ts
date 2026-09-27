import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SolveOptions, SolveResult } from "@/lib/harness/solve-types";
import { emptySolveResult } from "@/lib/headless/run";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { executeRecipe, recipePlan, recipeSolver, type RecipeRunOptions } from "@/lib/recipes/run";
import { parseRecipe, resolveParams } from "@/lib/recipes/schema";
import type { Recipe } from "@/lib/recipes/types";
import { resetMemoryStoreForTests } from "@/lib/store";
import { openWorkspace, readFile, type WorkspaceHandle } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog, makeWorkspace } from "./helpers/harness-workspace";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const PKG = JSON.stringify({ name: "m", scripts: { test: "node --test" } });
const MATH = "module.exports = { add: (a, b) => a + b };\n";
const TEST_OK =
  "const test = require('node:test');\nconst assert = require('node:assert');\nconst { add } = require('../math');\ntest('adds', () => assert.strictEqual(add(2, 3), 5));\n";

function recipeOf(src: string): Recipe {
  const { recipe, issues } = parseRecipe(src);
  expect(issues).toEqual([]);
  return recipe!;
}

const header = (params = "") => `name: t\ndescription: test recipe\nversion: 1\n${params}steps:\n`;

let repo: TmpRepo;
let handle: WorkspaceHandle;

beforeEach(async () => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({ "package.json": PKG, "math.js": MATH, "test/math.test.js": TEST_OK });
  handle = await openWorkspace((await registerLocalWorkspace(repo.root)).repoKey);
});
afterEach(() => {
  uninstallFakeProvider();
  repo.cleanup();
});

function options(recipe: Recipe, log: ReturnType<typeof eventLog>, over: Partial<RecipeRunOptions> = {}): RecipeRunOptions {
  return {
    recipe,
    params: resolveParams(recipe, {}).values,
    handle,
    model: "claude-opus-5",
    emit: log.emit,
    runId: "run-1",
    commandPolicy: "ask",
    ...over,
  };
}

describe("executeRecipe: shell and verify steps on disk", () => {
  it("runs steps in order with templating, conditions, the command blocklist and the repo's checks", async () => {
    const recipe = recipeOf(`${header("params:\n  dir:\n    type: path\n    default: test\n")}  - id: listing
    shell: ls {{dir}}
  - id: echo
    when: listing.succeeded
    shell: echo {{steps.listing.output}}
  - id: danger
    shell: rm -rf ~
    continue_on_error: true
  - id: redirect
    shell: echo hi > out.txt
    continue_on_error: true
  - id: check
    verify: auto
  - id: after
    when: check.failed
    shell: echo never
`);
    const log = eventLog();
    const result = await executeRecipe(options(recipe, log));

    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ["listing", "succeeded"],
      ["echo", "succeeded"],
      ["danger", "failed"],
      ["redirect", "failed"],
      ["check", "succeeded"],
      ["after", "skipped"],
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.steps[0]!.output).toContain("math.test.js");
    expect(result.steps[1]!.output).toContain("math.test.js");
    expect(result.steps[2]!.error).toMatch(/Viberon never runs it/);
    expect(result.steps[3]!.error).toMatch(/cannot ask for approval/);
    expect(existsSync(path.join(repo.root, "out.txt"))).toBe(false);
    expect(result.steps[4]!.output).toMatch(/npm test.*1 passed/);
    expect(result.steps[5]!.error).toBe("condition `check.failed` was false");
    expect(result.verifiedAfterLastChange).toBe(true);
    expect(result.lastVerification).toMatchObject({ exitCode: 0, counts: { passed: 1 } });
    expect(result.summary).toMatch(/^Recipe `t` v1 completed \(5 of 6 steps ran\)/);

    // Progress is the ordinary run stream: a plan, a wave and a lane per step.
    const plan = log.of("plan")[0]!.plan;
    expect(plan.steps.map((s) => [s.id, s.role])).toEqual([
      ["listing", "devops"],
      ["echo", "devops"],
      ["danger", "devops"],
      ["redirect", "devops"],
      ["check", "tester"],
      ["after", "devops"],
    ]);
    expect(plan.steps[0]!.detail).toBe("$ ls test");
    expect(plan.steps[1]!.detail).toBe("When: listing.succeeded\n\n$ echo '{{steps.listing.output}}'");
    expect(log.of("wave_start")).toHaveLength(6);
    expect(log.of("agent_start").map((e) => e.agentId)).toEqual(["listing", "echo", "danger", "redirect", "check", "after"]);
    expect(log.of("agent_done").filter((e) => e.error).map((e) => e.agentId)).toEqual(["danger", "redirect", "after"]);
    expect(log.of("command").map((e) => e.command)).toEqual(["ls test", expect.stringMatching(/^echo '/)]);
    expect(log.of("verification")[0]).toMatchObject({ agentId: "check", phase: "gate", passed: 1, failed: 0 });
  });

  it("stops at a failure: later steps are skipped unless their condition asks for it", async () => {
    const recipe = recipeOf(`${header()}  - id: bad
    shell: ls does-not-exist
  - id: next
    shell: ls
  - id: rescue
    when: bad.failed
    shell: ls
  - id: tail
    when: success
    shell: ls
`);
    const result = await executeRecipe(options(recipe, eventLog()));
    expect(result.status).toBe("failed");
    expect(result.steps.map((s) => [s.id, s.status, s.error])).toEqual([
      ["bad", "failed", "`ls does-not-exist` exited 1"],
      ["next", "skipped", "an earlier step failed"],
      ["rescue", "succeeded", undefined],
      ["tail", "skipped", "condition `success` was false"],
    ]);
  });

  it("never lets a parameter inject shell syntax", async () => {
    const recipe = recipeOf(`${header("params:\n  p: string\n")}  - shell: ls {{p}}\n`);
    const log = eventLog();
    const result = await executeRecipe(options(recipe, log, { params: { p: "x; echo pwned > pwned.txt" } }));
    expect(result.steps[0]!.status).toBe("failed");
    expect(log.of("command")[0]!.command).toBe("ls 'x; echo pwned > pwned.txt'");
    expect(existsSync(path.join(repo.root, "pwned.txt"))).toBe(false);
  });

  it("applies the command policy: ask through the run's approvals, auto, never", async () => {
    const recipe = recipeOf(`${header()}  - shell: echo hi > out.txt\n`);
    const ask = vi.fn(async () => false);
    const declined = await executeRecipe(options(recipe, eventLog(), { requestApproval: ask }));
    expect(declined.steps[0]!.error).toMatch(/was declined/);
    expect(ask).toHaveBeenCalledWith("step-1", expect.objectContaining({ kind: "command", title: "echo hi > out.txt", alwaysKey: "command:echo hi > out.txt" }));

    const never = await executeRecipe(options(recipe, eventLog(), { commandPolicy: "never" }));
    expect(never.steps[0]!.error).toMatch(/command policy: never/);
    expect(existsSync(path.join(repo.root, "out.txt"))).toBe(false);

    const approved = await executeRecipe(options(recipe, eventLog(), { requestApproval: async () => true }));
    expect(approved.status).toBe("succeeded");
    expect(repo.read("out.txt")).toBe("hi\n");

    repo.write("out.txt", "");
    const auto = await executeRecipe(options(recipe, eventLog(), { commandPolicy: "auto" }));
    expect(auto.status).toBe("succeeded");
    expect(repo.read("out.txt")).toBe("hi\n");
  });

  it("verify steps: failing checks, kind filters, custom commands and targets", async () => {
    repo.write("test/bad.test.js", "require('node:test')('breaks', () => { throw new Error('boom'); });\n");
    const recipe = recipeOf(`${header()}  - id: all
    verify: auto
    continue_on_error: true
  - id: typecheck
    verify:
      kind: typecheck
    continue_on_error: true
  - id: custom
    verify:
      command: npm test
    continue_on_error: true
  - id: blocked
    verify:
      command: rm -rf /
    continue_on_error: true
`);
    const result = await executeRecipe(options(recipe, eventLog()));
    expect(result.status).toBe("succeeded");
    expect(result.steps.map((s) => s.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(result.steps[0]!.error).toMatch(/failed \(1 passed, 1 failed/);
    expect(result.steps[0]!.output).toContain("boom");
    expect(result.steps[1]!.error).toBe("no typecheck checks were detected in this repository");
    expect(result.steps[2]!.error).toMatch(/`npm test` failed/);
    expect(result.steps[3]!.error).toMatch(/Viberon never runs it/);
    expect(result.verifiedAfterLastChange).toBe(false);
  });

  it("marks everything skipped and cancelled when the run is stopped", async () => {
    const recipe = recipeOf(`${header()}  - shell: ls\n  - verify: auto\n`);
    const controller = new AbortController();
    controller.abort();
    const result = await executeRecipe(options(recipe, eventLog(), { signal: controller.signal }));
    expect(result.status).toBe("cancelled");
    expect(result.steps.every((s) => s.status === "skipped" && s.error === "the run was stopped")).toBe(true);
  });

  it("hands solver steps to solveTask and keeps its run-level events out of the recipe stream", async () => {
    const recipe = recipeOf(`${header("params:\n  bug: string\n")}  - id: fix
    agent:
      role: solver
      prompt: "Fix {{bug}}"
      max_turns: 7
  - verify: auto
`);
    let seen: SolveOptions | null = null;
    const solve = vi.fn(async (o: SolveOptions): Promise<SolveResult> => {
      seen = o;
      o.emit({ type: "run_start", runId: o.runId, mode: "single", model: o.model, at: 0 });
      o.emit({ type: "agent_start", agentId: "solver", stepId: "attempt-1", role: "solver", title: "Solve", model: o.model, wave: 0 });
      o.emit({ type: "run_done", status: "done", summary: "x", filesChanged: 0, durationMs: 0, costUsd: 0 });
      const r = emptySolveResult("resolved");
      r.summary = "Fixed the off-by-one.";
      r.filesChanged = ["math.js"];
      r.metrics.modelCalls = 3;
      r.metrics.costUsd = 0.5;
      return r;
    });
    const log = eventLog();
    const result = await executeRecipe(options(recipe, log, { params: { bug: "the add bug" }, deps: { solve } }));
    expect(seen!.task).toMatch(/^Fix the add bug\n\n## Context\n\nYou are step 1 of 2 of the recipe "t"/);
    expect(seen!.budget.maxTurns).toBe(7);
    expect(seen!.verify.enabled).toBe(true);
    expect(seen!.verify.commands[0]!.command).toMatch(/npm test/);
    expect(result.steps[0]).toMatchObject({ status: "succeeded", output: "Fixed the off-by-one." });
    expect(result).toMatchObject({ status: "succeeded", modelCalls: 3, cost: 0.5, filesTouched: ["math.js"] });
    expect(log.of("run_start")).toHaveLength(0);
    expect(log.of("run_done")).toHaveLength(0);
    expect(log.of("agent_start")[0]).toMatchObject({ agentId: "solver" });
  });

  it("a solver that ends without a change fails the step", async () => {
    const recipe = recipeOf(`${header()}  - agent:\n      role: solver\n      prompt: fix it\n`);
    const solve = async (): Promise<SolveResult> => ({ ...emptySolveResult("failed"), summary: "No change was produced." });
    const result = await executeRecipe(options(recipe, eventLog(), { deps: { solve } }));
    expect(result.steps[0]!.error).toMatch(/the solver ended failed/);
    expect(result.status).toBe("failed");
  });
});

describe("executeRecipe: agent steps through runAgent", () => {
  it("runs the step's role with its declared tools, owned files as the write lock, and the recipe briefing", async () => {
    const ws = await makeWorkspace([{ path: "src/app.ts", source: "export const a = 1;\n" }]);
    const fake = installFakeProvider([
      { calls: [{ name: "write_file", input: { path: "src/other.ts", content: "x", summary: "s" } }] },
      { calls: [{ name: "write_file", input: { path: "src/app.test.ts", content: "test", summary: "s" } }] },
      { text: "Wrote tests for src/app.ts." },
      { text: "Reviewed: {{looks fine}}" },
    ]);
    const recipe = recipeOf(`${header("params:\n  file:\n    type: path\n    required: true\n")}  - id: write
    title: Test {{file}}
    agent:
      role: tester
      tools: [read_file, write_file]
      files: ["src/app.test.ts"]
      prompt: Write tests for {{file}}.
      max_turns: 5
  - id: review
    agent:
      role: reviewer
      prompt: "Review this: {{steps.write.output}}"
`);
    const log = eventLog();
    const result = await executeRecipe({
      recipe,
      params: { file: "src/app.ts" },
      handle: ws.handle,
      model: "claude-opus-5",
      emit: log.emit,
      runId: "run-2",
      commandPolicy: "never",
    });

    expect(result.status).toBe("succeeded");
    expect(result.steps.map((s) => [s.id, s.title, s.status, s.output])).toEqual([
      ["write", "Test src/app.ts", "succeeded", "Wrote tests for src/app.ts."],
      ["review", "Review this: Wrote tests for src/app.ts.", "succeeded", "Reviewed: {{looks fine}}"],
    ]);
    expect(result.filesTouched).toEqual(["src/app.test.ts"]);
    expect(await readFile(ws.handle, "src/app.test.ts")).toBe("test");
    expect(await readFile(ws.handle, "src/other.ts")).toBeNull();

    const first = fake.requests[0]!;
    expect(first.tools?.map((t) => t.name)).toEqual(["read_file", "write_file"]);
    const system = first.system.map((b) => b.text).join("\n");
    expect(system).toContain('You are step 1 of 2 of the recipe "t" (v1): test recipe');
    expect(system).toContain("- file: src/app.ts");
    const task = JSON.stringify(first.messages);
    expect(task).toContain("## Test src/app.ts");
    expect(task).toContain("Files you own (you may only write these): `src/app.test.ts`");
    // The owned-files lock refused the write outside it.
    expect(JSON.stringify(fake.requests[1]!.messages)).toMatch(/Refused|outside|not allowed|scope/i);
    // The second step saw the first one's output.
    expect(JSON.stringify(fake.requests[3]!.messages)).toContain("Review this: Wrote tests for src/app.ts.");
    expect(log.of("agent_start").map((e) => [e.agentId, e.role])).toEqual([
      ["write", "tester"],
      ["review", "reviewer"],
    ]);
    expect(result.modelCalls).toBe(4);
  });
});

describe("recipeSolver: the SolveOptions contract", () => {
  const solveOptions = (log: ReturnType<typeof eventLog>, h: WorkspaceHandle): SolveOptions => ({
    handle: h,
    task: "recipe",
    model: "claude-opus-5",
    emit: log.emit,
    runId: "run-3",
    budget: { maxTurns: 10 },
    verify: { enabled: true, commands: [], timeoutMs: 60_000, baseline: false },
  });

  it("maps a verified run to resolved, with the diff of what the steps changed", async () => {
    const recipe = recipeOf(`${header()}  - shell: echo hi > out.txt\n  - verify: auto\n`);
    const log = eventLog();
    let steps = 0;
    const result = await recipeSolver(recipe, {}, { commandPolicy: "auto", onResult: (r) => (steps = r.steps.length) })(solveOptions(log, handle));
    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["out.txt"]);
    expect(result.diff).toContain("+hi");
    expect(result.gate).toMatchObject({ enabled: true, ranAfterLastEdit: true, final: { exitCode: 0 } });
    expect(steps).toBe(2);
    expect(log.of("run_start")).toHaveLength(1);
    expect(log.of("run_done")[0]).toMatchObject({ status: "done", filesChanged: 1 });
    expect(log.of("intent")[0]!.reason).toBe("Running recipe t v1.");
  });

  it("maps unverified, failed and cancelled runs", async () => {
    const unverified = await recipeSolver(recipeOf(`${header()}  - verify: auto\n  - shell: echo hi > out.txt\n`), {}, { commandPolicy: "auto" })(
      solveOptions(eventLog(), handle),
    );
    expect(unverified.status).toBe("unverified");
    expect(unverified.gate.ranAfterLastEdit).toBe(false);

    const log = eventLog();
    const failed = await recipeSolver(recipeOf(`${header()}  - id: nope\n    shell: ls missing-dir\n`), {}, { commandPolicy: "auto" })(solveOptions(log, handle));
    expect(failed).toMatchObject({ status: "failed", error: "$ ls missing-dir: `ls missing-dir` exited 1" });
    expect(log.of("run_done")[0]!.status).toBe("failed");

    const controller = new AbortController();
    controller.abort();
    const stopped = await recipeSolver(recipeOf(`${header()}  - shell: ls\n`), {}, { commandPolicy: "auto" })({
      ...solveOptions(eventLog(), handle),
      signal: controller.signal,
    });
    expect(stopped.status).toBe("incomplete");
  });

  it("turns an internal error into an error result instead of throwing", async () => {
    const recipe = recipeOf(`${header()}  - agent:\n      role: solver\n      prompt: x\n`);
    const log = eventLog();
    const result = await recipeSolver(recipe, {}, { commandPolicy: "auto", deps: { solve: () => Promise.reject(new Error("kaboom")) } })(
      solveOptions(log, handle),
    );
    // A throwing step is a failed step; the recipe still completes normally.
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/kaboom/);
  });

  it("renders the plan with parameters but leaves step outputs as written", () => {
    const recipe = recipeOf(`${header("params:\n  f: path\n")}  - id: a\n    agent:\n      prompt: "Test {{f}}"\n      files: ["{{f}}"]\n  - verify:\n      command: npx vitest run {{f}}\n`);
    const plan = recipePlan(recipe, { f: "src/x y.ts" });
    expect(plan.steps.map((s) => [s.title, s.detail, s.files, s.dependsOn])).toEqual([
      ["Test src/x y.ts", "Test src/x y.ts", ["src/x y.ts"], []],
      ["Check: npx vitest run src/x y.ts", "Check: npx vitest run 'src/x y.ts'", [], ["a"]],
    ]);
    expect(plan.waves).toEqual([["a"], ["step-2"]]);
  });
});
