import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ingest, RepoTooLargeError } from "@/lib/ingest";
import { parseRepo } from "@/lib/parser";
import { selectContext } from "@/lib/retrieval";
import { resetMemoryStoreForTests } from "@/lib/store";
import type { RepoFile, TarballResult } from "@/lib/github";

/**
 * Edge-case tests for boundaries called out in tasks.md task 20.3:
 *   - file counts {0, 1, 500, 501}
 *   - nodes with zero LOC
 *   - queries that are stop-words only
 *   - non-ASCII folder names
 *
 * These run as plain example tests (no fast-check) so failures point at the
 * exact boundary that broke.
 */

const ownerRepo = "boundary/owner@main";

function buildFiles(count: number): RepoFile[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file${index}.ts`,
    source: `export function fn${index}() { return ${index}; }\n`,
  }));
}

vi.mock("@/lib/github", async () => {
  const actual = await vi.importActual<typeof import("@/lib/github")>("@/lib/github");
  return {
    ...actual,
    fetchTarball: vi.fn<(repoRef: string) => Promise<TarballResult>>(),
  };
});

const { fetchTarball } = await import("@/lib/github");

describe("edge cases — file count boundaries", () => {
  beforeEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    resetMemoryStoreForTests();
    vi.mocked(fetchTarball).mockReset();
  });

  afterEach(() => {
    resetMemoryStoreForTests();
  });

  it("ingests a 0-file repo without throwing and produces an empty graph", async () => {
    vi.mocked(fetchTarball).mockResolvedValueOnce({ repoRef: ownerRepo, files: [] });

    const result = await ingest(ownerRepo);
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.edges).toEqual([]);
    expect(result.graph.meta.fileCount).toBe(0);
  });

  it("ingests a 1-file repo and produces exactly one node", async () => {
    vi.mocked(fetchTarball).mockResolvedValueOnce({
      repoRef: ownerRepo,
      files: buildFiles(1),
    });

    const result = await ingest(ownerRepo);
    expect(result.graph.meta.fileCount).toBe(1);
    expect(result.graph.nodes.length).toBe(1);
    expect(result.graph.nodes[0]?.name).toBe("fn0");
  });

  it("ingests a 500-file repo at the cap boundary", async () => {
    vi.mocked(fetchTarball).mockResolvedValueOnce({
      repoRef: ownerRepo,
      files: buildFiles(500),
    });

    const result = await ingest(ownerRepo);
    expect(result.graph.meta.fileCount).toBe(500);
    expect(result.graph.nodes.length).toBe(500);
  });

  it("rejects a 501-file repo with RepoTooLargeError", async () => {
    vi.mocked(fetchTarball).mockResolvedValueOnce({
      repoRef: ownerRepo,
      files: buildFiles(501),
    });

    await expect(ingest(ownerRepo)).rejects.toBeInstanceOf(RepoTooLargeError);
  });
});

describe("edge cases — parser and retrieval", () => {
  it("parses a node with a single-line body so loc=1", () => {
    const result = parseRepo(
      [{ path: "src/oneliner.ts", source: "export function tiny() { return 1; }" }],
      ownerRepo,
    );
    expect(result.graph.nodes).toHaveLength(1);
    expect(result.graph.nodes[0]?.loc).toBe(1);
  });

  it("returns no edges when the only file has zero callable bindings", () => {
    const result = parseRepo(
      [{ path: "src/empty.ts", source: "// nothing here\n" }],
      ownerRepo,
    );
    expect(result.graph.nodes).toEqual([]);
    expect(result.graph.edges).toEqual([]);
  });

  it("retrieval with stop-words-only query returns selection without crashing", () => {
    const parsed = parseRepo(
      [
        { path: "src/a.ts", source: "export function add(a, b) { return a + b; }" },
        { path: "src/b.ts", source: "export class Container {}" },
      ],
      ownerRepo,
    );

    const selection = selectContext(parsed.graph, "the and of with", []);
    // Stop-words-only query yields no signal; selection may be empty or
    // contain seeds, but it must never blow up and must respect the cap.
    expect(selection.nodeIds.length).toBeLessThanOrEqual(30);
    expect(selection.selectedTokens).toBeGreaterThanOrEqual(0);
    expect(selection.baselineTokens).toBeGreaterThanOrEqual(selection.selectedTokens);
  });

  it("preserves non-ASCII folder names in node folder field", () => {
    const result = parseRepo(
      [{ path: "café/main.ts", source: "export function main() { return 1; }" }],
      ownerRepo,
    );

    expect(result.graph.nodes).toHaveLength(1);
    expect(result.graph.nodes[0]?.folder).toBe("café");
  });

  it("retrieval with empty graph returns empty selection per Req 4.5", () => {
    const selection = selectContext(
      { nodes: [], edges: [], meta: { repoRef: ownerRepo, parsedAt: 0, fileCount: 0 } },
      "anything",
      [],
    );
    expect(selection.nodeIds).toEqual([]);
    expect(selection.contextString).toBe("");
    expect(selection.selectedTokens).toBe(0);
    expect(selection.baselineTokens).toBe(0);
  });
});
