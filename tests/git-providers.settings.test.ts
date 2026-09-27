/**
 * Credentials storage and resolution, the Settings route, the issue-intake
 * route, clone targets for GitLab/Bitbucket, and the factory's host scoping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as issueGet } from "@/app/api/issue/route";
import { DELETE as gitDelete, GET as gitGet, PUT as gitPut } from "@/app/api/settings/git/route";
import {
  getStoredGitLab,
  gitCredentialStatus,
  loadHostConfig,
  maskSecret,
  resolveBitbucket,
  resolveGitLab,
  setStoredBitbucket,
  setStoredGitLab,
} from "@/lib/git-providers/credentials";
import { providerFor, providerForRemote, providerForUrl } from "@/lib/git-providers/factory";
import { verifyBitbucket, verifyGitLabToken } from "@/lib/git-providers/verify";
import { resetMemoryStoreForTests } from "@/lib/store";
import { cloneDestination, parseCloneTarget } from "@/lib/workspace/clone";
import { fakeFetch, json } from "@/tests/helpers/fake-fetch";

const ENV = ["GITLAB_TOKEN", "GITLAB_URL", "BITBUCKET_TOKEN", "BITBUCKET_USERNAME", "BITBUCKET_APP_PASSWORD"];

beforeEach(() => {
  resetMemoryStoreForTests();
  for (const name of ENV) vi.stubEnv(name, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const put = (body: unknown) => gitPut(new Request("http://x/api/settings/git", { method: "PUT", body: JSON.stringify(body) }));

describe("credential resolution", () => {
  it("GitLab: stored, else GITLAB_TOKEN / GITLAB_URL, else anonymous gitlab.com", async () => {
    expect(await resolveGitLab()).toEqual({ token: null, baseUrl: "https://gitlab.com", fromEnv: false });
    vi.stubEnv("GITLAB_TOKEN", "env-tok");
    vi.stubEnv("GITLAB_URL", "https://git.corp.example/");
    expect(await resolveGitLab()).toEqual({ token: "env-tok", baseUrl: "https://git.corp.example", fromEnv: true });
    expect(await loadHostConfig()).toEqual({ gitlabBaseUrls: ["https://git.corp.example"] });
    await setStoredGitLab({ token: "stored-tok" });
    expect(await resolveGitLab()).toEqual({ token: "stored-tok", baseUrl: "https://gitlab.com", fromEnv: false });
    expect(await loadHostConfig()).toEqual({});
  });

  it("Bitbucket: stored, else BITBUCKET_TOKEN, else username + app password", async () => {
    expect(await resolveBitbucket()).toBeNull();
    vi.stubEnv("BITBUCKET_USERNAME", "u");
    vi.stubEnv("BITBUCKET_APP_PASSWORD", "p");
    expect(await resolveBitbucket()).toEqual({ kind: "basic", username: "u", password: "p", fromEnv: true });
    vi.stubEnv("BITBUCKET_TOKEN", "t");
    expect(await resolveBitbucket()).toEqual({ kind: "bearer", token: "t", fromEnv: true });
    await setStoredBitbucket({ mode: "basic", username: "jdoe", appPassword: "ATBBx" });
    expect(await resolveBitbucket()).toEqual({ kind: "basic", username: "jdoe", password: "ATBBx", fromEnv: false });
  });

  it("status is masked", async () => {
    await setStoredGitLab({ token: "glpat-abcdefgh1234" });
    await setStoredBitbucket({ mode: "bearer", token: "ATCTTsecretXYZ9" });
    const status = await gitCredentialStatus();
    expect(status.gitlab).toEqual({ configured: true, masked: "glpat-••••1234", baseUrl: "https://gitlab.com", fromEnv: false });
    expect(status.bitbucket).toEqual({ configured: true, masked: "ATCTT••••XYZ9", mode: "bearer", username: null, fromEnv: false });
    expect(JSON.stringify(status)).not.toContain("abcdefgh");
    expect(maskSecret("")).toBe("");
  });
});

describe("factory host scoping", () => {
  it("attaches the GitLab token only to the configured instance", async () => {
    await setStoredGitLab({ token: "tok", baseUrl: "https://git.corp.example" });
    expect((await providerForRemote("git@git.corp.example:team/svc.git"))?.authenticated).toBe(true);
    expect((await providerForRemote("https://gitlab.com/team/svc.git"))?.authenticated).toBe(false);
    expect((await providerForRemote("https://gitlab.other.org/team/svc.git"))?.authenticated).toBe(false);
    // An explicit token is the caller's decision.
    expect((await providerForRemote("https://gitlab.com/team/svc.git", { token: "x" }))?.secrets()).toEqual(["x"]);
    expect(await providerForRemote("/local/path")).toBeNull();
  });

  it("Bitbucket credentials go to bitbucket.org only; an explicit token is a bearer token", async () => {
    await setStoredBitbucket({ mode: "basic", username: "jdoe", appPassword: "ATBBx" });
    const found = await providerForUrl("https://bitbucket.org/ws/r/issues/3");
    expect(found?.item).toMatchObject({ kind: "issue", number: 3 });
    expect(found?.provider.gitAuthEnv("https://bitbucket.org/ws/r.git").GIT_CONFIG_KEY_0).toBe("http.https://bitbucket.org/.extraheader");
    const explicit = await providerFor(found!.item.repo, { token: "ATCTT1" });
    expect(explicit.secrets()).toEqual(["ATCTT1"]);
    expect((await providerFor(found!.item.repo, { token: null })).authenticated).toBe(false);
  });
});

describe("credential verification", () => {
  it("GitLab: GET /api/v4/user with PRIVATE-TOKEN", async () => {
    const ok = fakeFetch([["GET", "https://git.corp.example/api/v4/user", json({ username: "me" })]]);
    expect(await verifyGitLabToken("tok", "https://git.corp.example/", ok.fetchImpl)).toEqual({ ok: true, login: "me" });
    expect(ok.calls[0]!.headers["PRIVATE-TOKEN"]).toBe("tok");
    const bad = fakeFetch([["GET", "https://gitlab.com/api/v4/user", json({}, 401)]]);
    expect(await verifyGitLabToken("tok", "https://gitlab.com", bad.fetchImpl)).toMatchObject({ ok: false, error: expect.stringContaining("401") });
  });

  it("Bitbucket: basic must read /user; a bearer access token may get 403 there", async () => {
    const user = "https://api.bitbucket.org/2.0/user";
    const basic = fakeFetch([["GET", user, json({ username: "jdoe" })]]);
    expect(await verifyBitbucket({ kind: "basic", username: "jdoe", password: "p" }, basic.fetchImpl)).toEqual({ ok: true, login: "jdoe" });
    expect(basic.calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from("jdoe:p").toString("base64")}`);
    const forbidden = fakeFetch([["GET", user, json({}, 403)]]);
    expect((await verifyBitbucket({ kind: "bearer", token: "t" }, forbidden.fetchImpl)).ok).toBe(true);
    expect((await verifyBitbucket({ kind: "basic", username: "u", password: "p" }, forbidden.fetchImpl)).ok).toBe(false);
    const rejected = fakeFetch([["GET", user, json({}, 401)]]);
    expect((await verifyBitbucket({ kind: "bearer", token: "t" }, rejected.fetchImpl)).ok).toBe(false);
  });
});

describe("/api/settings/git", () => {
  it("saves a verified GitLab token for a self-hosted URL and never returns it", async () => {
    const fake = fakeFetch([["GET", "https://git.corp.example/api/v4/user", json({ username: "me" })]]);
    vi.stubGlobal("fetch", fake.fetchImpl);
    const response = await put({ platform: "gitlab", token: "glpat-secret9999", baseUrl: "git.corp.example" });
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, login: "me", gitlab: { configured: true, baseUrl: "https://git.corp.example" } });
    expect(JSON.stringify(body)).not.toContain("glpat-secret9999");
    expect(await getStoredGitLab()).toEqual({ token: "glpat-secret9999", baseUrl: "https://git.corp.example" });

    // Changing the URL alone must not move the stored token to a new host.
    const moved = await put({ platform: "gitlab", baseUrl: "https://elsewhere.example" });
    expect(moved.status).toBe(400);
    expect(fake.calls).toHaveLength(1);

    const got = (await (await gitGet()).json()) as { gitlab: { masked: string } };
    expect(got.gitlab.masked).toBe("glpat-••••9999");
    await gitDelete(new Request("http://x/api/settings/git?platform=gitlab", { method: "DELETE" }));
    expect(await getStoredGitLab()).toBeNull();
  });

  it("rejects bad input and failed verification", async () => {
    vi.stubGlobal("fetch", fakeFetch([["GET", "https://gitlab.com/api/v4/user", json({}, 401)]]).fetchImpl);
    expect((await put({ platform: "gitlab", token: "bad" })).status).toBe(400);
    expect((await put({ platform: "gitlab", token: "x", baseUrl: "http://plain.example" })).status).toBe(400);
    expect((await put({ platform: "gitlab", token: "has space" })).status).toBe(400);
    expect((await put({ platform: "bitbucket", mode: "basic", username: "a:b", appPassword: "p" })).status).toBe(400);
    expect((await put({ platform: "bitbucket", mode: "other" })).status).toBe(400);
    expect((await put({ platform: "github", token: "x" })).status).toBe(400);
    expect((await gitDelete(new Request("http://x/api/settings/git?platform=nope", { method: "DELETE" }))).status).toBe(400);
    expect(await getStoredGitLab()).toBeNull();
  });

  it("saves Bitbucket app password and access token credentials", async () => {
    vi.stubGlobal("fetch", fakeFetch([["GET", "https://api.bitbucket.org/2.0/user", json({ username: "jdoe" })]]).fetchImpl);
    const basic = (await (await put({ platform: "bitbucket", mode: "basic", username: "jdoe", appPassword: "ATBBpw1234" })).json()) as {
      bitbucket: Record<string, unknown>;
    };
    expect(basic.bitbucket).toMatchObject({ configured: true, mode: "basic", username: "jdoe", masked: "ATBB••••1234" });
    // Same user, empty password: keeps the stored one.
    expect((await put({ platform: "bitbucket", mode: "basic", username: "jdoe" })).status).toBe(200);
    expect(await resolveBitbucket()).toMatchObject({ kind: "basic", password: "ATBBpw1234" });
    const bearer = await put({ platform: "bitbucket", mode: "bearer", token: "ATCTTtok5678", skipVerify: true });
    expect(((await bearer.json()) as { bitbucket: { mode: string } }).bitbucket.mode).toBe("bearer");
  });
});

describe("GET /api/issue for GitLab and Bitbucket", () => {
  it("fetches a GitLab issue with the stored token", async () => {
    await setStoredGitLab({ token: "tok" });
    const fake = fakeFetch([
      [
        "GET",
        "https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/issues/4",
        json({ iid: 4, title: "Bug", description: "Details", web_url: "https://gitlab.com/g/sub/p/-/issues/4", state: "opened", labels: [], author: null, created_at: "", updated_at: "" }),
      ],
    ]);
    vi.stubGlobal("fetch", fake.fetchImpl);
    const response = await issueGet(new Request(`http://x/api/issue?url=${encodeURIComponent("https://gitlab.com/g/sub/p/-/issues/4")}`));
    expect(await response.json()).toEqual({ title: "Bug", body: "Details", url: "https://gitlab.com/g/sub/p/-/issues/4" });
    expect(fake.calls[0]!.headers["PRIVATE-TOKEN"]).toBe("tok");
  });

  it("fetches a Bitbucket pull request, maps 404, rejects other URLs", async () => {
    const fake = fakeFetch([
      [
        "GET",
        "https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests/2",
        json({ id: 2, title: "PR", description: "D", state: "OPEN", source: { branch: { name: "b" } }, destination: { branch: { name: "main" } }, links: { html: { href: "https://bitbucket.org/ws/r/pull-requests/2" } } }),
      ],
    ]);
    vi.stubGlobal("fetch", fake.fetchImpl);
    const ok = await issueGet(new Request(`http://x/api/issue?url=${encodeURIComponent("https://bitbucket.org/ws/r/pull-requests/2")}`));
    expect(await ok.json()).toEqual({ title: "PR", body: "D", url: "https://bitbucket.org/ws/r/pull-requests/2" });
    const missing = await issueGet(new Request(`http://x/api/issue?url=${encodeURIComponent("https://bitbucket.org/ws/r/issues/99")}`));
    expect(missing.status).toBe(404);
    const bad = await issueGet(new Request(`http://x/api/issue?url=${encodeURIComponent("https://example.com/a/b/issues/1")}`));
    expect(bad.status).toBe(400);
  });
});

describe("clone targets", () => {
  it("GitLab nested groups, issue URLs, tree pages, scp and ssh", () => {
    expect(parseCloneTarget("https://gitlab.com/g/sub/p")).toMatchObject({ cloneUrl: "https://gitlab.com/g/sub/p.git", owner: "g/sub", name: "p" });
    expect(parseCloneTarget("https://gitlab.com/g/sub/p/-/tree/dev")).toMatchObject({ cloneUrl: "https://gitlab.com/g/sub/p.git", name: "p" });
    expect(parseCloneTarget("https://gitlab.com/g/sub/p/-/issues/3")).toMatchObject({
      cloneUrl: "https://gitlab.com/g/sub/p.git",
      issueUrl: "https://gitlab.com/g/sub/p/-/issues/3",
    });
    expect(parseCloneTarget("https://gitlab.com/g/p/-/merge_requests/3")?.issueUrl).toBeUndefined();
    expect(parseCloneTarget("git@gitlab.com:g/sub/p.git")).toMatchObject({ cloneUrl: "git@gitlab.com:g/sub/p.git", owner: "g/sub", name: "p" });
    expect(parseCloneTarget("https://git.corp.example/team/sub/svc", { hosts: { gitlabBaseUrls: ["https://git.corp.example"] } })).toMatchObject({
      cloneUrl: "https://git.corp.example/team/sub/svc.git",
      owner: "team/sub",
    });
  });

  it("Bitbucket: drops the user name from https clone URLs; issue URLs", () => {
    expect(parseCloneTarget("https://jdoe@bitbucket.org/ws/r.git")).toMatchObject({ cloneUrl: "https://bitbucket.org/ws/r.git", owner: "ws", name: "r" });
    expect(parseCloneTarget("https://bitbucket.org/ws/r/src/main/")?.cloneUrl).toBe("https://bitbucket.org/ws/r.git");
    expect(parseCloneTarget("https://bitbucket.org/ws/r/issues/8/title")).toMatchObject({ issueUrl: "https://bitbucket.org/ws/r/issues/8/title" });
  });

  it("still rejects credentials and injection on hosted URLs", () => {
    expect(parseCloneTarget("https://u:pw@gitlab.com/g/p.git")).toBeNull();
    expect(parseCloneTarget("https://u:pw@bitbucket.org/ws/r.git")).toBeNull();
    expect(parseCloneTarget("https://gitlab.com/g/p;rm -rf ~")).toBeNull();
    expect(parseCloneTarget("https://gitlab.com/-g/p")).toBeNull();
  });

  it("flattens nested groups into one directory", () => {
    const target = parseCloneTarget("https://gitlab.com/g/sub/p")!;
    expect(cloneDestination(target, "/repos")).toBe("/repos/g__sub__p");
  });
});
