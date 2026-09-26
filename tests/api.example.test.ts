import { beforeEach, describe, expect, it } from "vitest";
import { POST as postRepo } from "@/app/api/repos/route";
import { PUT as putFile } from "@/app/api/repos/files/[repoKey]/route";
import { GET as getStatus } from "@/app/api/repos/[jobId]/status/route";
import {
  getGraph,
  putFileInfo,
  putGraph,
  putRawFiles,
  resetMemoryStoreForTests,
} from "@/lib/store";
import { repoKey as makeRepoKey } from "@/lib/ids";
import { parseRepo } from "@/lib/parser";

async function responseText(response: Response): Promise<string> {
  return response.text();
}

describe("api contracts", () => {
  beforeEach(() => {
    delete process.env.FIREBASE_PROJECT_ID;
    delete process.env.FIREBASE_CLIENT_EMAIL;
    delete process.env.FIREBASE_PRIVATE_KEY;
    resetMemoryStoreForTests();
  });

  it("cached real GitHub repo returns 202 and status returns graph", async () => {
    const repoRef = "vercel/next.js@canary";
    const repoKey = makeRepoKey(repoRef);
    const parsed = parseRepo(
      [{ path: "src/app.ts", source: "export function createApp() {\n  return true;\n}\n" }],
      repoRef,
    );
    await putGraph(repoKey, parsed.graph);

    const response = await postRepo(
      new Request("http://localhost/api/repos", {
        method: "POST",
        body: JSON.stringify({ url: "https://github.com/vercel/next.js/tree/canary" }),
      }),
    );
    expect(response.status).toBe(202);
    const body = (await response.json()) as { jobId: string; repoKey: string };
    expect(body.jobId).toBeTruthy();
    expect(body.repoKey).toBe(repoKey);

    const status = await getStatus(new Request(`http://localhost/api/repos/${body.jobId}/status`), {
      params: Promise.resolve({ jobId: body.jobId }),
    });
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.status).toBe("succeeded");
    expect(statusBody.graph.nodes.length).toBeGreaterThan(0);
  });

  it("invalid GitHub URL returns 400", async () => {
    const response = await postRepo(
      new Request("http://localhost/api/repos", {
        method: "POST",
        body: JSON.stringify({ url: "https://gitlab.com/mock/repo" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("unknown job returns 404", async () => {
    const response = await getStatus(new Request("http://localhost/api/repos/missing/status"), {
      params: Promise.resolve({ jobId: "missing" }),
    });
    expect(response.status).toBe(404);
  });

  it("agent run against a missing workspace streams a usable error", async () => {
    const { POST: postAgent } = await import("@/app/api/agent/route");
    const response = await postAgent(
      new Request("http://localhost/api/agent", {
        method: "POST",
        body: JSON.stringify({ repoKey: "missing", prompt: "what calls createApp?" }),
      }),
    );

    // The stream always opens with 200 — failures arrive as SSE events so the
    // UI can render them inline rather than as a dead request. With no
    // credentials configured the first thing back must be an actionable
    // message, not a provider stack trace.
    expect(response.status).toBe(200);
    const body = await responseText(response);
    expect(body).toContain("No API key configured");
    expect(body).toContain("Settings");
  });

  it("agent rejects a request with no prompt", async () => {
    const { POST: postAgent } = await import("@/app/api/agent/route");
    const response = await postAgent(
      new Request("http://localhost/api/agent", {
        method: "POST",
        body: JSON.stringify({ repoKey: "anything" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it("saving a file refreshes the graph memory used by later chat and agent searches", async () => {
    const repoKey = "editable";
    const original = "export function oldName() {\n  return 1;\n}\n";
    const updated = "export function newName() {\n  return 2;\n}\n";
    const parsed = parseRepo([{ path: "src/editable.ts", source: original }], "owner/repo@main");

    await putGraph(repoKey, parsed.graph);
    await putFileInfo(repoKey, [{ path: "src/editable.ts", tokenCount: 12 }]);
    await putRawFiles(repoKey, [{ path: "src/editable.ts", source: original }]);

    const response = await putFile(
      new Request("http://localhost/api/repos/files/editable?path=src/editable.ts", {
        method: "PUT",
        body: JSON.stringify({ source: updated }),
      }),
      { params: Promise.resolve({ repoKey }) },
    );

    expect(response.status).toBe(200);
    const graph = await getGraph(repoKey);
    expect(graph?.nodes.map((node) => node.name)).toEqual(["newName"]);
    expect(graph?.nodes[0]?.snippet).toContain("return 2");
  });
});
