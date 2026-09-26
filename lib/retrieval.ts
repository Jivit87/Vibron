import type { Graph, GraphNode, StoredFileInfo } from "@/lib/graph";
import { countTokens } from "@/lib/tokens";

export interface Selection {
  nodeIds: string[];
  contextString: string;
  selectedTokens: number;
  baselineTokens: number;
}

export interface NodeScore {
  id: string;
  score: number;
}

const SEED_COUNT = 5;
const BFS_DEPTH = 2;
const MIN_DEPTH = 1;
const MAX_DEPTH = 4;
const MIN_NODES = 5;
const MAX_NODE_CAP = 60;
const FILE_OVERVIEW_LIMIT = 8;
const FOLDER_OVERVIEW_LIMIT = 6;
const FRONTIER_EDGE_LIMIT = 16;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

export interface SelectContextOptions {
  /** BFS expansion depth from TF-IDF seeds. Clamped to [1, 4]. Default 2. */
  depth?: number;
  /** Hard cap on the returned node count. Clamped to [5, 60]. Default 30. */
  maxNodes?: number;
}

export function selectContext(
  graph: Graph,
  query: string,
  files: StoredFileInfo[] = [],
  options: SelectContextOptions = {},
): Selection {
  // Query-shape adaptive scaling. Without this, two different prompts of
  // similar shape produce the same selection size and the savings counter
  // looks frozen. Specific signals:
  //   - More distinct content tokens → broader retrieval (the user is
  //     asking about more concepts, so widen the net).
  //   - Longer query length → slight depth bump (the user has more on
  //     their mind, give the model more relationships).
  // Both effects are clamped to the same 1-4 / 5-60 envelopes the explicit
  // options use, so the user's Settings sliders still cap everything.
  const queryTokens = tokenize(query);
  const distinct = new Set(queryTokens).size;
  const trimmed = query.trim().length;
  const adaptiveDepth =
    trimmed >= 80 ? 3 : trimmed >= 30 ? 2 : 1;
  // Scale node count roughly linearly in distinct content tokens, with a
  // floor at 8 (so even one-word queries still pull useful relationships).
  const adaptiveMaxNodes = Math.max(8, Math.min(60, 8 + distinct * 5));
  const depth = clampInt(options.depth ?? adaptiveDepth, MIN_DEPTH, MAX_DEPTH);
  const maxNodes = clampInt(
    options.maxNodes ?? adaptiveMaxNodes,
    MIN_NODES,
    MAX_NODE_CAP,
  );
  if (graph.nodes.length === 0) {
    return { nodeIds: [], contextString: "", selectedTokens: 0, baselineTokens: 0 };
  }

  const scores = rankNodesForQuery(graph, query);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const seeds = pickSeedIds(scores, nodeById, SEED_COUNT);
  const scoreById = new Map(scores.map((score) => [score.id, score.score] as const));
  const reached = expandSeeds(graph, seeds, depth);
  const selected = [...reached]
    .sort((a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, maxNodes);

  const selectedNodes = selected.map((id) => nodeById.get(id)).filter(Boolean) as GraphNode[];
  const selectedSet = new Set(selected);

  // Collect edges that lie entirely within the selected subgraph. This gives
  // the LLM the relationships between the snippets it's reading, which is
  // what the user usually means by "how X connects to Y".
  const selectedEdges = graph.edges.filter(
    (e) => selectedSet.has(e.source) && selectedSet.has(e.target),
  );
  const frontierEdges = graph.edges.filter(
    (e) => selectedSet.has(e.source) !== selectedSet.has(e.target),
  );

  const repoOverviewBlock = formatRepoOverviewForPrompt(
    graph,
    scores,
    nodeById,
    selectedNodes,
  );
  const nodesBlock = selectedNodes.map(formatNodeForPrompt).join("\n\n");
  const edgesBlock = formatEdgesForPrompt(selectedEdges, nodeById);
  const frontierBlock = formatFrontierEdgesForPrompt(
    frontierEdges,
    nodeById,
    selectedSet,
    scoreById,
  );
  const contextString = [
    repoOverviewBlock,
    nodesBlock,
    edgesBlock,
    frontierBlock,
  ].filter(Boolean).join("\n\n");

  const selectedTokens = countTokens(contextString);
  // The UI still passes stored file token counts for backwards compatibility,
  // but the savings math below intentionally stays graph-memory-only so we
  // compare against a realistic snippet baseline instead of inflated raw-file
  // dumps.
  void files;
  const rawBaselineTokens = computeNaiveBaselineTokens({
    scores,
    nodeById,
    selectedNodes,
    // The "naive RAG" we're comparing to would also stuff more files for a
    // broader question, so let its file cap track ours. Bounded at 15 to
    // keep the comparison realistic for a keyword RAG that hits a token
    // budget.
    fileLimit: Math.max(5, Math.min(NAIVE_FILE_LIMIT, Math.round(maxNodes / 2))),
  });

  return {
    nodeIds: selected,
    contextString,
    selectedTokens,
    baselineTokens: Math.max(rawBaselineTokens, selectedTokens),
  };
}

/**
 * Maximum number of files a naive keyword-based RAG would stuff into context.
 * Real-world keyword RAGs cap at ~5–20 files before they blow the token budget;
 * 15 keeps the comparison honest without making every reply look like a
 * 99%-savings ad.
 */
const NAIVE_FILE_LIMIT = 15;

/**
 * Estimate what a naive graph-memory retriever would have shipped for this
 * query. We still rank at the file level, but the payload is built from the
 * graph snippets for every symbol in those files, not the raw file token
 * counts. That keeps the comparison honest: "graph memory vs smarter graph
 * memory", instead of "graph memory vs fake full-file dump".
 *
 * The result varies with the query: a narrow query that matches a couple of
 * symbols yields a small baseline (and modest savings), while a broad query
 * that matches many files yields a large baseline (and dramatic savings).
 * That is the realistic comparison — what a dumber retriever would have shown
 * the model for *this* prompt.
 */
function computeNaiveBaselineTokens(args: {
  scores: NodeScore[];
  nodeById: Map<string, GraphNode>;
  selectedNodes: GraphNode[];
  fileLimit?: number;
}): number {
  const { scores, nodeById, selectedNodes } = args;
  const fileLimit = args.fileLimit ?? NAIVE_FILE_LIMIT;
  // Sum positive node-level relevance into per-file scores.
  const fileScores = new Map<string, number>();
  for (const { id, score } of scores) {
    if (score <= 0) continue;
    const node = nodeById.get(id);
    if (!node) continue;
    fileScores.set(node.file, (fileScores.get(node.file) ?? 0) + score);
  }

  // Candidate pool: query-matched files plus, as a floor, every file the
  // graph slice touched. Without the floor, stop-word-only queries collapse
  // baseline to 0 and show "0% saved" which is misleading.
  const candidates = new Map<string, number>();
  for (const [path, score] of fileScores) {
    candidates.set(path, score);
  }
  for (const node of selectedNodes) {
    if (!candidates.has(node.file)) {
      candidates.set(node.file, 0);
    }
  }
  if (candidates.size === 0) return 0;

  const ranked = [...candidates.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, fileLimit)
    .map(([path]) => path);

  const nodesByFile = new Map<string, GraphNode[]>();
  for (const node of nodeById.values()) {
    if (!candidates.has(node.file)) continue;
    const list = nodesByFile.get(node.file) ?? [];
    list.push(node);
    nodesByFile.set(node.file, list);
  }

  const tokenFor = (path: string): number => {
    const nodes = (nodesByFile.get(path) ?? [])
      .slice()
      .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
    if (nodes.length === 0) return 0;
    return countTokens(nodes.map(formatNodeForPrompt).join("\n\n"));
  };

  return ranked.reduce((sum, path) => sum + tokenFor(path), 0);
}

export function rankNodesForQuery(graph: Graph, query: string): NodeScore[] {
  const queryTokens = tokenize(query);
  const corpus = graph.nodes.map((node) => tokenize(`${node.name} ${extractJsdoc(node.snippet)}`));
  const idf = computeIdf(corpus);

  return graph.nodes
    .map((node, index) => ({
      id: node.id,
      score: tfIdfScore(corpus[index] ?? [], queryTokens, idf),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export function formatNodeForPrompt(node: GraphNode): string {
  // Code units are framed as numbered, named sections so the model can
  // reference them naturally. Each section opens with the file path and the
  // symbol's kind/name, then includes a single-line signature, then up to
  // ~1200 chars of source. Long snippets get a clear truncation marker.
  const truncated = node.snippet.length > 1200;
  const body = node.snippet.slice(0, 1200);
  return [
    `### ${node.kind} ${node.name}  (${node.file}:${node.startLine}-${node.endLine}, ${node.loc} LOC)`,
    `signature: ${node.signature}`,
    "```",
    truncated ? `${body}\n... (truncated ${node.snippet.length - 1200} chars)` : body,
    "```",
  ].join("\n");
}

/**
 * Render the edges of the selected subgraph as a compact relationship table
 * the LLM can read. Without this, the model only sees isolated snippets and
 * can't answer "what calls X?" or "where is Y imported?" reliably.
 */
export function formatEdgesForPrompt(
  edges: { source: string; target: string; kind: string }[],
  nodeById: Map<string, GraphNode>,
): string {
  if (edges.length === 0) return "";
  const lines: string[] = [];
  lines.push("### relationships (within the selected slice)");
  for (const e of edges) {
    const s = nodeById.get(e.source);
    const t = nodeById.get(e.target);
    if (!s || !t) continue;
    const arrow = e.kind === "call" ? "calls" : "imports";
    lines.push(`- ${s.name} (${s.file}) ${arrow} ${t.name} (${t.file})`);
  }
  return lines.join("\n");
}

export function formatFrontierEdgesForPrompt(
  edges: { source: string; target: string; kind: string }[],
  nodeById: Map<string, GraphNode>,
  selectedSet: Set<string>,
  scoreById: Map<string, number>,
): string {
  if (edges.length === 0) return "";
  const ranked = edges
    .slice()
    .sort((a, b) => {
      const aScore = Math.max(scoreById.get(a.source) ?? 0, scoreById.get(a.target) ?? 0);
      const bScore = Math.max(scoreById.get(b.source) ?? 0, scoreById.get(b.target) ?? 0);
      return bScore - aScore || a.kind.localeCompare(b.kind);
    })
    .slice(0, FRONTIER_EDGE_LIMIT);

  const lines: string[] = [];
  lines.push("### relationships to the rest of the repo");
  for (const edge of ranked) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) continue;
    const from = selectedSet.has(edge.source) ? source : target;
    const to = selectedSet.has(edge.source) ? target : source;
    const arrow = edge.kind === "call" ? "connects by call to" : "connects by import to";
    lines.push(`- ${from.name} (${from.file}) ${arrow} ${to.name} (${to.file})`);
  }
  return lines.join("\n");
}

function extractJsdoc(snippet: string): string {
  return [...snippet.matchAll(/\/\*\*([\s\S]*?)\*\//g)]
    .map((match) => match[1] ?? "")
    .join("\n")
    .replace(/^\s*\*/gm, "");
}

function computeIdf(corpus: string[][]): Map<string, number> {
  const docCount = Math.max(1, corpus.length);
  const documentFrequency = new Map<string, number>();

  for (const doc of corpus) {
    for (const token of new Set(doc)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }

  const idf = new Map<string, number>();
  for (const [token, count] of documentFrequency) {
    idf.set(token, Math.log((docCount + 1) / (count + 1)) + 1);
  }

  return idf;
}

function tfIdfScore(docTokens: string[], queryTokens: string[], idf: Map<string, number>): number {
  if (queryTokens.length === 0 || docTokens.length === 0) {
    return 0;
  }

  const termFrequency = new Map<string, number>();
  for (const token of docTokens) {
    termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
  }

  return queryTokens.reduce((score, token) => {
    const tf = (termFrequency.get(token) ?? 0) / docTokens.length;
    return score + tf * (idf.get(token) ?? 0);
  }, 0);
}

function pickSeedIds(
  scores: NodeScore[],
  nodeById: Map<string, GraphNode>,
  count: number,
): string[] {
  const seeds: string[] = [];
  const seenFiles = new Set<string>();

  for (const { id } of scores) {
    const node = nodeById.get(id);
    if (!node || seenFiles.has(node.file)) continue;
    seeds.push(id);
    seenFiles.add(node.file);
    if (seeds.length >= count) return seeds;
  }

  for (const { id } of scores) {
    if (seeds.includes(id)) continue;
    seeds.push(id);
    if (seeds.length >= count) break;
  }

  return seeds;
}

function formatRepoOverviewForPrompt(
  graph: Graph,
  scores: NodeScore[],
  nodeById: Map<string, GraphNode>,
  selectedNodes: GraphNode[],
): string {
  const folderCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    folderCounts.set(node.folder, (folderCounts.get(node.folder) ?? 0) + 1);
  }
  const topFolders = [...folderCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, FOLDER_OVERVIEW_LIMIT)
    .map(([folder, count]) => `${folder} (${count})`);

  const fileScores = new Map<string, number>();
  const symbolsByFile = new Map<string, { name: string; score: number }[]>();
  for (const { id, score } of scores) {
    const node = nodeById.get(id);
    if (!node) continue;
    const contribution = Math.max(0, score);
    fileScores.set(node.file, (fileScores.get(node.file) ?? 0) + contribution);
    const list = symbolsByFile.get(node.file) ?? [];
    list.push({ name: node.name, score });
    symbolsByFile.set(node.file, list);
  }
  for (const node of selectedNodes) {
    if (!fileScores.has(node.file)) {
      fileScores.set(node.file, 0);
    }
  }

  const topFiles = [...fileScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, FILE_OVERVIEW_LIMIT)
    .map(([file, score]) => {
      const symbols = (symbolsByFile.get(file) ?? [])
        .slice()
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
        .map(({ name }) => name)
        .filter((name, index, list) => list.indexOf(name) === index)
        .slice(0, 3);
      return { file, score, symbols };
    });

  const selectedFiles = new Set(selectedNodes.map((node) => node.file)).size;
  const lines: string[] = [];
  lines.push("### repo overview");
  lines.push(
    `- graph covers ${graph.nodes.length} symbols across ${graph.meta.fileCount} files and ${graph.edges.length} edges`,
  );
  lines.push(
    `- retrieved slice covers ${selectedNodes.length} symbols across ${selectedFiles} files`,
  );
  if (topFolders.length > 0) {
    lines.push(`- largest folders: ${topFolders.join(", ")}`);
  }
  if (topFiles.length > 0) {
    lines.push("- most relevant files for this query:");
    for (const item of topFiles) {
      const relevance = item.score > 0 ? `score ${item.score.toFixed(2)}` : "graph-adjacent";
      const symbols = item.symbols.length > 0 ? ` -> ${item.symbols.join(", ")}` : "";
      lines.push(`  - ${item.file} (${relevance})${symbols}`);
    }
  }
  return lines.join("\n");
}

function expandSeeds(graph: Graph, seeds: string[], maxDepth: number = BFS_DEPTH): Set<string> {
  const adjacency = buildAdjacency(graph);
  const reached = new Set<string>();
  const queue = seeds.map((id) => ({ id, depth: 0 }));

  for (const seed of seeds) {
    reached.add(seed);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const next = queue[cursor];
    if (next.depth >= maxDepth) {
      continue;
    }

    for (const neighbor of adjacency.get(next.id) ?? []) {
      if (reached.has(neighbor)) {
        continue;
      }
      reached.add(neighbor);
      queue.push({ id: neighbor, depth: next.depth + 1 });
    }
  }

  return reached;
}

function buildAdjacency(graph: Graph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    adjacency.set(node.id, new Set());
  }

  for (const edge of graph.edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  return adjacency;
}



function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}
