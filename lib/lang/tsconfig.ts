/**
 * `tsconfig.json` / `jsconfig.json` path-alias support for the parser.
 *
 * Only the two fields that matter for import resolution are read:
 * `compilerOptions.baseUrl` and `compilerOptions.paths`. `extends` chains
 * are followed when the parent config is part of the same file set, which
 * covers the common monorepo "tsconfig.base.json" layout without touching
 * the filesystem.
 */

import path from "node:path";

export interface PathAliases {
  /** Directory the config lives in, repo-relative ("" for the root). */
  configDir: string;
  /** Repo-relative baseUrl, or null when unset. */
  baseUrl: string | null;
  /** Ordered alias patterns → repo-relative target patterns. */
  paths: { pattern: string; targets: string[] }[];
}

/**
 * Strip `//` and `/* *\/` comments and trailing commas so JSONC parses with
 * `JSON.parse`. String contents are preserved (a `//` inside a string, as in
 * a URL, must not be treated as a comment).
 */
export function stripJsonComments(source: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

interface RawConfig {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

function readConfig(source: string): RawConfig | null {
  try {
    const parsed = JSON.parse(stripJsonComments(source)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as RawConfig) : null;
  } catch {
    return null;
  }
}

/**
 * Build alias tables from every tsconfig/jsconfig in the file set. Returns
 * one entry per config, deepest directory first, so a file resolves against
 * its nearest config.
 */
export function loadPathAliases(
  files: { path: string; source: string }[],
): PathAliases[] {
  const configs = new Map<string, RawConfig>();
  for (const file of files) {
    const base = path.posix.basename(file.path);
    if (!/^(tsconfig|jsconfig)(\.[\w-]+)?\.json$/.test(base)) continue;
    const parsed = readConfig(file.source);
    if (parsed) configs.set(file.path, parsed);
  }

  const out: PathAliases[] = [];
  for (const [configPath, config] of configs) {
    const base = path.posix.basename(configPath);
    // Only "entry" configs define resolution for their directory; base
    // configs (tsconfig.base.json) contribute via `extends`.
    if (base !== "tsconfig.json" && base !== "jsconfig.json") continue;
    const resolved = resolveCompilerOptions(configPath, config, configs, 0);
    if (!resolved.paths && !resolved.baseUrl) continue;
    const configDir = path.posix.dirname(configPath) === "." ? "" : path.posix.dirname(configPath);
    const pathsDir = resolved.pathsDir;
    const baseUrl = resolved.baseUrl;
    const entries = Object.entries(resolved.paths ?? {})
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]))
      .map(([pattern, targets]) => ({
        pattern,
        targets: targets
          .filter((t): t is string => typeof t === "string")
          .map((t) => joinRepo(baseUrl ?? pathsDir, t)),
      }));
    out.push({ configDir, baseUrl, paths: entries });
  }

  return out.sort((a, b) => b.configDir.length - a.configDir.length);
}

function resolveCompilerOptions(
  configPath: string,
  config: RawConfig,
  all: Map<string, RawConfig>,
  depth: number,
): { baseUrl: string | null; paths: Record<string, unknown> | null; pathsDir: string } {
  const dir = path.posix.dirname(configPath) === "." ? "" : path.posix.dirname(configPath);
  let inherited: ReturnType<typeof resolveCompilerOptions> = {
    baseUrl: null,
    paths: null,
    pathsDir: dir,
  };
  if (typeof config.extends === "string" && config.extends.startsWith(".") && depth < 5) {
    let parentPath = joinRepo(dir, config.extends);
    if (!parentPath.endsWith(".json")) parentPath += ".json";
    const parent = all.get(parentPath);
    if (parent) inherited = resolveCompilerOptions(parentPath, parent, all, depth + 1);
  }

  const options = config.compilerOptions ?? {};
  const baseUrl =
    typeof options.baseUrl === "string" ? joinRepo(dir, options.baseUrl) : inherited.baseUrl;
  const ownPaths =
    options.paths && typeof options.paths === "object"
      ? (options.paths as Record<string, unknown>)
      : null;
  return {
    baseUrl,
    paths: ownPaths ?? inherited.paths,
    // Without a baseUrl, `paths` entries resolve relative to the config
    // that declared them.
    pathsDir: ownPaths ? dir : inherited.pathsDir,
  };
}

function joinRepo(dir: string, rel: string): string {
  const joined = path.posix.normalize(path.posix.join(dir || ".", rel));
  return joined === "." ? "" : joined.replace(/^\.\//, "").replace(/\/$/, "");
}

/**
 * Candidate repo-relative base paths for a bare import specifier, using the
 * nearest config's `paths` then its `baseUrl`. Extension/index probing is
 * the caller's job.
 */
export function aliasCandidates(
  fromFile: string,
  request: string,
  aliases: PathAliases[],
): string[] {
  const config = aliases.find(
    (a) => a.configDir === "" || fromFile.startsWith(`${a.configDir}/`),
  );
  if (!config) return [];

  const out: string[] = [];
  for (const { pattern, targets } of config.paths) {
    const star = pattern.indexOf("*");
    if (star === -1) {
      if (request === pattern) out.push(...targets);
      continue;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      request.length >= prefix.length + suffix.length &&
      request.startsWith(prefix) &&
      request.endsWith(suffix)
    ) {
      const matched = request.slice(prefix.length, request.length - suffix.length);
      for (const target of targets) out.push(target.replace("*", matched));
    }
  }
  if (config.baseUrl !== null) {
    out.push(joinRepo(config.baseUrl, request));
  }
  return out;
}
