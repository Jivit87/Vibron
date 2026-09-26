import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import type { Graph } from "@/lib/graph";
import { resetMemoryStoreForTests } from "@/lib/store";

/**
 * Property 5: Cache idempotence on ingestion.
 *
 * For any repoRef whose graph is already present in the store, a fresh
 * POST /api/repos for that repoRef must:
 *   1. resolve to a job with status="succeeded" and progress=100
 *   2. NOT call fetchTarball
 *   3. NOT call parseRepo
 *   4. return a graph that deep-equals the cached graph
 *
 * The route imports fetchTarball indirectly via lib/ingest. We mock both
 * lib/github (fetchTarball) and lib/parser (parseRepo) with spies and prove
 * neither fires across the iterations.
 */

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    fetchTarball: vi.fn(async () => {
      throw new Error("fetchTarball should not be invoked when graph is cached");
    }),
  };
});

vi.mock("@/lib/parser", async () => {
  const actual = await vi.importActual<typeof import("@/lib/parser")>("@/lib/parser");
  return {
    ...actual,
    parseRepo: vi.fn(() => {
      throw new Error("parseRepo should not be invoked when graph is cached");
    }),
  };
});

const { fetchTarball } = await import("@/lib/github");
const { parseRepo } = await import("@/lib/parser");
const { POST: postRepo } = await import("@/app/api/repos/route");
const { GET: getStatus } = await import("@/app/api/repos/[jobId]/status/route");
const { repoKey: makeRepoKey } = await import("@/lib/ids");
const { putGraph } = await import("@/lib/store");
const { toRepoRef } = await import("@/lib/github");

function buildCachedGraph(repoRef: string, salt: string): Graph {
  return {
    nodes: [
      {
        id: `id-${salt}-1`,
        kind: "function",
        name: `alpha_${salt}`,
        file: `src/${salt}.ts`,
        folder: "src",
        loc: 5,
        signature: `function alpha_${salt}()`,
        snippet: `function alpha_${salt}() { return 1; }`,
        startLine: 1,
        endLine: 5,
      },
    ],
    edges: [],
    meta: { repoRef, parsedAt: 1, fileCount: 1 },
  };
}

const ownerArb = fc.constantFrom("alpha", "beta", "gamma", "delta");
const repoArb = fc.constantFrom("one", "two", "three", "four");
const refArb = fc.constantFrom("main", "master", "develop");
const saltArb = fc.constantFrom("aa", "bb", "cc", "dd");

describe("ingest properties", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetMemoryStoreForTests();
    vi.mocked(fetchTarball).mockClear();
    vi.mocked(parseRepo).mockClear();
  });

  afterEach(() => {
    resetMemoryStoreForTests();
  });

  it("Feature: viberon, Property 5: Cache idempotence on ingestion", async () => {
    await fc.assert(
      fc.asyncProperty(ownerArb, repoArb, refArb, saltArb, async (owner, repo, ref, salt) => {
        resetMemoryStoreForTests();
        vi.mocked(fetchTarball).mockClear();
        vi.mocked(parseRepo).mockClear();

        const repoRef = toRepoRef({ owner, repo, ref });
        const repoKey = makeRepoKey(repoRef);
        const cachedGraph = buildCachedGraph(repoRef, salt);
        await putGraph(repoKey, cachedGraph);

        const url = `https://github.com/${owner}/${repo}/tree/${ref}`;
        const response = await postRepo(
          new Request("http://localhost/api/repos", {
            method: "POST",
            body: JSON.stringify({ url }),
          }),
        );
        expect(response.status).toBe(202);

        const body = (await response.json()) as { jobId: string; repoKey: string };
        expect(body.repoKey).toBe(repoKey);

        const statusResponse = await getStatus(
          new Request(`http://localhost/api/repos/${body.jobId}/status`),
          { params: Promise.resolve({ jobId: body.jobId }) },
        );
        expect(statusResponse.status).toBe(200);
        const statusBody = (await statusResponse.json()) as {
          status: string;
          progress: number;
          graph?: Graph;
        };
        expect(statusBody.status).toBe("succeeded");
        expect(statusBody.progress).toBe(100);
        expect(statusBody.graph).toEqual(cachedGraph);

        expect(vi.mocked(fetchTarball)).not.toHaveBeenCalled();
        expect(vi.mocked(parseRepo)).not.toHaveBeenCalled();
      }),
      { numRuns: 25 },
    );
  });
});
