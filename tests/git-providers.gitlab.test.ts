/** GitLab REST v4 adapter against a recording fetch: exact URLs, headers and bodies. */

import { describe, expect, it } from "vitest";

import { GitLabProvider, mapJobStatus } from "@/lib/git-providers/gitlab";
import { GitProviderError, type RepoLocator } from "@/lib/git-providers/interface";
import { fakeFetch, json } from "@/tests/helpers/fake-fetch";

const REPO: RepoLocator = { platform: "gitlab", host: "gitlab.com", baseUrl: "https://gitlab.com", owner: "grp/sub", repo: "proj" };
const API = "https://gitlab.com/api/v4/projects/grp%2Fsub%2Fproj";
const TOKEN = "glpat-SECRET123";

const mr = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  title: "Draft: Fix it",
  description: "Body",
  web_url: "https://gitlab.com/grp/sub/proj/-/merge_requests/7",
  state: "opened",
  draft: true,
  source_branch: "viberon/fix-it",
  target_branch: "main",
  sha: "abc123",
  ...over,
});

const issue = (over: Record<string, unknown> = {}) => ({
  iid: 5,
  title: "Crash",
  description: "Steps",
  web_url: "https://gitlab.com/grp/sub/proj/-/issues/5",
  state: "opened",
  labels: ["bug", "viberon"],
  author: { username: "rep" },
  user_notes_count: 2,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
  ...over,
});

function provider(routes: Parameters<typeof fakeFetch>[0], token: string | null = TOKEN, repo = REPO) {
  const fake = fakeFetch(routes);
  return { ...fake, gl: new GitLabProvider(repo, token, { fetchImpl: fake.fetchImpl }) };
}

describe("GitLabProvider", () => {
  it("sends PRIVATE-TOKEN and addresses the project by its URL-encoded full path", async () => {
    const { gl, calls } = provider([["GET", API, json({ default_branch: "develop" })]]);
    expect(await gl.getDefaultBranch()).toBe("develop");
    expect(calls).toEqual([
      {
        method: "GET",
        url: API,
        headers: { Accept: "application/json", "User-Agent": "Viberon", "PRIVATE-TOKEN": TOKEN },
        body: undefined,
      },
    ]);
  });

  it("is anonymous without a token", async () => {
    const { gl, calls } = provider([["GET", API, json({ default_branch: "main" })]], null);
    await gl.getDefaultBranch();
    expect(calls[0]!.headers["PRIVATE-TOKEN"]).toBeUndefined();
    expect(gl.authenticated).toBe(false);
  });

  it("uses a self-hosted base URL with a path prefix", async () => {
    const self: RepoLocator = { ...REPO, host: "corp.example", baseUrl: "https://corp.example/gitlab" };
    const { gl, calls } = provider([["GET", "https://corp.example/gitlab/api/v4/projects/grp%2Fsub%2Fproj", json({ default_branch: "main" })]], TOKEN, self);
    await gl.getDefaultBranch();
    expect(calls[0]!.url).toBe("https://corp.example/gitlab/api/v4/projects/grp%2Fsub%2Fproj");
  });

  it("creates a draft merge request with the Draft: prefix", async () => {
    const { gl, calls } = provider([["POST", `${API}/merge_requests`, json(mr(), 201)]]);
    const pr = await gl.createPullRequest({ title: "Fix it", body: "Body", head: "viberon/fix-it", base: "main" });
    expect(calls[0]!.body).toEqual({ source_branch: "viberon/fix-it", target_branch: "main", title: "Draft: Fix it", description: "Body" });
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(pr).toEqual({
      number: 7,
      title: "Fix it",
      body: "Body",
      url: "https://gitlab.com/grp/sub/proj/-/merge_requests/7",
      state: "open",
      draft: true,
      headBranch: "viberon/fix-it",
      headSha: "abc123",
      baseBranch: "main",
    });
  });

  it("creates a ready merge request without the prefix", async () => {
    const { gl, calls } = provider([["POST", `${API}/merge_requests`, json(mr({ title: "Fix it", draft: false }), 201)]]);
    await gl.createPullRequest({ title: "Fix it", body: "", head: "b", base: "main", draft: false });
    expect((calls[0]!.body as { title: string }).title).toBe("Fix it");
  });

  it("finds the open MR for a branch", async () => {
    const url = `${API}/merge_requests?state=opened&source_branch=viberon%2Ffix-it`;
    const { gl, calls } = provider([["GET", url, json([mr()])]]);
    expect((await gl.findOpenPullRequest("viberon/fix-it"))?.number).toBe(7);
    expect(calls[0]!.url).toBe(url);
    const empty = provider([["GET", url, json([])]]);
    expect(await empty.gl.findOpenPullRequest("viberon/fix-it")).toBeNull();
  });

  it("updates an MR and keeps it a draft", async () => {
    const { gl, calls } = provider([
      ["GET", `${API}/merge_requests/7`, json(mr())],
      ["PUT", `${API}/merge_requests/7`, json(mr({ title: "Draft: Better" }))],
    ]);
    await gl.updatePullRequest(7, { title: "Better", body: "v2" });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${API}/merge_requests/7`, `PUT ${API}/merge_requests/7`]);
    expect(calls[1]!.body).toEqual({ title: "Draft: Better", description: "v2" });
  });

  it("maps MR states", async () => {
    const { gl } = provider([
      ["GET", `${API}/merge_requests/1`, json(mr({ iid: 1, state: "merged", draft: false, title: "T" }))],
      ["GET", `${API}/merge_requests/2`, json(mr({ iid: 2, state: "closed", draft: false, work_in_progress: true, title: "WIP: T" }))],
    ]);
    expect(await gl.getPullRequest(1)).toMatchObject({ state: "merged", draft: false, title: "T" });
    expect(await gl.getPullRequest(2)).toMatchObject({ state: "closed", draft: true, title: "T" });
  });

  it("lists issues with state, order, page size and labels", async () => {
    const url = `${API}/issues?state=opened&order_by=updated_at&sort=desc&per_page=30&labels=viberon%2Cbug`;
    const { gl, calls } = provider([["GET", url, json([issue()])]]);
    const list = await gl.listIssues({ labels: ["viberon", "bug"], limit: 30 });
    expect(calls[0]!.url).toBe(url);
    expect(list).toEqual([
      {
        number: 5,
        title: "Crash",
        body: "Steps",
        url: "https://gitlab.com/grp/sub/proj/-/issues/5",
        state: "open",
        labels: ["bug", "viberon"],
        author: "rep",
        comments: 2,
        createdAt: "2026-09-01T00:00:00Z",
        updatedAt: "2026-09-02T00:00:00Z",
      },
    ]);
    const all = provider([["GET", `${API}/issues?order_by=updated_at&sort=desc&per_page=50`, json([])]]);
    await all.gl.listIssues({ state: "all" });
    expect(all.calls[0]!.url).toBe(`${API}/issues?order_by=updated_at&sort=desc&per_page=50`);
  });

  it("gets an issue and its human notes, oldest first", async () => {
    const notes = `${API}/issues/5/notes?sort=asc&order_by=created_at&per_page=20`;
    const { gl, calls } = provider([
      ["GET", `${API}/issues/5`, json(issue({ state: "closed", description: null }))],
      [
        "GET",
        notes,
        json([
          { id: 1, body: "changed the description", system: true, author: { username: "bot" } },
          { id: 2, body: "Still broken", system: false, author: { username: "maint" } },
        ]),
      ],
    ]);
    expect(await gl.getIssue(5)).toMatchObject({ number: 5, state: "closed", body: "" });
    expect(await gl.listIssueComments(5)).toEqual([{ body: "Still broken", author: "maint" }]);
    expect(calls[1]!.url).toBe(notes);
  });

  it("comments on issues and merge requests", async () => {
    const { gl, calls } = provider([
      ["POST", `${API}/issues/5/notes`, json({ id: 11, body: "hi" }, 201)],
      ["POST", `${API}/merge_requests/7/notes`, json({ id: 12, body: "hi" }, 201)],
    ]);
    expect(await gl.createComment({ kind: "issue", number: 5 }, "hi")).toEqual({
      id: "11",
      url: "https://gitlab.com/grp/sub/proj/-/issues/5#note_11",
    });
    expect((await gl.createComment({ kind: "pr", number: 7 }, "hi")).url).toBe("https://gitlab.com/grp/sub/proj/-/merge_requests/7#note_12");
    expect(calls.map((c) => c.body)).toEqual([{ body: "hi" }, { body: "hi" }]);
  });

  it("reads files (URL-encoded path, explicit or default ref) and returns null on 404", async () => {
    const { gl, calls } = provider([
      ["GET", `${API}/repository/files/src%2Fa%20b.py/raw?ref=dev`, new Response("print(1)\n")],
      ["GET", API, json({ default_branch: "main" })],
      ["GET", `${API}/repository/files/missing.txt/raw?ref=main`, json({ message: "404 File Not Found" }, 404)],
    ]);
    expect(await gl.getFileContent("src/a b.py", "dev")).toBe("print(1)\n");
    expect(await gl.getFileContent("missing.txt")).toBeNull();
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/repository/files/src%2Fa%20b.py/raw?ref=dev`,
      API,
      `${API}/repository/files/missing.txt/raw?ref=main`,
    ]);
  });

  it("creates a branch; moving one is unsupported", async () => {
    const { gl, calls } = provider([["POST", `${API}/repository/branches`, json({ name: "b" }, 201)]]);
    await gl.createBranch("viberon/x", "abc");
    expect(calls[0]!.body).toEqual({ branch: "viberon/x", ref: "abc" });
    expect(gl.capabilities.updateBranch).toBe(false);
    const error = await gl.updateBranch().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitProviderError);
    expect((error as GitProviderError).code).toBe("unsupported");
  });

  it("reads CI from the commit's latest pipeline and its jobs; logs and retries jobs", async () => {
    const { gl, calls } = provider([
      ["GET", `${API}/pipelines?sha=abc123&order_by=id&sort=desc&per_page=1`, json([{ id: 99 }])],
      [
        "GET",
        `${API}/pipelines/99/jobs?per_page=100`,
        json([
          { id: 1, name: "test", status: "failed", web_url: "https://gitlab.com/j/1" },
          { id: 2, name: "lint", status: "failed", allow_failure: true, web_url: "https://gitlab.com/j/2" },
          { id: 3, name: "build", status: "running", web_url: "https://gitlab.com/j/3" },
        ]),
      ],
      ["GET", `${API}/jobs/1/trace`, new Response("FAILED test_x\n")],
      ["POST", `${API}/jobs/1/retry`, json({ id: 4 }, 201)],
    ]);
    expect(await gl.listChecks("abc123")).toEqual([
      { name: "test", status: "completed", conclusion: "failure", url: "https://gitlab.com/j/1", jobId: "1" },
      { name: "lint", status: "completed", conclusion: "neutral", url: "https://gitlab.com/j/2", jobId: "2" },
      { name: "build", status: "in_progress", conclusion: null, url: "https://gitlab.com/j/3", jobId: "3" },
    ]);
    expect(await gl.getCheckLog("1")).toBe("FAILED test_x\n");
    await gl.rerunCheck("1");
    expect(calls.at(-1)).toMatchObject({ method: "POST", url: `${API}/jobs/1/retry`, body: undefined });
  });

  it("no pipeline yet means no checks", async () => {
    const { gl } = provider([["GET", `${API}/pipelines?sha=abc&order_by=id&sort=desc&per_page=1`, json([])]]);
    expect(await gl.listChecks("abc")).toEqual([]);
  });

  it("maps every job status", () => {
    expect(mapJobStatus({ status: "success" })).toEqual({ status: "completed", conclusion: "success" });
    expect(mapJobStatus({ status: "canceled" })).toEqual({ status: "completed", conclusion: "cancelled" });
    expect(mapJobStatus({ status: "skipped" })).toEqual({ status: "completed", conclusion: "skipped" });
    expect(mapJobStatus({ status: "manual" })).toEqual({ status: "completed", conclusion: "skipped" });
    for (const s of ["created", "pending", "preparing", "scheduled", "waiting_for_resource"]) {
      expect(mapJobStatus({ status: s })).toEqual({ status: "queued", conclusion: null });
    }
  });

  it("turns API errors into actionable messages without the token", async () => {
    const { gl } = provider([["GET", API, json({ message: "401 Unauthorized" }, 401)]]);
    const error = (await gl.getDefaultBranch().catch((e: unknown) => e)) as GitProviderError;
    expect(error).toBeInstanceOf(GitProviderError);
    expect(error.status).toBe(401);
    expect(error.platform).toBe("gitlab");
    expect(error.message).toMatch(/GitLab GET \/projects\/grp%2Fsub%2Fproj → 401: 401 Unauthorized\. Check the GitLab credentials/);
    expect(error.message).not.toContain(TOKEN);
    const anon = provider([["GET", API, json({ message: "404 Project Not Found" }, 404)]], null);
    expect(((await anon.gl.getDefaultBranch().catch((e: unknown) => e)) as Error).message).toMatch(/Add GitLab credentials/);
  });

  it("scopes git auth to the instance root over https, as oauth2 basic auth", () => {
    const { gl } = provider([]);
    const env = gl.gitAuthEnv("https://gitlab.com/grp/sub/proj.git");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://gitlab.com/.extraheader");
    expect(Buffer.from(env.GIT_CONFIG_VALUE_0!.replace("AUTHORIZATION: basic ", ""), "base64").toString()).toBe(`oauth2:${TOKEN}`);
    expect(gl.gitAuthEnv("git@gitlab.com:grp/sub/proj.git")).toEqual({});
    expect(gl.gitAuthEnv("https://evil.example/grp/sub/proj.git")).toEqual({});
    expect(gl.gitAuthEnv("http://gitlab.com/grp/sub/proj.git")).toEqual({});
    expect(gl.gitAuthEnv("https://u:pw@gitlab.com/grp/sub/proj.git")).toEqual({});
    const self = new GitLabProvider({ ...REPO, host: "corp.example", baseUrl: "https://corp.example/gitlab" }, TOKEN);
    expect(self.gitAuthEnv("https://corp.example/gitlab/grp/sub/proj.git").GIT_CONFIG_KEY_0).toBe("http.https://corp.example/gitlab/.extraheader");
    expect(self.gitAuthEnv("https://corp.example/other/grp/proj.git")).toEqual({});
    expect(new GitLabProvider(REPO, null).gitAuthEnv("https://gitlab.com/grp/sub/proj.git")).toEqual({});
  });

  it("closing reference and URLs", () => {
    const { gl } = provider([]);
    expect(gl.closingReference({ repo: REPO, kind: "issue", number: 5 })).toBe("Closes grp/sub/proj#5");
    expect(gl.issueUrl(5)).toBe("https://gitlab.com/grp/sub/proj/-/issues/5");
    expect(gl.pullRequestUrl(7)).toBe("https://gitlab.com/grp/sub/proj/-/merge_requests/7");
    expect(gl.secrets()).toEqual([TOKEN]);
  });
});
