/**
 * Pure parsers and validators for git plumbing output.
 *
 * Kept free of node imports so the client can share the types and the tests
 * can exercise every edge case without spawning a process.
 */

/** Single-letter status as VS Code shows it. */
export type GitStatusLetter = "M" | "A" | "D" | "R" | "C" | "U" | "T" | "?";

export type GitChangeGroup = "staged" | "changes" | "untracked" | "conflicts";

export interface GitFileChange {
  /** Path relative to the repository root, forward slashes. */
  path: string;
  /** Original path for renames / copies. */
  originalPath?: string;
  group: GitChangeGroup;
  letter: GitStatusLetter;
}

export interface GitBranchInfo {
  /** Branch name, or null when HEAD is detached. */
  head: string | null;
  /** Abbreviated commit, or null before the first commit. */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export interface GitStatus {
  branch: GitBranchInfo;
  files: GitFileChange[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  /** Unix epoch milliseconds. */
  date: number;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

function letterFor(code: string): GitStatusLetter | null {
  switch (code) {
    case "M":
      return "M";
    case "A":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "C":
      return "C";
    case "T":
      return "T";
    case "U":
      return "U";
    default:
      return null;
  }
}

/**
 * Parse `git status --porcelain=v2 --branch -z`.
 *
 * Records are NUL-separated; a rename/copy record (`2 …`) is followed by an
 * extra NUL-terminated field holding the original path. Paths are never
 * quoted in `-z` mode, so spaces and unicode survive untouched.
 *
 * A file can appear in both Staged and Changes (edited after `git add`), so
 * one ordinary record may emit two entries.
 */
export function parseStatusV2(output: string): GitStatus {
  const branch: GitBranchInfo = {
    head: null,
    oid: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const files: GitFileChange[] = [];

  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record) continue;

    if (record.startsWith("# ")) {
      const [key, ...rest] = record.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") {
        branch.oid = value === "(initial)" ? null : value.slice(0, 7);
      } else if (key === "branch.head") {
        branch.head = value === "(detached)" ? null : value;
      } else if (key === "branch.upstream") {
        branch.upstream = value || null;
      } else if (key === "branch.ab") {
        const match = value.match(/^\+(\d+) -(\d+)$/);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }

    const kind = record[0];
    if (kind === "?") {
      files.push({ path: record.slice(2), group: "untracked", letter: "?" });
      continue;
    }
    if (kind === "!") continue;

    if (kind === "1" || kind === "2") {
      // 1 XY sub mH mI mW hH hI path
      // 2 XY sub mH mI mW hH hI Xscore path   (+ NUL origPath)
      const headerCount = kind === "1" ? 8 : 9;
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(headerCount).join(" ");
      let originalPath: string | undefined;
      if (kind === "2") {
        originalPath = fields[i + 1] || undefined;
        i += 1;
      }
      const staged = letterFor(xy[0]);
      const unstaged = letterFor(xy[1]);
      if (staged) {
        files.push({ path, originalPath, group: "staged", letter: staged });
      }
      if (unstaged) {
        files.push({
          path,
          // The worktree side of a staged rename is plain modification of
          // the new path.
          originalPath: staged ? undefined : originalPath,
          group: "changes",
          letter: unstaged,
        });
      }
      continue;
    }

    if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const parts = record.split(" ");
      files.push({
        path: parts.slice(10).join(" "),
        group: "conflicts",
        letter: "U",
      });
    }
  }

  return { branch, files };
}

/** Field and record separators used by the `git log` format below. */
export const LOG_FIELD = "\x1f";
export const LOG_RECORD = "\x1e";
export const LOG_FORMAT = `%H${LOG_FIELD}%h${LOG_FIELD}%an${LOG_FIELD}%at${LOG_FIELD}%s${LOG_RECORD}`;

/** Parse `git log --pretty=format:<LOG_FORMAT>`. */
export function parseLog(output: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const raw of output.split(LOG_RECORD)) {
    const record = raw.replace(/^\s+/, "");
    if (!record) continue;
    const [hash, shortHash, author, at, ...subject] = record.split(LOG_FIELD);
    if (!hash || !shortHash) continue;
    commits.push({
      hash,
      shortHash,
      author: author ?? "",
      date: Number(at ?? 0) * 1000,
      subject: subject.join(LOG_FIELD),
    });
  }
  return commits;
}

export const BRANCH_FORMAT = `%(HEAD)${LOG_FIELD}%(refname:short)${LOG_FIELD}%(upstream:short)`;

/** Parse `git for-each-ref --format=<BRANCH_FORMAT> refs/heads`. */
export function parseBranches(output: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [head, name, upstream] = line.split(LOG_FIELD);
    if (!name) continue;
    branches.push({
      name,
      current: head === "*",
      upstream: upstream || null,
    });
  }
  return branches;
}

/**
 * Validate a branch name against `git check-ref-format --branch` rules, plus
 * one of our own: it may not begin with `-`, so it can never be mistaken for
 * an option even where `--` is not accepted.
 */
export function isValidBranchName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 200) return false;
  if (name === "@" || name === "HEAD") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  // Control characters, space, and the characters git reserves.
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  for (const component of name.split("/")) {
    if (component.startsWith(".") || component.endsWith(".lock")) return false;
  }
  return true;
}

/** Validate a commit-ish supplied by the client (only hex hashes allowed). */
export function isValidCommitHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{4,64}$/i.test(value);
}
