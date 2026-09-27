import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "@/app/api/recipes/route";
import { POST as RUN } from "@/app/api/recipes/run/route";
import { parseFrame } from "@/lib/client/agent-stream";
import type { OrchestrationEvent } from "@/lib/agents/events";
import { RUN_ID_HEADER } from "@/lib/harness/contracts";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { repoRecipesDir } from "@/lib/recipes/store";
import { getSessionManager } from "@/lib/sessions";
import { resetRunsForTests } from "@/lib/harness/runs";
import { resetMemoryStoreForTests } from "@/lib/store";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";
import { CliError, parseCliArgs, type RecipeArgs } from "@/cli/viberon";
import { runRecipeCommand } from "@/cli/recipe";

const DEMO = `# demo
name: demo
description: List and check
version: 1.1.0
params:
  dir:
    type: path
    default: test
steps:
  - id: listing
    shell: ls {{dir}}
  - id: write
    shell: echo made > made.txt
  - id: check
    verify: auto
`;

let repo: TmpRepo;
let repoKey: string;
let globalDir: string;

beforeEach(async () => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({
    "package.json": JSON.stringify({ name: "m", scripts: { test: "node --test" } }),
    "test/a.test.js": "require('node:test')('ok', () => {});\n",
  });
  mkdirSync(repoRecipesDir(repo.root), { recursive: true });
  writeFileSync(path.join(repoRecipesDir(repo.root), "demo.yaml"), DEMO);
  writeFileSync(path.join(repoRecipesDir(repo.root), "broken.yaml"), "name: broken\nversion: 1\nsteps:\n  - shell: ls\n");
  repoKey = (await registerLocalWorkspace(repo.root)).repoKey;
  globalDir = mkdtempSync(path.join(os.tmpdir(), "viberon-global-recipes-"));
  vi.stubEnv("VIBERON_RECIPES_DIR", globalDir);
});
afterEach(() => {
  uninstallFakeProvider();
  vi.unstubAllEnvs();
  repo.cleanup();
  rmSync(globalDir, { recursive: true, force: true });
});

const get = async (query: string) => {
  const res = await GET(new Request(`http://localhost/api/recipes${query}`));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const post = async (body: unknown) => {
  const res = await POST(new Request("http://localhost/api/recipes", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

async function readEvents(res: Response): Promise<OrchestrationEvent[]> {
  const text = await res.text();
  return text
    .split("\n\n")
    .map(parseFrame)
    .filter((e): e is OrchestrationEvent => e !== null);
}

describe("GET/POST /api/recipes", () => {
  it("lists repo, global and built-in recipes, invalid ones with errors", async () => {
    const { json } = await get(`?repoKey=${repoKey}`);
    const recipes = json.recipes as { name: string; source: string; errors?: unknown[] }[];
    expect(recipes.map((r) => r.name)).toEqual(["add-tests", "broken", "bump-dependency", "demo", "document-module", "fix-lint"]);
    expect(recipes.find((r) => r.name === "demo")).toMatchObject({ source: "repo" });
    expect(recipes.find((r) => r.name === "broken")?.errors).toEqual([{ path: "description", message: "is required", line: 1 }]);
    // Without a workspace: global and built-in only.
    expect(((await get("")).json.recipes as unknown[]).length).toBe(4);
  });

  it("shows one recipe by name, and never reads files by path", async () => {
    const shown = await get(`?repoKey=${repoKey}&name=demo`);
    expect(shown.json).toMatchObject({ entry: { name: "demo", source: "repo" }, text: DEMO });
    expect((await get(`?repoKey=${repoKey}&name=nope`)).status).toBe(404);
    expect((await get(`?repoKey=${repoKey}&name=${encodeURIComponent("../../etc/passwd")}`)).status).toBe(400);
    expect((await get(`?name=${encodeURIComponent("/etc/hosts")}`)).status).toBe(400);
  });

  it("validates YAML source with line-numbered errors", async () => {
    expect((await post({ source: DEMO })).json).toMatchObject({ ok: true, recipe: { name: "demo" }, errors: [] });
    expect((await post({ source: "name: x\nsteps:\n\t- a\n" })).json).toEqual({
      ok: false,
      errors: [{ path: "", message: expect.stringMatching(/tab/), line: 3 }],
    });
    expect((await post({ source: "x".repeat(300 * 1024) })).status).toBe(413);
    expect((await post({})).status).toBe(400);
    expect((await POST(new Request("http://localhost/api/recipes", { method: "POST", body: "{" }))).status).toBe(400);
  });

  it("validates a saved recipe's parameters", async () => {
    expect((await post({ repoKey, name: "demo", params: { dir: "src" } })).json).toMatchObject({ ok: true, params: { dir: "src" } });
    expect((await post({ repoKey, name: "demo", params: { dir: "../up", extra: 1 } })).json).toMatchObject({
      ok: false,
      errors: [
        { path: "params.extra", message: expect.stringMatching(/unknown parameter/) },
        { path: "params.dir", message: expect.stringMatching(/inside the repository/) },
      ],
    });
    expect((await post({ repoKey, name: "broken" })).json).toMatchObject({ ok: false, errors: [{ path: "description" }] });
    expect((await post({ repoKey, name: "demo", params: [1] })).status).toBe(400);
    expect((await post({ repoKey, name: "../x" })).status).toBe(400);
  });
});

describe("POST /api/recipes/run", () => {
  const run = (body: unknown) => RUN(new Request("http://localhost/api/recipes/run", { method: "POST", body: JSON.stringify(body) }));

  it("rejects bad requests before opening a stream", async () => {
    expect((await run({ name: "demo" })).status).toBe(400);
    expect((await run({ repoKey, name: "../demo" })).status).toBe(400);
    expect((await run({ repoKey, name: "nope" })).status).toBe(404);
    const invalid = await run({ repoKey, name: "broken" });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ errors: [{ path: "description" }] });
    const params = await run({ repoKey, name: "demo", params: { dir: "/etc" } });
    expect(params.status).toBe(400);
    expect(await params.json()).toMatchObject({ errors: [{ path: "params.dir" }] });
  });

  it("streams the recipe as an ordinary run: plan, lanes, verification, run_done", async () => {
    installFakeProvider();
    const res = await run({ repoKey, name: "demo", model: "claude-opus-5", commandPolicy: "auto" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const runId = res.headers.get(RUN_ID_HEADER);
    expect(runId).toBeTruthy();
    const events = await readEvents(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("checkpoint");
    expect(events.find((e) => e.type === "run_start")).toMatchObject({ runId, model: "claude-opus-5" });
    const plan = events.find((e): e is Extract<OrchestrationEvent, { type: "plan" }> => e.type === "plan")!;
    expect(plan.plan.steps.map((s) => s.id)).toEqual(["listing", "write", "check"]);
    expect(events.filter((e) => e.type === "agent_done").every((e) => !("error" in e && e.error))).toBe(true);
    expect(events.find((e) => e.type === "verification")).toMatchObject({ agentId: "check", failed: 0 });
    expect(events.at(-1)).toMatchObject({ type: "run_done", status: "done", filesChanged: 1 });
    expect(readFileSync(path.join(repo.root, "made.txt"), "utf8")).toBe("made\n");
  });

  it("uses the run's approval channel for commands off the safe list", async () => {
    installFakeProvider();
    const res = await run({ repoKey, name: "demo", model: "claude-opus-5", commandPolicy: "never" });
    const events = await readEvents(res);
    const failed = events.find((e) => e.type === "agent_done" && "error" in e && e.error && !e.error.startsWith("Skipped"));
    expect(failed).toMatchObject({ agentId: "listing", error: expect.stringMatching(/command policy: never/) });
    expect(events.at(-1)).toMatchObject({ type: "run_done", status: "failed" });
    expect(existsSync(path.join(repo.root, "made.txt"))).toBe(false);
  });
});

describe("POST /api/recipes/run in a session", () => {
  const run = (body: unknown) => RUN(new Request("http://localhost/api/recipes/run", { method: "POST", body: JSON.stringify(body) }));
  afterEach(async () => {
    (await getSessionManager()).reset();
    resetRunsForTests();
  });

  it("rejects a session that is unknown or belongs to another workspace", async () => {
    expect((await run({ repoKey, name: "demo", sessionId: "ses_missing" })).status).toBe(404);
    const other = await (await getSessionManager()).create({ repoKey: "other-repo" });
    expect((await run({ repoKey, name: "demo", sessionId: other.id })).status).toBe(404);
  });

  it("runs as the session's run: session checkpoint, status and ledger", async () => {
    installFakeProvider();
    const manager = await getSessionManager();
    const session = await manager.create({ repoKey });
    const res = await run({ repoKey, name: "demo", model: "claude-opus-5", commandPolicy: "auto", sessionId: session.id });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.at(-1)).toMatchObject({ type: "run_done", status: "done" });
    const after = manager.get(session.id)!;
    expect(after.status).toBe("done");
    expect(after.runId === null || after.runId === res.headers.get(RUN_ID_HEADER)).toBe(true);
    const checkpoint = events.find((e) => e.type === "checkpoint");
    expect(checkpoint).toBeTruthy();
    expect(after.checkpointIds).toContain((checkpoint as { id: string }).id);
  });

  it("refuses a second run while the session is busy", async () => {
    installFakeProvider();
    const manager = await getSessionManager();
    const session = await manager.create({ repoKey });
    const first = await run({ repoKey, name: "demo", model: "claude-opus-5", commandPolicy: "auto", sessionId: session.id });
    const second = await run({ repoKey, name: "demo", model: "claude-opus-5", commandPolicy: "auto", sessionId: session.id });
    expect(second.status).toBe(409);
    await readEvents(first);
  });
});

describe("viberon recipe (CLI)", () => {
  it("parses recipe actions, repeatable --param and per-action flags", () => {
    expect(parseCliArgs(["recipe", "run", "add-tests", "--param", "file=src/a.ts", "--param=focus=a=b", "--repo", "/r", "--allow-commands", "--json"])).toEqual({
      command: "recipe",
      action: "run",
      target: "add-tests",
      repo: "/r",
      params: { file: "src/a.ts", focus: "a=b" },
      json: true,
      allowCommands: true,
      worktree: false,
      keepWorktree: false,
      global: false,
      force: false,
    });
    expect(parseCliArgs(["recipe", "list"])).toMatchObject({ command: "recipe", action: "list", params: {} });
    expect(parseCliArgs(["recipe", "import", "https://x/y.yaml", "--global", "--force"])).toMatchObject({ action: "import", global: true, force: true });
    expect(parseCliArgs(["recipe", "--help"])).toEqual({ command: "help" });
    const bad: [string[], RegExp][] = [
      [["recipe"], /an action is required/],
      [["recipe", "explode"], /unknown action "explode"/],
      [["recipe", "run"], /a recipe name or file is required/],
      [["recipe", "import"], /a URL or file is required/],
      [["recipe", "list", "extra"], /unexpected argument "extra"/],
      [["recipe", "run", "x", "--param", "novalue"], /--param takes name=value/],
      [["recipe", "run", "x", "--param", "a=1", "--param", "a=2"], /given twice/],
      [["recipe", "run", "x", "--param"], /--param needs a value/],
      [["recipe", "list", "--param", "a=1"], /--param does not apply/],
      [["recipe", "validate", "x", "--force"], /--force does not apply/],
      [["recipe", "import", "x", "--repo", "/r", "--global"], /only one of --repo and --global/],
      [["recipe", "run", "x", "--keep-worktree"], /--keep-worktree needs --worktree/],
      [["recipe", "run", "x", "--bogus=1"], /Unknown option for recipe: --bogus/],
    ];
    for (const [argv, re] of bad) expect(() => parseCliArgs(argv)).toThrow(re);
    expect(() => parseCliArgs(["recipe"])).toThrow(CliError);
  });

  function cli(args: Partial<RecipeArgs> & Pick<RecipeArgs, "action">) {
    const out: string[] = [];
    const logs: string[] = [];
    const full: RecipeArgs = {
      command: "recipe",
      params: {},
      json: false,
      allowCommands: false,
      worktree: false,
      keepWorktree: false,
      global: false,
      force: false,
      repo: repo.root,
      ...args,
    };
    return runRecipeCommand(full, (l) => logs.push(l), { out: (t) => out.push(t) }).then((code) => ({ code, out: out.join(""), logs }));
  }

  it("lists, shows and validates", async () => {
    const list = await cli({ action: "list" });
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^demo {2}v1\.1\.0 {2}List and check {2}\[repo: .*demo\.yaml\]$/m);
    expect(list.out).toMatch(/^broken {2}INVALID \(1 problem\(s\)\)/m);
    expect(list.out).toMatch(/^fix-lint {2}v1\.0\.0 .*\[builtin\]$/m);

    const show = await cli({ action: "show", target: "demo" });
    expect(show).toMatchObject({ code: 0, out: DEMO });

    expect(await cli({ action: "validate", target: "demo" })).toMatchObject({ code: 0, out: "ok  demo v1.1.0: 1 parameter(s), 3 step(s)\n" });
    const invalid = await cli({ action: "validate", target: "broken" });
    expect(invalid.code).toBe(1);
    expect(invalid.out).toContain("line 1: description: is required");
    const json = await cli({ action: "validate", target: "broken", json: true });
    expect(JSON.parse(json.out)).toMatchObject({ ok: false, errors: [{ path: "description" }] });
    expect((await cli({ action: "validate", target: "nope" })).code).toBe(2);
  });

  it("imports a file into the repository, validating first", async () => {
    const src = path.join(globalDir, "..", `share-${Date.now()}.yaml`);
    writeFileSync(src, DEMO.replace("name: demo", "name: shared"));
    const ok = await cli({ action: "import", target: src });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/^imported shared v1\.1\.0 → .*\.viberon\/recipes\/shared\.yaml\n$/);
    const again = await cli({ action: "import", target: src });
    expect(again.out).toMatch(/already up to date/);
    writeFileSync(src, "name: bad\n");
    const bad = await cli({ action: "import", target: src });
    expect(bad.code).toBe(1);
    expect(bad.logs.join("\n")).toMatch(/invalid; nothing was saved[\s\S]*description: is required/);
    const http = await cli({ action: "import", target: "http://example.com/x.yaml" });
    expect(http.code).toBe(2);
    expect(http.logs[0]).toMatch(/Only https/);
    rmSync(src);
  });

  it("runs a recipe headlessly with an evidence bundle and exit code", async () => {
    const out = path.join(globalDir, "bundle");
    const result = await cli({ action: "run", target: "demo", params: { dir: "test" }, allowCommands: true, out });
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^ok {7}listing {2}\$ ls test$/m);
    expect(result.out).toMatch(/^RESOLVED {2}1 file\(s\) changed/m);
    const bundle = JSON.parse(readFileSync(path.join(out, "result.json"), "utf8")) as Record<string, unknown>;
    expect(bundle).toMatchObject({ status: "resolved", exitCode: 0, filesChanged: ["made.txt"], task: expect.stringMatching(/^Recipe demo v1\.1\.0: List and check \(dir=test\)$/) });
    expect(readFileSync(path.join(out, "patch.diff"), "utf8")).toContain("+made");
    expect(readFileSync(path.join(out, "trajectory.jsonl"), "utf8")).toContain('"type":"plan"');

    const badParams = await cli({ action: "run", target: "demo", params: { nope: "1" } });
    expect(badParams.code).toBe(2);
    expect(badParams.logs.join("\n")).toMatch(/unknown parameter "nope"/);
  });

  it("without --allow-commands only auto-approved commands run", async () => {
    const out = path.join(globalDir, "bundle2");
    const result = await cli({ action: "run", target: "demo", out });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/^FAILED {3}write .*cannot ask for approval \(the CLI needs --allow-commands\)/m);
    expect(existsSync(path.join(repo.root, "made.txt"))).toBe(false);
  });
});
