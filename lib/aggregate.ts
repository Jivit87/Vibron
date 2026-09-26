/**
 * Aggregator: turns the full per-symbol Graph into a RenderGraph that the
 * canvas can draw. Folders that are not expanded collapse all their contained
 * symbols into a single super-node; symbols inside an expanded folder render
 * as their normal self.
 *
 * The depth at which folders aggregate is chosen adaptively to keep the
 * resulting collapsed super-node count between MIN_TARGET and MAX_TARGET
 * for whatever repo size we're given.
 */

import type { Graph, GraphEdge, GraphNode } from "@/lib/graph";

export type RenderNodeKind = "folder" | "function" | "class";

export interface RenderNode {
  id: string;
  kind: RenderNodeKind;
  name: string;
  /** The original GraphNode, when this is a symbol. */
  symbol?: GraphNode;
  /** For folder super-nodes: the folder path it represents. */
  folderPath?: string;
  /** For folder super-nodes: how many symbols it contains. */
  folderSize?: number;
  /** Total LOC across contained symbols (used for sizing super-nodes). */
  totalLoc: number;
  /** Top-level folder (the root segment) for color bucket. */
  folder: string;
}

export interface RenderEdge {
  source: string;
  target: string;
  kind: GraphEdge["kind"];
  /** When the underlying symbol-edge crosses two collapsed folders, count
   *  how many real edges this aggregated edge represents. */
  weight: number;
}

export interface RenderGraph {
  nodes: RenderNode[];
  edges: RenderEdge[];
  /** Resolved adaptive depth (1, 2, or 3). Useful for UX hints. */
  depth: number;
  /** Expanded folder paths the caller passed in (echoed back). */
  expanded: Set<string>;
  /** Map from raw symbol id → render node id (folder super-node id when
   *  the symbol is collapsed, the symbol's own id when expanded). Used by
   *  the chat-driven auto-expansion + retrieval pulse rendering. */
  symbolToRenderId: Map<string, string>;
}

const MIN_TARGET = 30;
const MAX_TARGET = 150;
const FALLBACK_TARGET = 80;

/**
 * Returns the folder path used for aggregation at depth `d`. Splits the
 * file path on `/` and joins the first `d` segments. Files at the root
 * are bucketed into a synthetic `<root>` folder so they don't disappear.
 */
function folderPathAtDepth(filePath: string, depth: number): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length === 0) return "<root>";
  // The last segment is the file name itself, so we bucket by everything
  // before it. This is what users intuitively read as "the folder."
  const folderSegments = segments.slice(0, -1);
  if (folderSegments.length === 0) return "<root>";
  return folderSegments.slice(0, depth).join("/");
}

/**
 * Decide a depth that yields `MIN_TARGET..MAX_TARGET` distinct folder paths
 * across the graph. Falls back to depth 1 (or maxes out at 4) if no depth
 * is in range. Returns the smallest qualifying depth, biasing toward
 * shallower bucketing for readability.
 */
export function chooseAdaptiveDepth(graph: Graph): number {
  const candidates = [1, 2, 3, 4];
  let best = candidates[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const d of candidates) {
    const distinct = new Set<string>();
    for (const node of graph.nodes) {
      distinct.add(folderPathAtDepth(node.file, d));
    }
    const count = distinct.size;
    if (count >= MIN_TARGET && count <= MAX_TARGET) {
      return d; // first acceptable depth wins
    }
    // Track the depth that gets us closest to FALLBACK_TARGET in case
    // nothing falls in the [MIN, MAX] window.
    const distance = Math.abs(count - FALLBACK_TARGET);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = d;
    }
  }

  return best;
}

/**
 * Build the RenderGraph from a raw Graph plus an `expanded` set of folder
 * paths the user has clicked open. Folders not in `expanded` collapse to
 * one super-node; symbols inside expanded folders render individually.
 */
export function aggregate(
  graph: Graph,
  expanded: Set<string>,
  depthOverride?: number,
): RenderGraph {
  const depth = depthOverride ?? chooseAdaptiveDepth(graph);

  // 1. Bucket every symbol into its folder path.
  const symbolFolderPath = new Map<string, string>(); // symbol id -> folder path
  for (const node of graph.nodes) {
    symbolFolderPath.set(node.id, folderPathAtDepth(node.file, depth));
  }

  // 2. Build folder super-nodes (totalLoc, folderSize) and the map from
  //    symbol id -> render node id.
  const folderInfo = new Map<
    string,
    { totalLoc: number; size: number; topFolder: string }
  >();
  for (const node of graph.nodes) {
    const fpath = symbolFolderPath.get(node.id)!;
    const info = folderInfo.get(fpath);
    if (info) {
      info.totalLoc += node.loc;
      info.size += 1;
    } else {
      folderInfo.set(fpath, {
        totalLoc: node.loc,
        size: 1,
        topFolder: node.folder, // root segment for coloring
      });
    }
  }

  const symbolToRenderId = new Map<string, string>();
  const renderNodes: RenderNode[] = [];

  // Folder super-nodes for non-expanded folders.
  for (const [fpath, info] of folderInfo.entries()) {
    if (expanded.has(fpath)) continue;
    const id = `folder:${fpath}`;
    renderNodes.push({
      id,
      kind: "folder",
      name: fpath === "<root>" ? "/" : fpath,
      folderPath: fpath,
      folderSize: info.size,
      totalLoc: info.totalLoc,
      folder: info.topFolder,
    });
  }

  // Symbol nodes for expanded folders.
  for (const node of graph.nodes) {
    const fpath = symbolFolderPath.get(node.id)!;
    if (expanded.has(fpath)) {
      renderNodes.push({
        id: node.id,
        kind: node.kind,
        name: node.name,
        symbol: node,
        totalLoc: node.loc,
        folder: node.folder,
      });
      symbolToRenderId.set(node.id, node.id);
    } else {
      symbolToRenderId.set(node.id, `folder:${fpath}`);
    }
  }

  // 3. Aggregate edges. For each raw edge, map its endpoints through
  //    `symbolToRenderId` and merge by (source, target, kind), summing
  //    weights. Skip self-loops on collapsed super-nodes (symbol-to-symbol
  //    edges within the same collapsed folder).
  const edgeAggregation = new Map<
    string,
    { source: string; target: string; kind: GraphEdge["kind"]; weight: number }
  >();
  for (const edge of graph.edges) {
    const a = symbolToRenderId.get(edge.source);
    const b = symbolToRenderId.get(edge.target);
    if (!a || !b || a === b) continue;
    const key = `${a}::${b}::${edge.kind}`;
    const existing = edgeAggregation.get(key);
    if (existing) {
      existing.weight += 1;
    } else {
      edgeAggregation.set(key, { source: a, target: b, kind: edge.kind, weight: 1 });
    }
  }

  return {
    nodes: renderNodes,
    edges: [...edgeAggregation.values()],
    depth,
    expanded,
    symbolToRenderId,
  };
}

/**
 * Given the raw Graph, the current expanded set, and the symbol ids the
 * retrieval just selected, return an updated expanded set that includes
 * every folder containing a retrieved symbol. This is what makes the green
 * pulse drill down into the right code on every chat answer.
 */
export function expandFoldersForSymbols(
  graph: Graph,
  current: Set<string>,
  symbolIds: string[],
  depthOverride?: number,
): Set<string> {
  if (symbolIds.length === 0) return current;
  const depth = depthOverride ?? chooseAdaptiveDepth(graph);
  const next = new Set(current);
  const symbolIndex = new Map(graph.nodes.map((n) => [n.id, n] as const));
  for (const id of symbolIds) {
    const node = symbolIndex.get(id);
    if (!node) continue;
    next.add(folderPathAtDepth(node.file, depth));
  }
  return next;
}
