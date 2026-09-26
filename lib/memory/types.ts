/**
 * Durable project memory.
 *
 * The problem this solves: a stateless chat agent re-derives what the
 * project *is* on every single turn — re-reading package.json, re-guessing
 * conventions, re-discovering where the router lives. That is both the
 * largest recurring token cost and the reason agents "forget" and
 * contradict earlier decisions.
 *
 * Memory is a small, structured, human-readable brain that persists across
 * sessions and app restarts. It is rendered into the *cacheable* prefix of
 * every system prompt, so re-reading it costs ~0.1x after the first turn.
 *
 * Two halves:
 *  - **Derived** (`overview`, `stack`, `entryPoints`, `files`) — recomputed
 *    from the workspace and graph. Cheap, always accurate.
 *  - **Learned** (`conventions`, `decisions`, `facts`, `suggestions`,
 *    `tasks`) — written by agents as they work. This is the part that makes
 *    the software feel like it actually knows the project.
 */

export const MEMORY_VERSION = 1;

export type MemoryEntryKind = "decision" | "fact" | "suggestion" | "convention";

export interface MemoryEntry {
  id: string;
  kind: MemoryEntryKind;
  /** One-line statement. Kept short on purpose — this lives in every prompt. */
  text: string;
  /** Why it is true / why it was chosen. Optional, shown in the UI. */
  why?: string;
  /** Files this entry is about, for relevance filtering. */
  files?: string[];
  /** Which agent recorded it. */
  author?: string;
  createdAt: number;
  /** Suggestions can be resolved without being deleted. */
  resolved?: boolean;
}

export type MemoryTaskStatus =
  | "pending"
  | "in_progress"
  | "blocked"
  | "done"
  | "cancelled";

/**
 * Durable task state. Distinct from the per-run orchestration DAG: these
 * survive reloads so "what were we in the middle of?" always has an answer.
 */
export interface MemoryTask {
  id: string;
  title: string;
  detail?: string;
  status: MemoryTaskStatus;
  /** Specialist role this belongs to, when known. */
  role?: string;
  files?: string[];
  createdAt: number;
  updatedAt: number;
  /** Task ids that must finish first. */
  dependsOn?: string[];
}

/** Compact per-file digest — the L1 layer of progressive disclosure. */
export interface FileDigest {
  path: string;
  /** Content hash, so we only re-summarize files that actually changed. */
  hash: string;
  tokens: number;
  /** Exported symbol names, from the graph parse. */
  exports: string[];
  /** Files this one imports (workspace-relative where resolvable). */
  imports: string[];
  /** One-line purpose. Derived heuristically, refined by agents. */
  purpose?: string;
}

export interface ProjectMemory {
  version: number;
  repoKey: string;
  updatedAt: number;

  /** A paragraph describing what this project is and does. */
  overview: string;
  /** Detected technologies: "Next.js 15", "Tailwind v4", "Vitest". */
  stack: string[];
  /** Files worth reading first. */
  entryPoints: string[];
  /** Available npm/pnpm scripts, so agents run the right command. */
  scripts: Record<string, string>;

  conventions: MemoryEntry[];
  decisions: MemoryEntry[];
  facts: MemoryEntry[];
  suggestions: MemoryEntry[];
  tasks: MemoryTask[];

  /** Keyed by path for O(1) patching on edit. */
  files: Record<string, FileDigest>;

  /** Running totals, surfaced in the ledger UI. */
  stats: {
    turns: number;
    tokensIn: number;
    tokensOut: number;
    tokensCached: number;
    /** Tokens the graph pipeline avoided sending vs a naive full dump. */
    tokensSaved: number;
    costUsd: number;
    savedUsd: number;
  };
}

export function emptyMemory(repoKey: string): ProjectMemory {
  return {
    version: MEMORY_VERSION,
    repoKey,
    updatedAt: Date.now(),
    overview: "",
    stack: [],
    entryPoints: [],
    scripts: {},
    conventions: [],
    decisions: [],
    facts: [],
    suggestions: [],
    tasks: [],
    files: {},
    stats: {
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      tokensCached: 0,
      tokensSaved: 0,
      costUsd: 0,
      savedUsd: 0,
    },
  };
}
