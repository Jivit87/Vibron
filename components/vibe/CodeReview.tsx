"use client";

/**
 * Review output, shared by Source Control (review / describe / improve on
 * local changes), the Review panel (a GitHub PR review) and the diff view
 * (findings on the lines they point at).
 */

import { useState } from "react";
import { ChevronRight, ExternalLink, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { findingLocation, isPrUrl, type Finding, type ReviewResult, type Severity, type Suggestion } from "@/lib/client/review";
import { shortRef } from "@/lib/client/deliver";
import { loadFile } from "@/lib/file-loader";
import { suggestionKey, useReview, type ApplyState, type LocalTarget, type ScmTool } from "@/store/review";
import { useProblems } from "@/store/problems";
import { useScm } from "@/store/scm";
import { useViberon } from "@/store/viberon";
import { cx, EmptyState, IconButton, MenuItem, Popover, splitPath } from "@/components/vibe/primitives";

export const SEVERITY: Record<Severity, { label: string; color: string }> = {
  high: { label: "high", color: "var(--vb-rose)" },
  medium: { label: "med", color: "var(--vb-amber)" },
  low: { label: "low", color: "var(--vb-text-dim)" },
};

/** Open the file a finding points at, scrolled to its line. */
export function openFinding(f: Pick<Finding, "file" | "line">): void {
  if (!f.file) return;
  const store = useViberon.getState();
  store.setAppMode("ide");
  void loadFile(store.repoKey, f.file);
  if (f.line) useProblems.getState().requestReveal(f.file, f.line, 1);
}

/* ------------------------------- findings -------------------------------- */

export function ReviewHeadline({ review }: { review: ReviewResult }) {
  const bits = [
    review.effort ? `effort ${review.effort}/5` : null,
    review.tests ? `tests ${review.tests}` : null,
    `${review.findings.length} finding${review.findings.length === 1 ? "" : "s"}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-0.5">
      {review.summary && (
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--vb-text-mid)" }}>
          {review.summary}
        </p>
      )}
      <p className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
        {bits.join(" · ")}
      </p>
      {review.security && (
        <p className="text-[12px] leading-relaxed" style={{ color: "var(--vb-rose)" }}>
          Security: <span style={{ color: "var(--vb-text)" }}>{review.security}</span>
        </p>
      )}
      {review.omitted.length > 0 && (
        <p className="truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }} title={review.omitted.join("\n")}>
          not reviewed (budget): {review.omitted.join(", ")}
        </p>
      )}
    </div>
  );
}

export function FindingRow({ finding, indent = 0 }: { finding: Finding; indent?: number }) {
  const sev = SEVERITY[finding.severity];
  const { name } = splitPath(finding.file);
  return (
    <button
      type="button"
      onClick={() => openFinding(finding)}
      disabled={!finding.file}
      className="flex w-full min-w-0 flex-col py-[3px] pr-2 text-left hover:bg-[var(--vb-hover)] disabled:hover:bg-transparent"
      style={{ paddingLeft: 8 + indent }}
      title={[findingLocation(finding), finding.title, finding.detail].filter(Boolean).join("\n\n")}
    >
      <span className="flex h-[18px] min-w-0 items-center gap-2 text-[12px]">
        <span className="w-[26px] shrink-0 font-mono text-[10.5px]" style={{ color: sev.color }}>
          {sev.label}
        </span>
        <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
          {finding.title}
        </span>
      </span>
      <span className="line-clamp-2 pl-[34px] text-[11.5px] leading-snug" style={{ color: "var(--vb-text-dim)" }}>
        {finding.file && (
          <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
            {name}
            {finding.line ? `:${finding.line}` : ""}
            {finding.detail ? " · " : ""}
          </span>
        )}
        {finding.detail}
      </span>
    </button>
  );
}

/* ------------------------------ suggestions ------------------------------ */

const APPLY_LABEL: Record<ApplyState, { label: string; color: string }> = {
  applying: { label: "applying", color: "var(--vb-text-dim)" },
  applied: { label: "applied", color: "var(--vb-mint)" },
  out_of_date: { label: "out of date", color: "var(--vb-amber)" },
  failed: { label: "write failed", color: "var(--vb-rose)" },
};

export function SuggestionRow({ suggestion }: { suggestion: Suggestion }) {
  const repoKey = useViberon((s) => s.repoKey);
  const state = useReview((s) => s.applied[suggestionKey(suggestion)]);
  const [open, setOpen] = useState(false);
  const { name } = splitPath(suggestion.file);
  const range =
    suggestion.startLine > 0
      ? suggestion.endLine > suggestion.startLine
        ? `:${suggestion.startLine}-${suggestion.endLine}`
        : `:${suggestion.startLine}`
      : "";
  const status = state ? APPLY_LABEL[state] : null;
  return (
    <div className="flex flex-col">
      <div className="group flex min-w-0 items-start gap-1.5 py-[3px] pr-1.5 pl-1 text-[12px] hover:bg-[var(--vb-hover)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
          aria-expanded={open}
          title={`${suggestion.file}${range}\n\n${suggestion.why}`}
        >
          <ChevronRight className={cx("mt-[2px] size-3.5 shrink-0", open && "rotate-90")} style={{ color: "var(--vb-text-dim)" }} />
          <span className="w-[16px] shrink-0 font-mono text-[10.5px] leading-[18px]" style={{ color: "var(--vb-text-mid)" }} title="Self-reflection score, 0–10">
            {suggestion.score.toFixed(0)}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate leading-[18px]" style={{ color: "var(--vb-text)" }}>
              {suggestion.why || "Suggested change"}
            </span>
            <span className="truncate font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {name}
              {range}
            </span>
          </span>
        </button>
        {status && state !== "applying" ? (
          <span className="shrink-0 font-mono text-[10.5px] leading-[18px]" style={{ color: status.color }}>
            {status.label}
          </span>
        ) : (
          <button
            type="button"
            className="vb-btn shrink-0" style={{ height: 20, padding: "0 6px", fontSize: 11.5 }}
            disabled={state === "applying"}
            onClick={() => void useReview.getState().apply(repoKey, suggestion)}
            title="Write the improved code to the file, if the existing code still matches"
          >
            {state === "applying" ? <Loader2 className="size-3 animate-spin" /> : "Apply"}
          </button>
        )}
      </div>
      {open && <SuggestionDiff suggestion={suggestion} />}
    </div>
  );
}

function SuggestionDiff({ suggestion }: { suggestion: Suggestion }) {
  const lines = (text: string) => text.replace(/\n$/, "").split("\n");
  return (
    <div className="mx-2 mb-1 overflow-x-auto rounded-[3px] border font-mono text-[11.5px] leading-[17px]" style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-void)" }}>
      {lines(suggestion.existing).map((line, i) => (
        <div key={`e${i}`} className="whitespace-pre px-1.5" style={{ background: "var(--vb-del-bg)", color: "var(--vb-text)" }}>
          <span className="mr-1.5 select-none" style={{ color: "var(--vb-del)" }}>−</span>
          {line}
        </div>
      ))}
      {lines(suggestion.improved).map((line, i) => (
        <div key={`i${i}`} className="whitespace-pre px-1.5" style={{ background: "var(--vb-add-bg)", color: "var(--vb-text)" }}>
          <span className="mr-1.5 select-none" style={{ color: "var(--vb-add)" }}>+</span>
          {line}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- describe -------------------------------- */

export function DescribeEditor() {
  const described = useReview((s) => s.described);
  const setDescribed = useReview((s) => s.setDescribed);
  if (!described) return null;
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      <input
        value={described.title}
        onChange={(e) => setDescribed({ title: e.target.value })}
        aria-label="Title"
        className="vb-input h-[24px] w-full text-[12.5px]"
      />
      <textarea
        value={described.body}
        onChange={(e) => setDescribed({ body: e.target.value })}
        aria-label="Body"
        rows={6}
        className="vb-input vb-textarea w-full resize-y font-mono text-[11.5px] leading-[17px]"
      />
    </div>
  );
}

/* ------------------------- Source Control section ------------------------- */

const TOOL_LABEL: Record<ScmTool, string> = { review: "Review", describe: "Describe", improve: "Improve" };

/** Target switch and the three tools, under the commit box. */
export function ScmReviewBar({ stagedCount, hasChanges }: { stagedCount: number; hasChanges: boolean }) {
  const repoKey = useViberon((s) => s.repoKey);
  const target = useReview((s) => s.target);
  const busy = useReview((s) => s.busy);
  const setTarget = useReview((s) => s.setTarget);
  const effective: LocalTarget = target === "staged" && stagedCount === 0 ? "working" : target;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Popover
        label={effective === "staged" ? "Staged" : "Working"}
        title="Which changes the tools read"
        placement="bottom"
        width={200}
      >
        {(close) =>
          (["working", "staged"] as const).map((value) => (
            <MenuItem
              key={value}
              active={effective === value}
              disabled={value === "staged" && stagedCount === 0}
              title={value === "working" ? "Working tree" : "Staged"}
              hint={value === "working" ? "Every uncommitted change" : stagedCount === 0 ? "Nothing staged" : `${stagedCount} staged file${stagedCount === 1 ? "" : "s"}`}
              onClick={() => {
                setTarget(value);
                close();
              }}
            />
          ))
        }
      </Popover>
      {(Object.keys(TOOL_LABEL) as ScmTool[]).map((tool) => (
        <button
          key={tool}
          type="button"
          className="vb-btn vb-btn-ghost min-w-0 flex-1"
          style={{ height: 22, padding: "0 4px" }}
          disabled={busy !== null || !hasChanges}
          onClick={() => {
            if (effective !== target) setTarget(effective);
            void useReview.getState().run(repoKey, tool);
          }}
          title={
            tool === "review"
              ? "Findings: bugs, security, tests"
              : tool === "describe"
                ? "Write a title and description for these changes"
                : "Code suggestions, scored and filtered"
          }
        >
          {busy === tool && <Loader2 className="size-3 animate-spin" />}
          {TOOL_LABEL[tool]}
        </button>
      ))}
    </div>
  );
}

/** The result of the last tool run, as a collapsible Source Control section. */
export function ScmReviewSection() {
  const shown = useReview((s) => s.shown);
  const busy = useReview((s) => s.busy);
  const error = useReview((s) => s.error);
  const review = useReview((s) => s.review);
  const described = useReview((s) => s.described);
  const suggestions = useReview((s) => s.suggestions);
  const target = useReview((s) => s.target);
  const [open, setOpen] = useState(true);
  if (!shown) return null;

  const count =
    shown === "review" ? (review?.findings.length ?? 0) : shown === "improve" ? suggestions.length : undefined;
  const label = shown === "review" ? "Review" : shown === "describe" ? "Description" : "Suggestions";

  return (
    <div className="mb-1 flex flex-col border-b pb-1" style={{ borderColor: "var(--vb-line)" }}>
      <div className="group flex h-[22px] items-center pl-1 pr-1.5 hover:bg-[var(--vb-hover)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: "var(--vb-text-mid)" }}
        >
          <ChevronRight className={cx("size-3.5 shrink-0", open && "rotate-90")} />
          <span className="truncate">{label}</span>
          <span className="ml-1 font-mono text-[10.5px] font-normal normal-case tracking-normal" style={{ color: "var(--vb-text-faint)" }}>
            {target}
          </span>
        </button>
        <span className="hidden items-center group-hover:flex">
          <IconButton title="Dismiss" onClick={() => useReview.getState().setShown(null)}>
            <X className="size-3.5" />
          </IconButton>
        </span>
        {count !== undefined && busy !== shown && (
          <span
            className="ml-1 min-w-[18px] rounded-[3px] px-1 text-center font-mono text-[10.5px]"
            style={{ background: "var(--vb-fill)", color: "var(--vb-text-mid)" }}
          >
            {count}
          </span>
        )}
      </div>
      {open &&
        (busy === shown ? (
          <div className="flex flex-col gap-1.5 px-6 py-1.5">
            <div className="vb-shimmer h-3 w-3/4 rounded-[3px]" />
            <div className="vb-shimmer h-3 w-1/2 rounded-[3px]" />
          </div>
        ) : error ? (
          <p className="px-6 py-1 text-[12px] leading-relaxed" style={{ color: "var(--vb-rose)" }}>
            {error}
          </p>
        ) : shown === "review" && review ? (
          <div className="flex flex-col gap-1">
            <div className="pl-6 pr-2">
              <ReviewHeadline review={review} />
            </div>
            <div className="flex flex-col">
              {review.findings.map((f, i) => (
                <FindingRow key={`${f.file}:${f.line}:${i}`} finding={f} indent={8} />
              ))}
            </div>
          </div>
        ) : shown === "describe" && described ? (
          <div className="flex flex-col">
            <DescribeEditor />
            <div className="flex items-center gap-1 px-2">
              <button
                type="button"
                className="vb-btn" style={{ height: 22 }}
                onClick={() => {
                  useScm.getState().setCommitMessage(described.body ? `${described.title}\n\n${described.body}` : described.title);
                  toast.success("Copied into the commit message");
                }}
              >
                Use as commit message
              </button>
              {described.type && (
                <span className="font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
                  {described.type}
                </span>
              )}
            </div>
          </div>
        ) : shown === "improve" ? (
          suggestions.length === 0 ? (
            <p className="px-6 py-1 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
              No suggestions scored above the threshold.
            </p>
          ) : (
            <div className="flex flex-col pl-3">
              {suggestions.map((s) => (
                <SuggestionRow key={suggestionKey(s)} suggestion={s} />
              ))}
            </div>
          )
        ) : null)}
    </div>
  );
}

/* ----------------------- Review panel (bottom, PR) ----------------------- */

/** The bottom "Review" panel: the last GitHub PR review, else the local one. */
export function ReviewPanel() {
  const pr = useReview((s) => s.pr);
  const local = useReview((s) => s.review);
  const review = pr ? pr.review : local;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-[26px] shrink-0 items-center gap-2 border-b px-3 text-[12px]" style={{ borderColor: "var(--vb-line-faint)" }}>
        {pr ? (
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex min-w-0 items-center gap-1 font-mono text-[11.5px] hover:underline"
            style={{ color: "var(--vb-text)" }}
          >
            <span className="truncate">{shortRef(pr.url)}</span>
            <ExternalLink className="size-3 shrink-0" style={{ color: "var(--vb-text-faint)" }} />
          </a>
        ) : (
          <span style={{ color: "var(--vb-text-mid)" }}>{local ? "Working changes" : "No review yet"}</span>
        )}
        {pr?.loading && <Loader2 className="size-3.5 animate-spin" style={{ color: "var(--vb-text-dim)" }} />}
        <div className="flex-1" />
        <PrUrlInput />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pr?.error ? (
          <p className="px-3 py-2 text-[12px]" style={{ color: "var(--vb-rose)" }}>
            {pr.error}
          </p>
        ) : pr?.loading ? (
          <p className="px-3 py-2 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
            Fetching the diff and reviewing…
          </p>
        ) : !review ? (
          <EmptyState title="No review yet" body="Run Review in Source Control, or “Review a GitHub pull request…” from the command palette (⌘K)." />
        ) : (
          <div className="flex flex-col gap-1 py-1.5">
            <div className="px-3">
              <ReviewHeadline review={review} />
            </div>
            <div className="flex flex-col">
              {review.findings.map((f, i) => (
                <FindingRow key={`${f.file}:${f.line}:${i}`} finding={f} indent={4} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PrUrlInput() {
  const [value, setValue] = useState("");
  const [bad, setBad] = useState(false);
  return (
    <input
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        setBad(false);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        const url = value.trim();
        if (!isPrUrl(url)) {
          setBad(true);
          return;
        }
        setValue("");
        void useReview.getState().reviewPr(useViberon.getState().repoKey, url);
      }}
      placeholder="Review a pull request URL"
      aria-label="Pull request URL"
      aria-invalid={bad || undefined}
      className="vb-input w-[260px]"
      style={{ height: 20, fontSize: 11.5, ...(bad ? { borderColor: "var(--vb-rose)" } : {}) }}
    />
  );
}
