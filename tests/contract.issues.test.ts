/**
 * The Issues panel and the issues routes, built in parallel: feed the
 * server's real responses into the client's real readers.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { issuesError as serverError } from "@/app/api/issues/errors";
import { issueStatus, issuesError as clientError, normalizeIssues } from "@/lib/client/issues";
import { GitHubApiError } from "@/lib/github-api";
import { IssuesError } from "@/lib/issues";
import { resetMemoryStoreForTests } from "@/lib/store";

afterEach(() => vi.unstubAllEnvs());

async function roundTrip(error: unknown) {
  const res = await serverError(error);
  return clientError(await res.json(), res.status);
}

describe("client ↔ issues routes", () => {
  it("a private repo without a token becomes the Settings prompt", async () => {
    resetMemoryStoreForTests();
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const mapped = await roundTrip(new GitHubApiError("GitHub GET /repos/o/r/issues → 404: Not Found", 404));
    expect(mapped.kind).toBe("token");
  });

  it("workspace problems keep their codes", async () => {
    expect((await roundTrip(new IssuesError("x", "no_github_remote"))).kind).toBe("no_github_remote");
    expect((await roundTrip(new IssuesError("x", "no_folder"))).kind).toBe("no_folder");
  });

  it("reads the list shape and task states the server returns", () => {
    const list = normalizeIssues({
      repo: { owner: "o", repo: "r" },
      issues: [
        { number: 7, title: "t", url: "https://github.com/o/r/issues/7", labels: ["bug"], author: "a", comments: 1, updatedAt: "2026-09-27T00:00:00Z", task: { id: "1", state: "done", prUrl: "https://github.com/o/r/pull/12" } },
        { number: 8, title: "u", url: "https://github.com/o/r/issues/8", labels: [], author: null, comments: 0, updatedAt: "2026-09-27T00:00:00Z", task: { id: "2", state: "done", note: "Not delivered: no check proved the change." } },
      ],
      watch: { enabled: true, label: "viberon", intervalMinutes: 15, handledIssues: [7], handled: 1 },
    });
    expect(list.issues.map((i) => i.number)).toEqual([7, 8]);
    expect(issueStatus(list.issues[0]!.task).kind).toBe("done");
    expect(issueStatus(list.issues[1]!.task).kind).toBe("not_delivered");
  });
});
