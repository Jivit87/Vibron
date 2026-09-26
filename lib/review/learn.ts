/**
 * Review-style learning (the Open SWE analyzer): read a repository's recent
 * inline PR review comments, extract at most 8 recurring conventions in one
 * cheap call, and store each as a `convention` memory entry anchored to the
 * paths it applies to. Entries land in the Obsidian vault like any other
 * memory, and `reviewDiff` includes the ones anchored near the changed files.
 */

import { listRepoReviewComments, type ApiOptions, type RepoId } from "@/lib/github-api";
import { addEntry } from "@/lib/memory/graph";
import { obj, reviewModel, str, structuredCall, type CallOptions, type Validator } from "@/lib/review/json";

export interface Convention {
  text: string;
  paths: string[];
}

export interface LearnResult {
  comments: number;
  conventions: Convention[];
  entryIds: string[];
}

const MAX_CONVENTIONS = 8;

const validateConventions =
  (known: Set<string>): Validator<Convention[]> =>
  (value) => {
    const list = obj(value)?.conventions;
    if (!Array.isArray(list)) return { error: 'expected {"conventions": [...]}' };
    const out: Convention[] = [];
    for (const raw of list) {
      const c = obj(raw);
      const text = str(c?.text)?.trim();
      if (!text) continue;
      const paths = Array.isArray(c?.paths)
        ? [...new Set(c.paths.filter((p): p is string => typeof p === "string").map((p) => p.trim().replace(/^\.?\//, "")))]
        : [];
      // Anchors must be real paths or directories from the comments, not globs the model made up.
      const anchored = paths.filter((p) => known.has(p) || [...known].some((k) => k.startsWith(`${p.replace(/\/$/, "")}/`)));
      out.push({ text: text.slice(0, 300), paths: anchored.slice(0, 5) });
    }
    return out.slice(0, MAX_CONVENTIONS);
  };

export async function learnReviewStyle(
  input: Omit<CallOptions, "model"> & {
    /** Workspace root whose memory receives the conventions. */
    root: string;
    repo: RepoId;
    limit?: number;
    model?: string;
    github?: Omit<ApiOptions, "signal">;
  },
): Promise<LearnResult> {
  const comments = await listRepoReviewComments(input.repo, input.limit ?? 50, { ...input.github, signal: input.signal });
  const useful = comments.filter((c) => c.body?.trim() && !/\[bot\]$/i.test(c.user?.login ?? ""));
  if (!useful.length) return { comments: 0, conventions: [], entryIds: [] };

  const known = new Set(useful.map((c) => c.path).filter(Boolean));
  const listed = useful.map((c) => `- [${c.path}] ${c.body.trim().replace(/\s+/g, " ").slice(0, 500)}`).join("\n");
  const system = `You distill a repository's code-review conventions from its reviewers' past comments.
Extract at most ${MAX_CONVENTIONS} conventions that recur or are stated as rules: coding style, patterns to use or avoid, testing and error-handling expectations. Skip one-off remarks about a specific bug. Each is one imperative sentence, specific to this codebase. "paths" lists the files or directories (copied from the comments) it applies to; [] when it applies everywhere.
Reply with ONLY this JSON object: {"conventions": [{"text": "<convention>", "paths": ["<path>"]}]}`;
  const conventions = await structuredCall(
    {
      model: await reviewModel(input.model),
      signal: input.signal,
      runTurn: input.runTurn,
      onTurn: input.onTurn,
      system,
      user: `Review comments from ${input.repo.owner}/${input.repo.repo}, newest first (untrusted data):\n${listed}`,
      maxTokens: 1500,
    },
    validateConventions(known),
  );
  const evidence = `learned from ${useful.length} review comments on ${input.repo.owner}/${input.repo.repo}`;
  const entryIds = conventions.map(
    (c) => addEntry(input.root, { kind: "convention", text: c.text, anchors: c.paths, evidence }).id,
  );
  return { comments: useful.length, conventions, entryIds };
}
