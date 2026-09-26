import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { Graph } from "@/lib/graph";
import { rankNodesForQuery, selectContext } from "@/lib/retrieval";

function chainGraph(size: number): Graph {
  return {
    nodes: Array.from({ length: size }, (_, index) => ({
      id: `n${index.toString().padStart(3, "0")}`,
      kind: "function" as const,
      name: `node${index}`,
      file: `src/file${index}.ts`,
      folder: "src",
      loc: 3,
      signature: `function node${index}()`,
      snippet: `/** node ${index} */\nexport function node${index}() {\n  return ${index};\n}`,
      startLine: 1,
      endLine: 3,
    })),
    edges: Array.from({ length: Math.max(0, size - 1) }, (_, index) => ({
      source: `n${index.toString().padStart(3, "0")}`,
      target: `n${(index + 1).toString().padStart(3, "0")}`,
      kind: "call" as const,
    })),
    meta: { repoRef: "owner/repo@main", parsedAt: 0, fileCount: size },
  };
}

function distanceWithinTwo(graph: Graph, seeds: string[], target: string): boolean {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const seen = new Set(seeds);
  const queue = seeds.map((id) => ({ id, depth: 0 }));
  while (queue.length) {
    const current = queue.shift()!;
    if (current.id === target) {
      return true;
    }
    if (current.depth >= 2) {
      continue;
    }
    for (const next of adjacency.get(current.id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push({ id: next, depth: current.depth + 1 });
      }
    }
  }
  return false;
}

describe("retrieval properties", () => {
  it("Feature: viberon, Property 3: Retrieval respects depth and cap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), (size) => {
        const graph = chainGraph(size);
        const selection = selectContext(graph, "node", []);
        const seeds = rankNodesForQuery(graph, "node").slice(0, 5).map((score) => score.id);

        expect(selection.nodeIds.length).toBeLessThanOrEqual(30);
        for (const id of selection.nodeIds) {
          expect(distanceWithinTwo(graph, seeds, id)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: viberon, Property 4: Token savings are non-negative", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), (size) => {
        const graph = chainGraph(size);
        const files = graph.nodes.map((node) => ({
          path: node.file,
          tokenCount: 1000,
        }));
        const selection = selectContext(graph, "node", files);

        expect(selection.baselineTokens).toBeGreaterThanOrEqual(selection.selectedTokens);
      }),
      { numRuns: 100 },
    );
  });

  it("uses the actual graph-memory baseline instead of inflated file token counts", () => {
    const graph = chainGraph(1);
    const selection = selectContext(graph, "node0", [
      {
        path: "src/file0.ts",
        tokenCount: 20_000,
      },
    ]);

    expect(selection.nodeIds).toEqual(["n000"]);
    expect(selection.baselineTokens).toBe(selection.selectedTokens);
    expect(selection.baselineTokens).toBeLessThan(1_000);
  });

  it("includes whole-repo overview and frontier edges without dumping the whole repo", () => {
    const graph = chainGraph(7);
    const selection = selectContext(graph, "node", [], { depth: 1, maxNodes: 5 });

    expect(selection.nodeIds).toHaveLength(5);
    expect(selection.contextString).toContain("### repo overview");
    expect(selection.contextString).toContain("graph covers 7 symbols across 7 files and 6 edges");
    expect(selection.contextString).toContain("### relationships to the rest of the repo");
    expect(selection.contextString).toContain("node4 (src/file4.ts) connects by call to node5 (src/file5.ts)");
  });
});
