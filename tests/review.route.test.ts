import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "@/app/api/review/route";
import { invalidateCredentialCache } from "@/lib/ai/credentials";
import { clearMemoryGraphCache, getMemoryGraph } from "@/lib/memory/graph";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { installFakeProvider, uninstallFakeProvider, type FakeProvider } from "./helpers/fake-provider";
import { makeTmpRepo, type TmpRepo } from "./helpers/tmp-repo";

const REVIEW = { summary: "s", effort: 1, findings: [], security: null, tests: "n/a" };
const PR_DIFF = "diff --git a/pr.ts b/pr.ts\n--- a/pr.ts\n+++ b/pr.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";

let repo: TmpRepo;
let repoKey: string;
let fake: FakeProvider;

async function post(body: unknown) {
  const res = await POST(new Request("http://localhost/api/review", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  resetMemoryStoreForTests();
  repo = makeTmpRepo({ "src/app.ts": "export const a = 1;\n" });
  repoKey = (await registerLocalWorkspace(repo.root)).repoKey;
  fake = installFakeProvider();
});
afterEach(() => {
  uninstallFakeProvider();
  clearMemoryGraphCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  invalidateCredentialCache();
  repo.cleanup();
});

describe("POST /api/review", () => {
  it("validates input with clear 400s", async () => {
    expect((await post({ tool: "review", target: "working" })).json.error).toBe("repoKey is required");
    expect((await post({ repoKey, tool: "lint", target: "working" })).json.error).toMatch(/tool must be one of review, describe, improve, learn/);
    expect((await post({ repoKey, tool: "review", target: "everything" })).json.error).toMatch(/target must be/);
    expect((await post({ repoKey, tool: "review", target: { base: "--output=x" } })).json.error).toMatch(/target.base/);
    expect((await post({ repoKey, tool: "review", target: { prUrl: "https://example.com/x" } })).json.error).toMatch(/target.prUrl/);
    const empty = await post({ repoKey, tool: "review", target: "working" });
    expect(empty).toEqual({ status: 400, json: { error: "No changes to review for this target." } });
    const bad = await POST(new Request("http://localhost/api/review", { method: "POST", body: "{" }));
    expect(bad.status).toBe(400);
    expect(fake.requests).toHaveLength(0);
  });

  it("reviews working changes and describes staged ones", async () => {
    repo.write("src/app.ts", "export const a = 2;\n");
    fake.push({ text: JSON.stringify(REVIEW) });
    const review = await post({ repoKey, tool: "review", target: "working", model: "claude-haiku-4-5" });
    expect(review.status).toBe(200);
    expect(review.json).toMatchObject({ tool: "review", model: "claude-haiku-4-5", result: REVIEW, files: { included: ["src/app.ts"], omitted: [] } });
    expect(JSON.stringify(fake.requests[0].messages)).toContain("1 +export const a = 2;");

    expect((await post({ repoKey, tool: "describe", target: "staged" })).status).toBe(400);
    repo.git("add", "-A");
    fake.push({ text: '{"title": "Bump a", "body": "b", "type": "chore"}' });
    const described = await post({ repoKey, tool: "describe", target: "staged" });
    expect(described.json).toMatchObject({ result: { title: "Bump a", type: "chore" } });
  });

  it("includes untracked files in the working target", async () => {
    repo.write("src/new.ts", "export const fresh = true;\n");
    fake.push({ text: JSON.stringify(REVIEW) });
    const res = await post({ repoKey, tool: "review", target: "working", model: "claude-haiku-4-5" });
    expect(res.status).toBe(200);
    expect(res.json.files).toEqual({ included: ["src/new.ts"], omitted: [] });
    expect(JSON.stringify(fake.requests[0].messages)).toContain("export const fresh = true;");
  });

  it("reviews a branch against a base", async () => {
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("src/app.ts", "export const a = 3;\n");
    repo.git("commit", "-qam", "change");
    fake.push({ text: JSON.stringify(REVIEW) });
    const main = repo.git("rev-parse", "HEAD~1").trim();
    const res = await post({ repoKey, tool: "review", target: { base: main } });
    expect(res.status).toBe(200);
    expect(res.json.files).toEqual({ included: ["src/app.ts"], omitted: [] });
  });

  it("fetches a PR diff from GitHub and maps API errors", async () => {
    vi.stubEnv("GITHUB_TOKEN", "t");
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/pulls/5") ? new Response(PR_DIFF) : new Response('{"message": "Not Found"}', { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    fake.push({ text: '{"suggestions": []}' });
    const ok = await post({ repoKey, tool: "improve", target: { prUrl: "https://github.com/o/r/pull/5" } });
    expect(ok).toMatchObject({ status: 200, json: { result: [], files: { included: ["pr.ts"] } } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.github.com/repos/o/r/pulls/5");

    const missing = await post({ repoKey, tool: "review", target: { prUrl: "o/r#6" } });
    expect(missing.status).toBe(404);
    expect(missing.json.error).toMatch(/Not Found/);
  });

  it("fails with the credential message when no model key is configured", async () => {
    uninstallFakeProvider();
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    invalidateCredentialCache();
    repo.write("src/app.ts", "export const a = 2;\n");
    const res = await post({ repoKey, tool: "review", target: "working", model: "claude-haiku-4-5" });
    expect(res).toEqual({ status: 400, json: { error: expect.stringMatching(/No Anthropic API key configured/), code: "missing_credential" } });
  });

  it("learns review style from the origin repo's PR comments", async () => {
    expect((await post({ repoKey, tool: "learn" })).json.error).toMatch(/GitHub remote named origin/);
    repo.git("remote", "add", "origin", "git@github.com:o/r.git");
    vi.stubEnv("GITHUB_TOKEN", "t");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ body: "Export consts only.", path: "src/app.ts", user: { login: "a" }, created_at: "" }])),
    );
    fake.push({ text: '{"conventions": [{"text": "Export consts only.", "paths": ["src/app.ts"]}]}' });
    const res = await post({ repoKey, tool: "learn" });
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ comments: 1, conventions: [{ text: "Export consts only.", paths: ["src/app.ts"] }] });
    expect(getMemoryGraph(repo.root).entries.map((e) => [e.kind, e.text])).toContainEqual(["convention", "Export consts only."]);
  });
});
