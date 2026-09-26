"use client";

/**
 * Code review state (client): Review / Describe / Improve on the working or
 * staged changes, a GitHub PR review from the command palette, and which
 * suggestions were applied. A separate slice so Source Control, the diff
 * view and the Review panel share one result without widening the main store.
 */

import { create } from "zustand";
import { toast } from "sonner";

import { saveFile } from "@/lib/file-loader";
import { isMockMode, mockWorkingSource } from "@/lib/client/mock-run";
import {
  applySuggestion,
  normalizeDescribe,
  normalizeLearn,
  normalizeReview,
  normalizeSuggestions,
  postReview,
  type Described,
  type Finding,
  type ReviewResult,
  type Suggestion,
} from "@/lib/client/review";
import { useViberon } from "@/store/viberon";

export type LocalTarget = "working" | "staged";
export type ScmTool = "review" | "describe" | "improve";
export type ApplyState = "applying" | "applied" | "out_of_date" | "failed";

interface PrReview {
  url: string;
  loading: boolean;
  error: string | null;
  review: ReviewResult | null;
}

interface ReviewState {
  target: LocalTarget;
  busy: ScmTool | null;
  error: string | null;
  /** Which tool produced the section currently shown in Source Control. */
  shown: ScmTool | null;
  review: ReviewResult | null;
  described: Described | null;
  suggestions: Suggestion[];
  applied: Record<string, ApplyState>;
  pr: PrReview | null;
  learning: boolean;

  setTarget: (target: LocalTarget) => void;
  setShown: (tool: ScmTool | null) => void;
  setDescribed: (patch: Partial<Described>) => void;
  run: (repoKey: string, tool: ScmTool) => Promise<void>;
  reviewPr: (repoKey: string, url: string) => Promise<void>;
  learn: (repoKey: string) => Promise<void>;
  apply: (repoKey: string, suggestion: Suggestion) => Promise<ApplyState>;
  clear: () => void;
}

export function suggestionKey(s: Pick<Suggestion, "file" | "startLine" | "existing">): string {
  return `${s.file}:${s.startLine}:${s.existing.length}:${s.existing.slice(0, 40)}`;
}

let runSeq = 0;

export const useReview = create<ReviewState>((set, get) => ({
  target: "working",
  busy: null,
  error: null,
  shown: null,
  review: null,
  described: null,
  suggestions: [],
  applied: {},
  pr: null,
  learning: false,

  setTarget: (target) => set({ target }),
  setShown: (shown) => set({ shown }),
  setDescribed: (patch) => {
    const current = get().described ?? { title: "", body: "" };
    set({ described: { ...current, ...patch } });
  },
  clear: () => set({ review: null, described: null, suggestions: [], applied: {}, shown: null, error: null }),

  run: async (repoKey, tool) => {
    if (!repoKey || get().busy) return;
    const seq = ++runSeq;
    set({ busy: tool, error: null, shown: tool });
    const model = useViberon.getState().settings.model;
    const result = await postReview({ repoKey, target: get().target, tool, model });
    if (seq !== runSeq) return;
    if (!result.ok) {
      set({ busy: null, error: result.error ?? "Review failed." });
      return;
    }
    if (tool === "review") {
      const review = normalizeReview(result.body);
      set({ busy: null, review, error: review ? null : "The review came back empty." });
    } else if (tool === "describe") {
      const described = normalizeDescribe(result.body);
      set({ busy: null, described, error: described ? null : "The description came back empty." });
    } else {
      const suggestions = normalizeSuggestions(result.body);
      set({ busy: null, suggestions, applied: {}, error: null });
    }
  },

  reviewPr: async (repoKey, url) => {
    set({ pr: { url, loading: true, error: null, review: null } });
    useViberon.getState().setAppMode("ide");
    useViberon.getState().setBottomPanel("review");
    const model = useViberon.getState().settings.model;
    const result = await postReview({ repoKey, target: { prUrl: url }, tool: "review", model });
    if (get().pr?.url !== url) return;
    if (!result.ok) {
      set({ pr: { url, loading: false, error: result.error ?? "Review failed.", review: null } });
      return;
    }
    const review = normalizeReview(result.body);
    set({ pr: { url, loading: false, error: review ? null : "The review came back empty.", review } });
  },

  learn: async (repoKey) => {
    if (get().learning) return;
    set({ learning: true });
    const id = toast.loading("Learning review style from past PR comments…");
    const result = await postReview({ repoKey, tool: "learn", target: "working" });
    set({ learning: false });
    if (!result.ok) {
      toast.error(result.error ?? "Could not learn the review style.", { id });
      return;
    }
    const { count, notes } = normalizeLearn(result.body);
    toast.success(
      count > 0 ? `Saved ${count} convention note${count === 1 ? "" : "s"} to memory` : "No new conventions found",
      { id, description: notes.slice(0, 4).join(" · ") || undefined },
    );
  },

  apply: async (repoKey, suggestion) => {
    const key = suggestionKey(suggestion);
    const mark = (state: ApplyState) => set((s) => ({ applied: { ...s.applied, [key]: state } }));
    mark("applying");
    const source = await readSource(repoKey, suggestion.file);
    if (source === null) {
      mark("failed");
      return "failed";
    }
    const next = applySuggestion(source, suggestion);
    if (!next.ok) {
      mark("out_of_date");
      return "out_of_date";
    }
    // The editor's own save path: updates the open tab, then PUTs the file.
    let ok = true;
    if (isMockMode()) useViberon.getState().updateTabSource(suggestion.file, next.source);
    else ok = await saveFile(repoKey, suggestion.file, next.source);
    mark(ok ? "applied" : "failed");
    return ok ? "applied" : "failed";
  },
}));

/** The file as the editor sees it: an open tab wins over the server copy. */
async function readSource(repoKey: string, path: string): Promise<string | null> {
  const tab = useViberon.getState().tabs.find((t) => t.path === path);
  if (typeof tab?.source === "string") return tab.source;
  if (isMockMode()) return mockWorkingSource(path);
  try {
    const response = await fetch(`/api/repos/files/${repoKey}?path=${encodeURIComponent(path)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { source?: unknown };
    return typeof body.source === "string" ? body.source : null;
  } catch {
    return null;
  }
}

/** Every finding the UI knows about (local review first, then the PR review). */
export function allFindings(state: Pick<ReviewState, "review" | "pr">): Finding[] {
  return [...(state.review?.findings ?? []), ...(state.pr?.review?.findings ?? [])];
}
