"use client";

/**
 * Source Control, VS Code-style: commit box, branch, then Merge / Staged /
 * Changes / Untracked sections as dense rows with hover actions. Clicking a
 * row opens a diff tab.
 */

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  FileText,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Undo2,
} from "lucide-react";
import { toast } from "sonner";

import { groupScmFiles, type GitChangeGroup, type GitFileChange } from "@/lib/client/workspace-types";
import { diffTabPath, useScm, type ScmOp } from "@/store/scm";
import { useViberon } from "@/store/viberon";
import { cx, EmptyState, IconButton, PanelHeader, Popover, splitPath } from "@/components/vibe/primitives";
import { ScmReviewBar, ScmReviewSection, SEVERITY } from "@/components/vibe/CodeReview";
import { findingsForPath } from "@/lib/client/review";
import { useReview } from "@/store/review";

const LETTER_COLOR: Record<string, string> = {
  M: "var(--vb-amber)",
  A: "var(--vb-add)",
  U: "var(--vb-add)",
  "?": "var(--vb-add)",
  D: "var(--vb-del)",
  R: "var(--vb-text-mid)",
  C: "var(--vb-text-mid)",
  "!": "var(--vb-rose)",
};

export function ScmPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const model = useViberon((s) => s.settings.model);
  const { snapshot, loading, error, busy, commitMessage, unavailable } = useScm();
  const setCommitMessage = useScm((s) => s.setCommitMessage);
  const run = useScm((s) => s.run);
  const refresh = useScm((s) => s.refresh);

  useEffect(() => {
    if (repoKey) void refresh(repoKey);
  }, [repoKey, refresh]);

  const files = snapshot?.status?.files;
  const sections = useMemo(() => groupScmFiles(files ?? []), [files]);
  const stagedCount = files?.filter((f) => f.group === "staged").length ?? 0;

  async function act(op: ScmOp, payload?: { paths?: string[]; all?: boolean; message?: string; name?: string }) {
    const result = await run(repoKey, op, payload);
    if (!result.ok) toast.error(result.error ?? `git ${op} failed`);
    return result;
  }

  async function commit() {
    const message = commitMessage.trim();
    if (!message) {
      toast.error("Enter a commit message.");
      return;
    }
    const result = await act("commit", { message });
    if (result.ok) setCommitMessage("");
  }

  const header = (
    <PanelHeader
      title="Source Control"
      actions={
        <div className="flex items-center">
          <IconButton title="Refresh" onClick={() => void refresh(repoKey)}>
            <RefreshCw className={cx("size-3.5", loading && "animate-spin")} />
          </IconButton>
          {snapshot?.isRepo && (
            <Popover
              label={<MoreHorizontal className="size-3.5" />}
              title="More actions"
              placement="bottom"
              align="right"
              chevron={false}
              width={170}
            >
              {(close) =>
                (["fetch", "pull", "push"] as const).map((op) => (
                  <button
                    key={op}
                    type="button"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      close();
                      void act(op).then((r) => r.ok && toast.success(`${op[0].toUpperCase()}${op.slice(1)} complete`));
                    }}
                    className="flex h-[24px] w-full items-center px-2.5 text-left text-[12.5px] capitalize hover:bg-[var(--vb-hover)]"
                    style={{ color: "var(--vb-text)" }}
                  >
                    {op}
                  </button>
                ))
              }
            </Popover>
          )}
        </div>
      }
    />
  );

  if (unavailable) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState title="Source control is not available" body="This server does not expose the git API yet." />
      </div>
    );
  }
  if (!snapshot) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState title={error ?? "Reading repository…"} />
      </div>
    );
  }
  if (snapshot.virtual) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState title="No folder on disk" body="This workspace lives in memory. Open a local folder to use git." />
      </div>
    );
  }
  if (!snapshot.gitAvailable) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState title="git was not found" body="Install git and make sure it is on your PATH." />
      </div>
    );
  }
  if (!snapshot.isRepo) {
    return (
      <div className="flex h-full flex-col">
        {header}
        <EmptyState
          title="Not a git repository"
          body={snapshot.parentRepo ? `Inside ${snapshot.parentRepo}.` : undefined}
          action={
            <button type="button" className="vb-btn vb-btn-primary" onClick={() => void act("init")}>
              Initialize repository
            </button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div className="flex flex-col gap-1.5 border-b p-2" style={{ borderColor: "var(--vb-line)" }}>
        <textarea
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void commit();
            }
          }}
          rows={2}
          placeholder={`Message (⌘↵ to commit on ${snapshot.status?.branch.head ?? "HEAD"})`}
          aria-label="Commit message"
          className="w-full resize-y rounded-[3px] border px-2 py-1 text-[12.5px] outline-none focus:border-[var(--vb-accent-line)]"
          style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-input)", color: "var(--vb-text-hi)" }}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="vb-btn vb-btn-primary flex-1"
            disabled={busy !== null || stagedCount === 0 || !commitMessage.trim()}
            onClick={() => void commit()}
            title={stagedCount === 0 ? "Stage changes first" : `Commit ${stagedCount} staged`}
          >
            <Check className="size-3.5" />
            Commit{stagedCount > 0 ? ` ${stagedCount}` : ""}
          </button>
          <button
            type="button"
            className="vb-btn"
            disabled={busy !== null || !files?.length}
            title="Write a message from the staged diff"
            onClick={() =>
              void useScm
                .getState()
                .generateMessage(repoKey, model)
                .then((r) => !r.ok && toast.error(r.error ?? "Could not generate a message."))
            }
          >
            Generate
          </button>
        </div>
        <BranchRow />
        <ScmReviewBar stagedCount={stagedCount} hasChanges={Boolean(files?.length)} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        <ScmReviewSection />
        {sections.length === 0 && <EmptyState title="No changes" />}
        {sections.map((section) => (
          <Section
            key={section.group}
            group={section.group}
            label={section.label}
            files={section.files}
            busy={busy !== null}
            onAct={act}
          />
        ))}
        {snapshot.log && snapshot.log.length > 0 && <History />}
      </div>
    </div>
  );
}

function BranchRow() {
  const repoKey = useViberon((s) => s.repoKey);
  const snapshot = useScm((s) => s.snapshot);
  const busy = useScm((s) => s.busy);
  const [name, setName] = useState("");
  const branch = snapshot?.status?.branch;
  if (!branch) return null;

  async function switchTo(target: string, create = false) {
    const result = await useScm.getState().run(repoKey, create ? "createBranch" : "switch", { name: target });
    if (!result.ok) toast.error(result.error ?? "Could not switch branch.");
  }

  return (
    <div className="flex items-center gap-1 text-[12px]" style={{ color: "var(--vb-text-dim)" }}>
      <Popover
        label={branch.head ?? `detached ${branch.oid ?? ""}`}
        title="Switch branch"
        placement="bottom"
        width={240}
      >
        {(close) => (
          <>
            {(snapshot?.branches ?? []).map((b) => (
              <button
                key={b.name}
                type="button"
                disabled={b.current || busy !== null}
                onClick={() => {
                  close();
                  void switchTo(b.name);
                }}
                className="flex h-[24px] w-full items-center gap-2 px-2.5 text-left text-[12.5px] hover:bg-[var(--vb-hover)] disabled:hover:bg-transparent"
                style={{ color: b.current ? "var(--vb-text-hi)" : "var(--vb-text)" }}
              >
                <span className="w-3">{b.current && <Check className="size-3" />}</span>
                <span className="truncate">{b.name}</span>
              </button>
            ))}
            <div className="mt-1 flex gap-1 border-t px-2 pt-1.5 pb-0.5" style={{ borderColor: "var(--vb-line)" }}>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && name.trim()) {
                    close();
                    void switchTo(name.trim(), true);
                    setName("");
                  }
                }}
                placeholder="New branch name"
                className="vb-input h-[22px] min-w-0 flex-1 text-[12px]"
              />
            </div>
          </>
        )}
      </Popover>
      <div className="flex-1" />
      {(branch.ahead > 0 || branch.behind > 0) && (
        <span className="flex items-center gap-1.5 font-mono text-[11px]" title={branch.upstream ?? undefined}>
          <span className="flex items-center">
            <ArrowDown className="size-3" />
            {branch.behind}
          </span>
          <span className="flex items-center">
            <ArrowUp className="size-3" />
            {branch.ahead}
          </span>
        </span>
      )}
    </div>
  );
}

function Section({
  group,
  label,
  files,
  busy,
  onAct,
}: {
  group: GitChangeGroup;
  label: string;
  files: GitFileChange[];
  busy: boolean;
  onAct: (op: ScmOp, payload?: { paths?: string[]; all?: boolean }) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(true);
  const paths = files.map((f) => f.path);
  return (
    <div className="flex flex-col">
      <div className="group flex h-[22px] items-center pl-1 pr-1.5 hover:bg-[var(--vb-hover)]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold uppercase tracking-[0.04em]"
          style={{ color: "var(--vb-text-mid)" }}
        >
          <ChevronRight className={cx("size-3.5 shrink-0", open && "rotate-90")} />
          <span className="truncate">{label}</span>
        </button>
        <span className="hidden items-center group-hover:flex">
          {group === "staged" ? (
            <IconButton title="Unstage all" disabled={busy} onClick={() => void onAct("unstage", { paths })}>
              <Minus className="size-3.5" />
            </IconButton>
          ) : group !== "conflicts" ? (
            <>
              <IconButton title="Discard all" disabled={busy} onClick={() => confirmDiscard(paths, onAct)}>
                <Undo2 className="size-3.5" />
              </IconButton>
              <IconButton title="Stage all" disabled={busy} onClick={() => void onAct("stage", { paths })}>
                <Plus className="size-3.5" />
              </IconButton>
            </>
          ) : null}
        </span>
        <span
          className="ml-1 min-w-[18px] rounded-[3px] px-1 text-center font-mono text-[10.5px]"
          style={{ background: "var(--vb-fill)", color: "var(--vb-text-mid)" }}
        >
          {files.length}
        </span>
      </div>
      {open &&
        files.map((file) => <FileRow key={`${group}:${file.path}`} file={file} busy={busy} onAct={onAct} />)}
    </div>
  );
}

function confirmDiscard(paths: string[], onAct: (op: ScmOp, payload?: { paths?: string[] }) => Promise<unknown>) {
  const label = paths.length === 1 ? paths[0] : `${paths.length} files`;
  if (window.confirm(`Discard changes to ${label}? This cannot be undone.`)) {
    void onAct("discard", { paths });
  }
}

function FileRow({
  file,
  busy,
  onAct,
}: {
  file: GitFileChange;
  busy: boolean;
  onAct: (op: ScmOp, payload?: { paths?: string[] }) => Promise<unknown>;
}) {
  const { name, dir } = splitPath(file.path);
  const mode = file.group === "staged" ? "staged" : file.group === "untracked" ? "untracked" : "changes";
  const deleted = file.letter === "D";
  const findings = useReview((s) => s.review?.findings);
  const mine = useMemo(() => findingsForPath(findings ?? [], file.path), [findings, file.path]);

  function openDiff() {
    const store = useViberon.getState();
    store.openTab(diffTabPath(mode, file.path), undefined, {
      preview: true,
      label: `${name} (${mode === "staged" ? "Index" : "Working Tree"})`,
    });
  }

  return (
    <div
      className="group flex h-[22px] cursor-pointer items-center gap-1.5 pl-6 pr-1.5 hover:bg-[var(--vb-hover)]"
      onClick={openDiff}
      title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
    >
      <span
        className={cx("min-w-0 truncate text-[12.5px]", deleted && "line-through")}
        style={{ color: "var(--vb-text)" }}
      >
        {name}
      </span>
      <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: "var(--vb-text-faint)" }}>
        {dir}
      </span>
      <span className="hidden items-center group-hover:flex" onClick={(e) => e.stopPropagation()}>
        {!deleted && (
          <IconButton
            title="Open file"
            onClick={() => useViberon.getState().openTab(file.path, undefined, { preview: true })}
          >
            <FileText className="size-3.5" />
          </IconButton>
        )}
        {file.group === "staged" ? (
          <IconButton title="Unstage" disabled={busy} onClick={() => void onAct("unstage", { paths: [file.path] })}>
            <Minus className="size-3.5" />
          </IconButton>
        ) : (
          <>
            {file.group !== "conflicts" && (
              <IconButton title="Discard changes" disabled={busy} onClick={() => confirmDiscard([file.path], onAct)}>
                <Undo2 className="size-3.5" />
              </IconButton>
            )}
            <IconButton title="Stage" disabled={busy} onClick={() => void onAct("stage", { paths: [file.path] })}>
              <Plus className="size-3.5" />
            </IconButton>
          </>
        )}
      </span>
      {mine.length > 0 && (
        <span
          className="shrink-0 font-mono text-[10.5px]"
          style={{ color: SEVERITY[mine[0].severity].color }}
          title={mine.map((f) => `${f.severity}: ${f.title}`).join("\n")}
        >
          {mine.length}
        </span>
      )}
      <span
        className="w-3 shrink-0 text-center font-mono text-[11.5px]"
        style={{ color: LETTER_COLOR[file.letter] ?? "var(--vb-text-mid)" }}
      >
        {file.letter}
      </span>
    </div>
  );
}

function History() {
  const log = useScm((s) => s.snapshot?.log ?? []);
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1 flex flex-col border-t pt-1" style={{ borderColor: "var(--vb-line)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-[22px] items-center gap-1 pl-1 text-left text-[11px] font-semibold uppercase tracking-[0.04em] hover:bg-[var(--vb-hover)]"
        style={{ color: "var(--vb-text-mid)" }}
      >
        <ChevronRight className={cx("size-3.5", open && "rotate-90")} />
        History
      </button>
      {open &&
        log.slice(0, 30).map((c) => (
          <div key={c.hash} className="flex h-[22px] items-center gap-2 pl-6 pr-2 text-[12px]" title={`${c.hash}\n${c.author}`}>
            <span className="min-w-0 flex-1 truncate" style={{ color: "var(--vb-text)" }}>
              {c.subject}
            </span>
            <span className="shrink-0 font-mono text-[11px]" style={{ color: "var(--vb-text-faint)" }}>
              {c.shortHash}
            </span>
          </div>
        ))}
    </div>
  );
}
