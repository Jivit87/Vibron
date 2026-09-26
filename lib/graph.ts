/**
 * Core graph and ingestion types shared across the app: parsed symbol graph,
 * stored file records, and ingestion job status.
 */

export type GraphNodeKind = "function" | "class";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  name: string;
  file: string;
  folder: string;
  loc: number;
  signature: string;
  snippet: string;
  startLine: number;
  endLine: number;
}

export type GraphEdgeKind = "import" | "call";

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphEdgeKind;
}

export interface GraphMeta {
  repoRef: string;
  parsedAt: number;
  fileCount: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: GraphMeta;
}

/** A file's raw contents, as stored for retrieval/editing. */
export interface StoredRawFile {
  path: string;
  source: string;
}

/** Lightweight per-file metadata used for retrieval scoring. */
export interface StoredFileInfo {
  path: string;
  tokenCount: number;
}

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

export interface Job {
  jobId: string;
  repoKey: string;
  repoRef: string;
  status: JobStatus;
  progress: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  errors?: string[];
}

export interface LocalWorkspaceMeta {
  repoKey: string;
  repoRef: string;
  label: string;
  rootPath: string;
  registeredAt: number;
}

export interface DemoMeta {
  repoKey: string;
  name: string;
  description?: string;
  createdAt: number;
}
