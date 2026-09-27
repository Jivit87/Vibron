/**
 * GitHub no-regression: every GitHubProvider call sends exactly the request
 * the direct lib/github-api call sends (method, URL, headers, body), and
 * delivery / CI / issue reports through the provider layer hit the same
 * endpoints in the same order as before.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ciStatus, deliver, reportOnIssue } from "@/lib/deliver";
import { providerFor, providerForRemote } from "@/lib/git-providers/factory";
import { GitHubProvider, githubRepo } from "@/lib/git-providers/github";
import * as api from "@/lib/github-api";
import { buildGithubEntry } from "@/lib/mcp/github";
import { setGlobalEntry } from "@/lib/mcp/settings";
import { resetMemoryStoreForTests } from "@/lib/store";
import { gitAuthEnv } from "@/lib/workspace/clone";
import { fakeFetch, json, type Recorded } from "@/tests/helpers/fake-fetch";
import { makeTmpRepo, type TmpRepo } from "@/tests/helpers/tmp-repo";

const TOKEN = "ghp_TESTTOKEN";
const ID = { owner: "o", repo: "r" };
const PR = {
  number: 7,
  title: "T",
  body: "B",
  html_url: "https://github.com/o/r/pull/7",
  state: "open",
  draft: true,
  head: { ref: "viberon/x", sha: "abc" },
  base: { ref: "main" },
};
const ISSUE = {
  number: 5,
  title: "I",
  body: "b",
  html_url: "https://github.com/o/r/issues/5",
  state: "open",
  labels: [{ name: "bug" }],
  user: { login: "u" },
  comments: 1,
  created_at: "c",
  updated_at: "u",
};

/** One fake GitHub that answers every endpoint the adapter uses. */
function github() {
  return fakeFetch([
    ["GET", (r) => r.url === "https://api.github.com/repos/o/r", json({ default_branch: "main" })],
    ["GET", (r) => r.url.includes("/pulls?state=open"), json([PR])],
    ["GET", (r) => r.url.endsWith("/pulls/7"), json(PR)],
    ["POST", (r) => r.url.endsWith("/pulls"), json(PR, 201)],
    ["PATCH", (r) => r.url.endsWith("/pulls/7"), json(PR)],
    ["GET", (r) => r.url.includes("/issues?"), json([ISSUE, { ...ISSUE, number: 6, pull_request: {} }])],
    ["GET", (r) => r.url.endsWith("/issues/5"), json(ISSUE)],
    ["GET", (r) => r.url.includes("/issues/5/comments"), json([{ body: "c", user: { login: "m" } }])],
    ["POST", (r) => r.url.endsWith("/comments"), json({ id: 1, html_url: "https://github.com/o/r/issues/5#issuecomment-1" }, 201)],
    ["GET", (r) => r.url.includes("/contents/"), new Response("file text")],
    ["POST", (r) => r.url.endsWith("/git/refs"), json({}, 201)],
    ["PATCH", (r) => r.url.includes("/git/refs/heads/"), json({})],
    [
      "GET",
      (r) => r.url.includes("/check-runs"),
      json({
        check_runs: [
          { id: 9, name: "test", status: "completed", conclusion: "failure", html_url: "h", details_url: "https://github.com/o/r/actions/runs/1/job/9" },
        ],
      }),
    ],
    ["GET", (r) => r.url.endsWith("/logs"), new Response("log")],
    ["POST", (r) => r.url.endsWith("/rerun"), new Response(null, { status: 201 })],
  ]);
}

/** Requests without the per-call AbortSignal (a fresh object each time). */
const wire = (calls: Recorded[]) => calls.map(({ method, url, headers, body }) => ({ method, url, headers, body }));

describe("GitHubProvider sends exactly what github-api sends", () => {
  const cases: [string, (opts: api.ApiOptions) => Promise<unknown>, (p: GitHubProvider) => Promise<unknown>][] = [
    ["default branch", (o) => api.getDefaultBranch(ID, o), (p) => p.getDefaultBranch()],
    ["get PR", (o) => api.getPullRequest({ ...ID, number: 7 }, o), (p) => p.getPullRequest(7)],
    ["find PR", (o) => api.findOpenPullRequest(ID, "viberon/x", o), (p) => p.findOpenPullRequest("viberon/x")],
    [
      "create PR",
      (o) => api.createPullRequest(ID, { title: "T", body: "B", head: "h", base: "main", draft: true }, o),
      (p) => p.createPullRequest({ title: "T", body: "B", head: "h", base: "main" }),
    ],
    ["update PR", (o) => api.updatePullRequest({ ...ID, number: 7 }, { title: "T", body: "B" }, o), (p) => p.updatePullRequest(7, { title: "T", body: "B" })],
    ["list issues", (o) => api.listIssues(ID, { labels: ["bug"], limit: 30 }, o), (p) => p.listIssues({ labels: ["bug"], limit: 30 })],
    ["get issue", (o) => api.getIssue({ ...ID, number: 5 }, o), (p) => p.getIssue(5)],
    ["issue comments", (o) => api.listIssueComments({ ...ID, number: 5 }, 20, o), (p) => p.listIssueComments(5, 20)],
    ["comment", (o) => api.createIssueComment({ ...ID, number: 5 }, "hi", o), (p) => p.createComment({ kind: "issue", number: 5 }, "hi")],
    ["file", (o) => api.getFileContent(ID, "src/a.ts", "dev", o), (p) => p.getFileContent("src/a.ts", "dev")],
    ["create ref", (o) => api.createBranchRef(ID, "b", "abc", o), (p) => p.createBranch("b", "abc")],
    ["update ref", (o) => api.updateBranchRef(ID, "b", "abc", true, o), (p) => p.updateBranch("b", "abc", { force: true })],
    ["check runs", (o) => api.listCheckRuns(ID, "abc", o), (p) => p.listChecks("abc")],
    ["job log", (o) => api.getJobLogs(ID, 9, o), (p) => p.getCheckLog("9")],
    ["rerun", (o) => api.rerunJob(ID, 9, o), (p) => p.rerunCheck("9")],
  ];

  it.each(cases)("%s", async (_name, direct, viaProvider) => {
    const a = github();
    await direct({ token: TOKEN, fetchImpl: a.fetchImpl });
    const b = github();
    await viaProvider(new GitHubProvider(githubRepo(ID), { token: TOKEN, fetchImpl: b.fetchImpl }));
    expect(wire(b.calls)).toEqual(wire(a.calls));
    expect(b.calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Viberon" });
  });

  it("maps shapes without losing information", async () => {
    const p = new GitHubProvider(githubRepo(ID), { token: TOKEN, fetchImpl: github().fetchImpl });
    expect(await p.getPullRequest(7)).toEqual({
      number: 7,
      title: "T",
      body: "B",
      url: "https://github.com/o/r/pull/7",
      state: "open",
      draft: true,
      headBranch: "viberon/x",
      headSha: "abc",
      baseBranch: "main",
    });
    expect((await p.listIssues()).map((i) => i.number)).toEqual([5]);
    expect(await p.listChecks("abc")).toEqual([{ name: "test", status: "completed", conclusion: "failure", url: "h", jobId: "9" }]);
    expect(p.gitAuthEnv("https://github.com/o/r.git")).toEqual(gitAuthEnv(TOKEN, "https://github.com/o/r.git"));
    expect(p.closingReference({ repo: githubRepo(ID), kind: "issue", number: 5 })).toBe("Fixes o/r#5");
  });
});

describe("GitHub through the factory", () => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  beforeEach(() => {
    resetMemoryStoreForTests();
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("resolves the stored integration token, then GITHUB_TOKEN, exactly like resolveGithubToken", async () => {
    expect((await providerFor(githubRepo(ID))).authenticated).toBe(false);
    process.env.GITHUB_TOKEN = "env-token";
    expect((await providerFor(githubRepo(ID))).secrets()).toEqual(["env-token"]);
    await setGlobalEntry("github", buildGithubEntry({ mode: "remote", token: "stored", toolsets: [], readOnly: true, trusted: false }));
    const p = await providerForRemote("git@github.com:o/r.git");
    expect(p?.platform).toBe("github");
    expect(p?.secrets()).toEqual(["stored"]);
  });
});

describe("delivery, CI and reports hit the same GitHub endpoints as before", () => {
  let repo: TmpRepo;
  let bare: string;
  beforeEach(() => {
    resetMemoryStoreForTests();
    repo = makeTmpRepo({ "a.txt": "a\n" });
    repo.git("config", "user.name", "t");
    repo.git("config", "user.email", "t@t");
    bare = mkdtempSync(path.join(os.tmpdir(), "viberon-remote-"));
    execFileSync("git", ["init", "-q", "--bare", bare]);
    repo.git("remote", "add", "origin", "https://github.com/o/r.git");
    repo.git("config", `url.${bare}.insteadOf`, "https://github.com/o/r.git");
    repo.git("push", "-q", "origin", "HEAD:refs/heads/main");
  });
  afterEach(() => {
    repo.cleanup();
    rmSync(bare, { recursive: true, force: true });
  });

  it("deliver: default branch → find open PR → create draft PR", async () => {
    const gh = fakeFetch([
      ["GET", "https://api.github.com/repos/o/r", json({ default_branch: "main" })],
      ["GET", "https://api.github.com/repos/o/r/pulls?state=open&head=o%3Aviberon%2Ffix", json([])],
      ["POST", "https://api.github.com/repos/o/r/pulls", json({ number: 7, html_url: "https://github.com/o/r/pull/7" }, 201)],
    ]);
    repo.write("a.txt", "fixed\n");
    const out = await deliver({ root: repo.root, title: "Fix", body: "Body", token: TOKEN, fetchImpl: gh.fetchImpl });
    expect(out).toMatchObject({ prUrl: "https://github.com/o/r/pull/7", prNumber: 7, created: true, platform: "github" });
    expect(gh.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/o/r",
      "GET https://api.github.com/repos/o/r/pulls?state=open&head=o%3Aviberon%2Ffix",
      "POST https://api.github.com/repos/o/r/pulls",
    ]);
    expect(gh.calls[2]!.body).toEqual({ title: "Fix", body: "Body", head: "viberon/fix", base: "main", draft: true });
  });

  it("ciStatus and reportOnIssue", async () => {
    const gh = github();
    const status = await ciStatus({ prUrl: "https://github.com/o/r/pull/7" }, { token: TOKEN, fetchImpl: gh.fetchImpl });
    expect(status).toMatchObject({ headSha: "abc", state: "failure" });
    expect(gh.calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/o/r/pulls/7",
      "https://api.github.com/repos/o/r/commits/abc/check-runs?per_page=100",
      "https://api.github.com/repos/o/r/actions/jobs/9/logs",
    ]);
    const r = github();
    const out = await reportOnIssue(
      { issueUrl: "https://github.com/o/r/issues/5", prUrl: "o/r#7", summary: "s", evidence: { status: "resolved", filesChanged: [], checks: [] } },
      { token: TOKEN, fetchImpl: r.fetchImpl },
    );
    expect(out.commentUrl).toBe("https://github.com/o/r/issues/5#issuecomment-1");
    expect(r.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["POST https://api.github.com/repos/o/r/issues/5/comments"]);
  });
});
