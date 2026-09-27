/** Bitbucket Cloud 2.0 adapter against a recording fetch: exact URLs, headers and bodies. */

import { describe, expect, it } from "vitest";

import { BitbucketProvider, mapBuildState, type BitbucketAuth } from "@/lib/git-providers/bitbucket";
import { GitProviderError, type RepoLocator } from "@/lib/git-providers/interface";
import { fakeFetch, json } from "@/tests/helpers/fake-fetch";

const REPO: RepoLocator = { platform: "bitbucket", host: "bitbucket.org", baseUrl: "https://bitbucket.org", owner: "ws", repo: "app" };
const API = "https://api.bitbucket.org/2.0/repositories/ws/app";
const BASIC: BitbucketAuth = { kind: "basic", username: "jdoe", password: "ATBBapppass" };
const BEARER: BitbucketAuth = { kind: "bearer", token: "ATCTTaccesstoken" };
const basicHeader = `Basic ${Buffer.from("jdoe:ATBBapppass").toString("base64")}`;

const pr = (over: Record<string, unknown> = {}) => ({
  id: 3,
  title: "Fix it",
  description: "Body",
  state: "OPEN",
  draft: true,
  source: { branch: { name: "viberon/fix-it" }, commit: { hash: "abc123def456" } },
  destination: { branch: { name: "main" } },
  links: { html: { href: "https://bitbucket.org/ws/app/pull-requests/3" } },
  ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
  id: 12,
  title: "Crash",
  content: { raw: "Steps" },
  state: "new",
  kind: "bug",
  component: { name: "viberon" },
  reporter: { nickname: "rep", display_name: "Rep Orter" },
  links: { html: { href: "https://bitbucket.org/ws/app/issues/12" } },
  created_on: "2026-09-01T00:00:00Z",
  updated_on: "2026-09-02T00:00:00Z",
  ...over,
});

function provider(routes: Parameters<typeof fakeFetch>[0], auth: BitbucketAuth | null = BASIC) {
  const fake = fakeFetch(routes);
  return { ...fake, bb: new BitbucketProvider(REPO, auth, { fetchImpl: fake.fetchImpl }) };
}

describe("BitbucketProvider", () => {
  it("authenticates with an app password as HTTP basic auth", async () => {
    const { bb, calls } = provider([["GET", API, json({ mainbranch: { name: "trunk" } })]]);
    expect(await bb.getDefaultBranch()).toBe("trunk");
    expect(calls).toEqual([
      { method: "GET", url: API, headers: { Accept: "application/json", "User-Agent": "Viberon", Authorization: basicHeader }, body: undefined },
    ]);
  });

  it("authenticates with an access token as a bearer token, or not at all", async () => {
    const bearer = provider([["GET", API, json({ mainbranch: { name: "main" } })]], BEARER);
    await bearer.bb.getDefaultBranch();
    expect(bearer.calls[0]!.headers.Authorization).toBe("Bearer ATCTTaccesstoken");
    const anon = provider([["GET", API, json({ mainbranch: { name: "main" } })]], null);
    await anon.bb.getDefaultBranch();
    expect(anon.calls[0]!.headers.Authorization).toBeUndefined();
    expect(anon.bb.authenticated).toBe(false);
  });

  it("creates a draft pull request", async () => {
    const { bb, calls } = provider([["POST", `${API}/pullrequests`, json(pr(), 201)]]);
    const out = await bb.createPullRequest({ title: "Fix it", body: "Body", head: "viberon/fix-it", base: "main" });
    expect(calls[0]!.body).toEqual({
      title: "Fix it",
      description: "Body",
      source: { branch: { name: "viberon/fix-it" } },
      destination: { branch: { name: "main" } },
      draft: true,
      close_source_branch: false,
    });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(out).toEqual({
      number: 3,
      title: "Fix it",
      body: "Body",
      url: "https://bitbucket.org/ws/app/pull-requests/3",
      state: "open",
      draft: true,
      headBranch: "viberon/fix-it",
      headSha: "abc123def456",
      baseBranch: "main",
    });
  });

  it("finds the open PR for a branch with a BBQL query", async () => {
    const url = `${API}/pullrequests?state=OPEN&q=source.branch.name%3D%22viberon%2Ffix-it%22`;
    const { bb, calls } = provider([["GET", url, json({ values: [pr()] })]]);
    expect((await bb.findOpenPullRequest("viberon/fix-it"))?.number).toBe(3);
    expect(calls[0]!.url).toBe(url);
    const none = provider([["GET", url, json({ values: [] })]]);
    expect(await none.bb.findOpenPullRequest("viberon/fix-it")).toBeNull();
  });

  it("updates title and description; maps PR states", async () => {
    const { bb, calls } = provider([
      ["PUT", `${API}/pullrequests/3`, json(pr({ title: "Better" }))],
      ["GET", `${API}/pullrequests/4`, json(pr({ id: 4, state: "MERGED", draft: false }))],
      ["GET", `${API}/pullrequests/5`, json(pr({ id: 5, state: "DECLINED" }))],
    ]);
    await bb.updatePullRequest(3, { title: "Better", body: "v2" });
    expect(calls[0]!.body).toEqual({ title: "Better", description: "v2" });
    expect((await bb.getPullRequest(4)).state).toBe("merged");
    expect((await bb.getPullRequest(5)).state).toBe("closed");
  });

  it("lists open issues; a label filters by component", async () => {
    const q = '(state="new" OR state="open" OR state="on hold") AND component.name="viberon"';
    const url = `${API}/issues?sort=-updated_on&pagelen=30&q=%28state%3D%22new%22+OR+state%3D%22open%22+OR+state%3D%22on+hold%22%29+AND+component.name%3D%22viberon%22`;
    const { bb, calls } = provider([["GET", url, json({ values: [issue()] })]]);
    const list = await bb.listIssues({ labels: ["viberon"], limit: 30 });
    expect(calls[0]!.url).toBe(url);
    expect(new URL(calls[0]!.url).searchParams.get("q")).toBe(q);
    expect(list).toEqual([
      {
        number: 12,
        title: "Crash",
        body: "Steps",
        url: "https://bitbucket.org/ws/app/issues/12",
        state: "open",
        labels: ["viberon", "bug"],
        author: "rep",
        comments: 0,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
  });

  it("closed and all issue queries; page size is capped at 50", async () => {
    const { bb, calls } = provider([["GET", (r) => r.url.startsWith(`${API}/issues?`), json({ values: [] })]]);
    await bb.listIssues({ state: "closed", limit: 500 });
    await bb.listIssues({ state: "all" });
    const first = new URL(calls[0]!.url).searchParams;
    expect(first.get("pagelen")).toBe("50");
    expect(first.get("q")).toBe('(state="resolved" OR state="closed" OR state="invalid" OR state="duplicate" OR state="wontfix")');
    expect(new URL(calls[1]!.url).searchParams.get("q")).toBeNull();
  });

  it("escapes quotes in BBQL values", async () => {
    const { bb, calls } = provider([["GET", (r) => r.url.startsWith(`${API}/issues?`), json({ values: [] })]]);
    await bb.listIssues({ labels: ['a"b'] });
    expect(new URL(calls[0]!.url).searchParams.get("q")).toContain('component.name="a\\"b"');
  });

  it("gets an issue and its comments", async () => {
    const comments = `${API}/issues/12/comments?sort=created_on&pagelen=20`;
    const { bb, calls } = provider([
      ["GET", `${API}/issues/12`, json(issue({ state: "resolved", content: { raw: null } }))],
      ["GET", comments, json({ values: [{ id: 1, content: { raw: "" } }, { id: 2, content: { raw: "Still broken" }, user: { display_name: "Maint" } }] })],
    ]);
    expect(await bb.getIssue(12)).toMatchObject({ number: 12, state: "closed", body: "" });
    expect(await bb.listIssueComments(12)).toEqual([{ body: "Still broken", author: "Maint" }]);
    expect(calls[1]!.url).toBe(comments);
  });

  it("comments on issues and pull requests", async () => {
    const { bb, calls } = provider([
      ["POST", `${API}/issues/12/comments`, json({ id: 7, links: { html: { href: "https://bitbucket.org/ws/app/issues/12#comment-7" } } }, 201)],
      ["POST", `${API}/pullrequests/3/comments`, json({ id: 8 }, 201)],
    ]);
    expect(await bb.createComment({ kind: "issue", number: 12 }, "hi")).toEqual({ id: "7", url: "https://bitbucket.org/ws/app/issues/12#comment-7" });
    expect((await bb.createComment({ kind: "pr", number: 3 }, "hi")).url).toBe("https://bitbucket.org/ws/app/pull-requests/3#comment-8");
    expect(calls.map((c) => c.body)).toEqual([{ content: { raw: "hi" } }, { content: { raw: "hi" } }]);
  });

  it("reads files at a ref (default: main branch) and returns null on 404", async () => {
    const { bb, calls } = provider([
      ["GET", `${API}/src/dev/src/a%20b.py`, new Response("x = 1\n")],
      ["GET", API, json({ mainbranch: { name: "main" } })],
      ["GET", `${API}/src/main/nope.txt`, json({ type: "error", error: { message: "No such file" } }, 404)],
    ]);
    expect(await bb.getFileContent("src/a b.py", "dev")).toBe("x = 1\n");
    expect(await bb.getFileContent("nope.txt")).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([`${API}/src/dev/src/a%20b.py`, API, `${API}/src/main/nope.txt`]);
  });

  it("creates a branch; moving one is unsupported", async () => {
    const { bb, calls } = provider([["POST", `${API}/refs/branches`, json({ name: "b" }, 201)]]);
    await bb.createBranch("viberon/x", "abc");
    expect(calls[0]!.body).toEqual({ name: "viberon/x", target: { hash: "abc" } });
    expect(((await bb.updateBranch().catch((e: unknown) => e)) as GitProviderError).code).toBe("unsupported");
  });

  it("reads commit build statuses; no logs or re-runs", async () => {
    const { bb, calls } = provider([
      [
        "GET",
        `${API}/commit/abc123def456/statuses?pagelen=100`,
        json({
          values: [
            { key: "pipeline-1", name: "Pipeline #1", state: "FAILED", url: "https://bitbucket.org/ws/app/pipelines/results/1" },
            { key: "ext", name: "", state: "INPROGRESS", url: "https://ci.example/b/2" },
          ],
        }),
      ],
    ]);
    expect(await bb.listChecks("abc123def456")).toEqual([
      { name: "Pipeline #1", status: "completed", conclusion: "failure", url: "https://bitbucket.org/ws/app/pipelines/results/1", jobId: null },
      { name: "ext", status: "in_progress", conclusion: null, url: "https://ci.example/b/2", jobId: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(bb.capabilities).toMatchObject({ ciStatus: true, ciLogs: false, ciRerun: false });
    expect(((await bb.getCheckLog().catch((e: unknown) => e)) as GitProviderError).code).toBe("unsupported");
    expect(((await bb.rerunCheck().catch((e: unknown) => e)) as GitProviderError).code).toBe("unsupported");
  });

  it("maps build states", () => {
    expect(mapBuildState("SUCCESSFUL")).toEqual({ status: "completed", conclusion: "success" });
    expect(mapBuildState("STOPPED")).toEqual({ status: "completed", conclusion: "cancelled" });
  });

  it("reports Bitbucket's error message and a hint, never the secret", async () => {
    const { bb } = provider([["GET", API, json({ type: "error", error: { message: "Access denied" } }, 403)]]);
    const error = (await bb.getDefaultBranch().catch((e: unknown) => e)) as GitProviderError;
    expect(error.status).toBe(403);
    expect(error.message).toMatch(/Bitbucket GET \/repositories\/ws\/app → 403: Access denied\. The credentials may lack access/);
    expect(error.message).not.toContain("ATBBapppass");
  });

  it("scopes git auth to https://bitbucket.org/ (user name in the remote is fine)", () => {
    const decode = (env: Record<string, string>) => Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("AUTHORIZATION: basic ", ""), "base64").toString();
    const basic = new BitbucketProvider(REPO, BASIC);
    const env = basic.gitAuthEnv("https://jdoe@bitbucket.org/ws/app.git");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://bitbucket.org/.extraheader");
    expect(decode(env)).toBe("jdoe:ATBBapppass");
    expect(decode(new BitbucketProvider(REPO, BEARER).gitAuthEnv("https://bitbucket.org/ws/app.git"))).toBe("x-token-auth:ATCTTaccesstoken");
    expect(basic.gitAuthEnv("git@bitbucket.org:ws/app.git")).toEqual({});
    expect(basic.gitAuthEnv("https://bitbucket.org.evil.example/ws/app.git")).toEqual({});
    expect(new BitbucketProvider(REPO, null).gitAuthEnv("https://bitbucket.org/ws/app.git")).toEqual({});
    expect(basic.secrets()).toEqual(["ATBBapppass"]);
  });

  it("closing reference", () => {
    const bb = new BitbucketProvider(REPO, null);
    expect(bb.closingReference({ repo: REPO, kind: "issue", number: 12 })).toBe("Fixes #12");
  });
});
