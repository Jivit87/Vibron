/** Remote and web URL detection for GitHub, GitLab (incl. self-hosted, nested groups) and Bitbucket. */

import { describe, expect, it } from "vitest";

import {
  closingReference,
  cloneUrlFor,
  detectRemote,
  itemWebUrl,
  normalizeBaseUrl,
  parseIssueItemUrl,
  parseItemUrl,
  parsePullRequestItemUrl,
  parseRepoWebUrl,
  type HostConfig,
} from "@/lib/git-providers/detect";
import type { RepoLocator } from "@/lib/git-providers/interface";

const gh = (owner: string, repo: string): RepoLocator => ({ platform: "github", host: "github.com", baseUrl: "https://github.com", owner, repo });
const gl = (owner: string, repo: string, baseUrl = "https://gitlab.com"): RepoLocator => ({
  platform: "gitlab",
  host: new URL(baseUrl).hostname,
  baseUrl,
  owner,
  repo,
});
const bb = (owner: string, repo: string): RepoLocator => ({ platform: "bitbucket", host: "bitbucket.org", baseUrl: "https://bitbucket.org", owner, repo });

const SELF: HostConfig = { gitlabBaseUrls: ["https://git.corp.example"] };
const PREFIXED: HostConfig = { gitlabBaseUrls: ["https://corp.example/gitlab/"] };

describe("detectRemote", () => {
  it.each([
    ["https://github.com/o/r.git", gh("o", "r")],
    ["https://github.com/o/r", gh("o", "r")],
    ["https://github.com/o/r/", gh("o", "r")],
    ["http://github.com/o/r.git", gh("o", "r")],
    ["https://www.github.com/o/r.git", gh("o", "r")],
    ["git@github.com:o/r.git", gh("o", "r")],
    ["git@github.com:o/r", gh("o", "r")],
    ["ssh://git@github.com/o/r.git", gh("o", "r")],
    ["ssh://git@github.com:22/o/r.git", gh("o", "r")],
    ["git+ssh://git@github.com/o/r.git", gh("o", "r")],
    ["https://x-access-token@github.com/o/r.git", gh("o", "r")],
  ])("GitHub: %s", (remote, expected) => {
    expect(detectRemote(remote)).toEqual(expected);
  });

  it.each([
    ["https://gitlab.com/g/p.git", gl("g", "p")],
    ["https://gitlab.com/g/sub/p.git", gl("g/sub", "p")],
    ["https://gitlab.com/g/sub/deeper/p", gl("g/sub/deeper", "p")],
    ["git@gitlab.com:g/p.git", gl("g", "p")],
    ["git@gitlab.com:g/sub/p.git", gl("g/sub", "p")],
    ["ssh://git@gitlab.com/g/sub/p.git", gl("g/sub", "p")],
    ["ssh://git@gitlab.com:2222/g/sub/p.git", gl("g/sub", "p")],
  ])("GitLab: %s", (remote, expected) => {
    expect(detectRemote(remote)).toEqual(expected);
  });

  it.each([
    ["https://bitbucket.org/ws/repo.git", bb("ws", "repo")],
    ["https://jdoe@bitbucket.org/ws/repo.git", bb("ws", "repo")],
    ["git@bitbucket.org:ws/repo.git", bb("ws", "repo")],
    ["ssh://git@bitbucket.org/ws/repo.git", bb("ws", "repo")],
  ])("Bitbucket: %s", (remote, expected) => {
    expect(detectRemote(remote)).toEqual(expected);
  });

  it("recognizes a configured self-hosted GitLab (https, scp and ssh with a port)", () => {
    const want = gl("team/sub", "svc", "https://git.corp.example");
    expect(detectRemote("https://git.corp.example/team/sub/svc.git", SELF)).toEqual(want);
    expect(detectRemote("git@git.corp.example:team/sub/svc.git", SELF)).toEqual(want);
    expect(detectRemote("ssh://git@git.corp.example:2222/team/sub/svc.git", SELF)).toEqual(want);
    // Unconfigured, the same host is unknown.
    expect(detectRemote("https://git.corp.example/team/sub/svc.git")).toBeNull();
  });

  it("strips a self-hosted path prefix from https remotes, not from ssh ones", () => {
    const want = gl("team", "svc", "https://corp.example/gitlab");
    expect(detectRemote("https://corp.example/gitlab/team/svc.git", PREFIXED)).toEqual(want);
    expect(detectRemote("git@corp.example:team/svc.git", PREFIXED)).toEqual(want);
    // Outside the prefix: not this instance.
    expect(detectRemote("https://corp.example/other/team/svc.git", PREFIXED)).toBeNull();
  });

  it("treats gitlab.* hosts as GitLab without configuration", () => {
    expect(detectRemote("https://gitlab.example.org/a/b/c.git")).toEqual(gl("a/b", "c", "https://gitlab.example.org"));
  });

  it.each([
    "",
    "   ",
    "/tmp/repo.git",
    "../repo",
    "file:///tmp/repo.git",
    "https://example.com/o/r.git",
    "https://github.com/o",
    "https://github.com/o/r/extra",
    "https://bitbucket.org/ws",
    "https://gitlab.com/onlygroup",
    "git@github.com:o/r/extra.git",
    "https://github.com/-o/r",
    "https://github.com/o/..",
    "-c core.sshCommand=x",
    "ext::sh -c x",
    "https://github.com/o/r x",
  ])("rejects %j", (remote) => {
    expect(detectRemote(remote)).toBeNull();
  });
});

describe("parseItemUrl", () => {
  it("GitHub issues and pull requests", () => {
    expect(parseItemUrl("https://github.com/o/r/issues/5")).toEqual({ repo: gh("o", "r"), kind: "issue", number: 5 });
    expect(parseItemUrl("https://github.com/o/r/pull/7/files")).toEqual({ repo: gh("o", "r"), kind: "pr", number: 7 });
    expect(parseItemUrl("https://github.com/o/r/issues/5#issuecomment-1")?.number).toBe(5);
  });

  it("GitLab issues, merge requests and work items, nested groups, legacy form", () => {
    expect(parseItemUrl("https://gitlab.com/g/sub/p/-/issues/5")).toEqual({ repo: gl("g/sub", "p"), kind: "issue", number: 5 });
    expect(parseItemUrl("https://gitlab.com/g/p/-/merge_requests/7/diffs")).toEqual({ repo: gl("g", "p"), kind: "pr", number: 7 });
    expect(parseItemUrl("https://gitlab.com/g/p/-/work_items/9")).toMatchObject({ kind: "issue", number: 9 });
    expect(parseItemUrl("https://gitlab.com/g/p/issues/3")).toMatchObject({ repo: gl("g", "p"), kind: "issue", number: 3 });
  });

  it("GitLab on a configured instance with a path prefix", () => {
    expect(parseItemUrl("https://corp.example/gitlab/team/svc/-/issues/2", PREFIXED)).toEqual({
      repo: gl("team", "svc", "https://corp.example/gitlab"),
      kind: "issue",
      number: 2,
    });
  });

  it("an unknown host with GitLab's `/-/` path is GitLab (detection only)", () => {
    expect(parseItemUrl("https://code.acme.io/a/b/-/merge_requests/4")).toEqual({
      repo: gl("a", "b", "https://code.acme.io"),
      kind: "pr",
      number: 4,
    });
    expect(parseItemUrl("https://code.acme.io/a/b/issues/4")).toBeNull();
  });

  it("Bitbucket issues (with title slug) and pull requests", () => {
    expect(parseItemUrl("https://bitbucket.org/ws/r/issues/12/crash-on-start")).toEqual({ repo: bb("ws", "r"), kind: "issue", number: 12 });
    expect(parseItemUrl("https://bitbucket.org/ws/r/pull-requests/3/diff")).toEqual({ repo: bb("ws", "r"), kind: "pr", number: 3 });
  });

  it("issue / PR filters", () => {
    expect(parseIssueItemUrl("https://gitlab.com/g/p/-/merge_requests/1")).toBeNull();
    expect(parsePullRequestItemUrl("https://gitlab.com/g/p/-/merge_requests/1")?.number).toBe(1);
    expect(parsePullRequestItemUrl("https://bitbucket.org/ws/r/issues/1")).toBeNull();
  });

  it.each([
    "https://github.com/o/r/issues/0",
    "https://github.com/o/r/issues/x",
    "https://github.com/o/r",
    "https://bitbucket.org/ws/r/pulls/1",
    "ftp://gitlab.com/g/p/-/issues/1",
    "not a url",
    "https://example.com/o/r/issues/1",
  ])("rejects %j", (value) => {
    expect(parseItemUrl(value)).toBeNull();
  });
});

describe("parseRepoWebUrl", () => {
  it("repository pages and refs", () => {
    expect(parseRepoWebUrl("https://gitlab.com/g/sub/p/-/tree/feature/x")).toEqual({ repo: gl("g/sub", "p"), ref: "feature/x" });
    expect(parseRepoWebUrl("https://gitlab.com/g/sub/p")).toEqual({ repo: gl("g/sub", "p") });
    expect(parseRepoWebUrl("https://bitbucket.org/ws/r/src/main/")).toEqual({ repo: bb("ws", "r"), ref: "main" });
    expect(parseRepoWebUrl("https://github.com/o/r/tree/dev")).toEqual({ repo: gh("o", "r"), ref: "dev" });
    expect(parseRepoWebUrl("https://u:p@gitlab.com/g/p")).toBeNull();
  });
});

describe("helpers", () => {
  it("normalizes base URLs", () => {
    expect(normalizeBaseUrl("Git.Corp.Example/")).toBe("https://git.corp.example");
    expect(normalizeBaseUrl("https://corp.example/gitlab/")).toBe("https://corp.example/gitlab");
    expect(normalizeBaseUrl("http://localhost:8080")).toBe("http://localhost:8080");
    expect(normalizeBaseUrl("ftp://x")).toBeNull();
    expect(normalizeBaseUrl("https://u:p@x")).toBeNull();
    expect(normalizeBaseUrl("")).toBeNull();
  });

  it("builds clone and item URLs", () => {
    expect(cloneUrlFor(gl("g/sub", "p"))).toBe("https://gitlab.com/g/sub/p.git");
    expect(itemWebUrl(gl("g/sub", "p"), "pr", 3)).toBe("https://gitlab.com/g/sub/p/-/merge_requests/3");
    expect(itemWebUrl(bb("ws", "r"), "pr", 3)).toBe("https://bitbucket.org/ws/r/pull-requests/3");
    expect(itemWebUrl(gh("o", "r"), "issue", 3)).toBe("https://github.com/o/r/issues/3");
  });

  it("closing references per platform", () => {
    expect(closingReference({ repo: gh("o", "r"), kind: "issue", number: 5 })).toBe("Fixes o/r#5");
    expect(closingReference({ repo: gl("g/sub", "p"), kind: "issue", number: 5 })).toBe("Closes g/sub/p#5");
    expect(closingReference({ repo: bb("ws", "r"), kind: "issue", number: 5 })).toBe("Fixes #5");
    expect(closingReference({ repo: bb("ws", "r"), kind: "issue", number: 5 }, bb("ws", "other"))).toBe(
      "Fixes https://bitbucket.org/ws/r/issues/5",
    );
  });
});
