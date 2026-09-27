"use client";

/**
 * Plans + experiments sidebar.
 *
 * Versions: every plan the orchestrator produced or ran, with its lineage
 * and runs. Open one to review and edit it in the run view, re-run it, or
 * compare two structurally. Experiments: fork a task (or a plan version)
 * into variant branches, each in its own worktree, compare them on the
 * harness's evidence, and promote the winner (undoable) or discard them.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Check,
  ChevronRight,
  FlaskConical,
  GitFork,
  Loader2,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";

import { compareExperiment } from "@/lib/experiments/compare";
import type { ExperimentRecord } from "@/lib/experiments/types";
import type { PlanDiff } from "@/lib/plans/diff";
import type { PlanVersionSummary } from "@/lib/plans/types";
import { refreshWorkspace, reviewPlanVersion, runPlan } from "@/lib/client/agent-stream";
import {
  applyExperimentEvent,
  comparePatches,
  createExperimentRequest,
  diffPlanVersions,
  discardExperimentRequest,
  followExperiment,
  getPlanVersion,
  listExperimentRecords,
  listPlanVersions,
  promoteExperimentBranch,
  undoExperimentPromotion,
  variantsFromForm,
  type PlanDetail,
} from "@/lib/client/plans";
import { useViberon } from "@/store/viberon";
import {
  cx,
  DiffCounts,
  Dot,
  EmptyState,
  formatAgo,
  formatCost,
  formatDuration,
  formatTokens,
  IconButton,
  PanelHeader,
  RoleChip,
  Segmented,
} from "@/components/vibe/primitives";

type Tab = "versions" | "experiments";

const STATUS_COLOR: Record<string, string> = {
  done: "var(--vb-mint)",
  resolved: "var(--vb-mint)",
  unverified: "var(--vb-amber)",
  incomplete: "var(--vb-amber)",
  running: "var(--vb-accent)",
  queued: "var(--vb-text-mid)",
  failed: "var(--vb-rose)",
  error: "var(--vb-rose)",
  cancelled: "var(--vb-text-faint)",
  interrupted: "var(--vb-text-faint)",
  discarded: "var(--vb-text-faint)",
};

const shortId = (id: string) => id.slice(-6);

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em]" style={{ color: "var(--vb-text-faint)" }}>
      {children}
    </span>
  );
}

export function PlansPanel() {
  const repoKey = useViberon((s) => s.repoKey);
  const runStatus = useViberon((s) => s.run?.status);
  const [tab, setTab] = useState<Tab>("versions");
  const [versions, setVersions] = useState<PlanVersionSummary[]>([]);
  const [experiments, setExperiments] = useState<ExperimentRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** The version an experiment will fork from, when started from a version. */
  const [forkFrom, setForkFrom] = useState<PlanVersionSummary | null>(null);

  const load = useCallback(async () => {
    if (!repoKey) return;
    setLoading(true);
    const [v, e] = await Promise.all([listPlanVersions(repoKey), listExperimentRecords(repoKey)]);
    setLoading(false);
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setError(null);
    setVersions(v.data.versions);
    if (e.ok) setExperiments(e.data.experiments);
  }, [repoKey]);

  useEffect(() => {
    void load();
  }, [load, runStatus]);

  const upsertExperiment = useCallback((record: ExperimentRecord) => {
    setExperiments((list) => [record, ...list.filter((x) => x.id !== record.id)].sort((a, b) => b.createdAt - a.createdAt));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Plans"
        icon={<GitFork className="size-3" />}
        actions={
          <IconButton title="Refresh" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cx("size-3", loading && "animate-spin")} />
          </IconButton>
        }
      />
      <div className="flex shrink-0 items-center px-2 pt-2">
        <Segmented<Tab>
          value={tab}
          onChange={setTab}
          options={[
            { value: "versions", label: `Versions${versions.length ? ` ${versions.length}` : ""}` },
            { value: "experiments", label: `Experiments${experiments.length ? ` ${experiments.length}` : ""}` },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error ? (
          <EmptyState title="Plans are unavailable" body={error} />
        ) : tab === "versions" ? (
          <VersionsTab
            repoKey={repoKey}
            versions={versions}
            onExperiment={(v) => {
              setForkFrom(v);
              setTab("experiments");
            }}
          />
        ) : (
          <ExperimentsTab
            repoKey={repoKey}
            experiments={experiments}
            forkFrom={forkFrom}
            clearFork={() => setForkFrom(null)}
            onChange={upsertExperiment}
            reload={() => void load()}
          />
        )}
      </div>
    </div>
  );
}

/* ------------------------------ versions --------------------------------- */

function VersionsTab({
  repoKey,
  versions,
  onExperiment,
}: {
  repoKey: string;
  versions: PlanVersionSummary[];
  onExperiment: (v: PlanVersionSummary) => void;
}) {
  const streaming = useViberon((s) => s.streaming);
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [diff, setDiff] = useState<PlanDiff | null>(null);

  useEffect(() => {
    if (!open) return setDetail(null);
    let live = true;
    void getPlanVersion(repoKey, open).then((r) => {
      if (!live) return;
      if (r.ok) setDetail(r.data);
      else toast.error(r.error);
    });
    return () => {
      live = false;
    };
  }, [open, repoKey]);

  useEffect(() => {
    if (compare.length !== 2) return setDiff(null);
    let live = true;
    void diffPlanVersions(repoKey, compare[0]!, compare[1]!).then((r) => {
      if (!live) return;
      if (r.ok) setDiff(r.data.diff);
      else toast.error(r.error);
    });
    return () => {
      live = false;
    };
  }, [compare, repoKey]);

  if (versions.length === 0) {
    return (
      <EmptyState
        title="No plan versions yet"
        body="Every plan the team of agents makes is saved here as an immutable version. Use Plan mode in the composer to review a plan before it runs."
      />
    );
  }

  const toggleCompare = (id: string) =>
    setCompare((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id].slice(-2)));

  return (
    <div className="flex flex-col gap-3">
      {compare.length > 0 && (
        <section className="vb-box flex flex-col gap-1 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--vb-text-mid)" }}>
            <ArrowRightLeft className="size-3" />
            {compare.length === 1 ? (
              <span>Pick a second version to compare with {shortId(compare[0]!)}.</span>
            ) : (
              <span className="font-mono">
                {shortId(compare[0]!)} → {shortId(compare[1]!)}
              </span>
            )}
            <div className="flex-1" />
            <button type="button" className="vb-btn vb-btn-ghost" onClick={() => setCompare([])}>
              Clear
            </button>
          </div>
          {diff && <PlanDiffView diff={diff} />}
        </section>
      )}

      <section className="flex flex-col gap-0.5">
        <SectionLabel>Versions</SectionLabel>
        {versions.map((v) => {
          const expanded = open === v.id;
          const outcome = v.lastOutcome;
          return (
            <div key={v.id} className="flex flex-col">
              <div
                className="group flex items-start gap-1.5 rounded px-1 py-1 hover:bg-[var(--vb-hover)]"
                data-selected={expanded || undefined}
              >
                <button
                  type="button"
                  className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center"
                  style={{ color: "var(--vb-text-dim)" }}
                  onClick={() => setOpen(expanded ? null : v.id)}
                  title={expanded ? "Collapse" : "Show steps and runs"}
                >
                  <ChevronRight className={cx("size-3.5", expanded && "rotate-90")} />
                </button>
                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setOpen(expanded ? null : v.id)}>
                  <span className="block truncate text-[11.5px]" style={{ color: "var(--vb-text)" }} title={v.prompt}>
                    {v.prompt || "(no prompt)"}
                  </span>
                  <span className="flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                    <span title={v.id}>{shortId(v.id)}</span>
                    <span>{v.origin}</span>
                    <span>
                      {v.steps}s/{v.waves}w
                    </span>
                    <span>{formatAgo(v.createdAt)}</span>
                    {!v.intact && <span style={{ color: "var(--vb-rose)" }}>modified</span>}
                  </span>
                </button>
                {outcome && (
                  <span className="mt-1" title={`Last run: ${outcome.status}`}>
                    <Dot color={STATUS_COLOR[outcome.status] ?? "var(--vb-text-faint)"} size={6} />
                  </span>
                )}
                <label
                  className="mt-0.5 flex shrink-0 items-center"
                  title="Select to compare"
                  style={{ opacity: compare.includes(v.id) ? 1 : undefined }}
                >
                  <input
                    type="checkbox"
                    className="size-3 accent-[var(--vb-accent)] opacity-40 group-hover:opacity-100"
                    checked={compare.includes(v.id)}
                    onChange={() => toggleCompare(v.id)}
                    aria-label={`Compare version ${shortId(v.id)}`}
                  />
                </label>
              </div>

              {expanded && detail?.version.id === v.id && (
                <div className="ml-5 flex flex-col gap-2 border-l py-1.5 pl-2" style={{ borderColor: "var(--vb-line)" }}>
                  {detail.version.plan.summary && (
                    <p className="text-[11.5px] leading-relaxed" style={{ color: "var(--vb-text-mid)" }}>
                      {detail.version.plan.summary}
                    </p>
                  )}
                  <ol className="flex flex-col gap-1">
                    {detail.version.plan.steps.map((step, i) => (
                      <li key={step.id} className="flex flex-col">
                        <span className="flex items-center gap-1.5 text-[11.5px]" style={{ color: "var(--vb-text)" }}>
                          <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                            {i + 1}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{step.title}</span>
                          <RoleChip role={step.role} />
                        </span>
                        {step.files.length > 0 && (
                          <span className="truncate pl-3.5 font-mono text-[10.5px]" style={{ color: "var(--vb-text-dim)" }} title={step.files.join(", ")}>
                            {step.files.join(", ")}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                  {detail.lineage.length > 1 && (
                    <p className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
                      {detail.lineage.map((l) => `${shortId(l.id)} ${l.origin}`).join(" ← ")}
                    </p>
                  )}
                  {detail.outcomes.length > 0 && (
                    <div className="flex flex-col gap-0.5">
                      {[...detail.outcomes].reverse().slice(0, 6).map((o) => (
                        <span key={o.runId} className="flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: "var(--vb-text-dim)" }}>
                          <Dot color={STATUS_COLOR[o.status] ?? "var(--vb-text-faint)"} size={5} />
                          <span>{o.status}</span>
                          <span>{o.filesChanged} files</span>
                          <span>{formatCost(o.costUsd)}</span>
                          <span>{formatAgo(o.finishedAt)}</span>
                          {o.experiment && <span title={o.experiment.id}>exp {o.experiment.branchId}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    <button
                      type="button"
                      className="vb-btn"
                      disabled={streaming}
                      title="Open in the run view to review and edit before running"
                      onClick={() => {
                        useViberon.getState().setAgentDockOpen(true);
                        reviewPlanVersion(detail.version);
                      }}
                    >
                      <Pencil className="size-3" />
                      Edit
                    </button>
                    <button
                      type="button"
                      className="vb-btn"
                      disabled={streaming}
                      title="Run this version again as it is"
                      onClick={() => {
                        useViberon.getState().setAgentDockOpen(true);
                        void runPlan(detail.version.plan, detail.version.prompt, detail.version.id);
                      }}
                    >
                      <Play className="size-3" />
                      Re-run
                    </button>
                    <button type="button" className="vb-btn" title="Fork into experiment branches" onClick={() => onExperiment(v)}>
                      <FlaskConical className="size-3" />
                      Experiment
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}

function PlanDiffView({ diff }: { diff: PlanDiff }) {
  if (diff.identical) {
    return (
      <p className="text-[11.5px]" style={{ color: "var(--vb-text-dim)" }}>
        {diff.modelChanged ? "Same plan; only the model differs." : "No structural differences."}
      </p>
    );
  }
  const line = (sign: string, color: string, text: string, key: string, title?: string) => (
    <span key={key} className="truncate font-mono text-[11px]" style={{ color }} title={title ?? text}>
      {sign} {text}
    </span>
  );
  return (
    <div className="flex flex-col gap-0.5">
      {diff.promptChanged && line("~", "var(--vb-amber)", "prompt changed", "prompt")}
      {diff.summaryChanged && line("~", "var(--vb-amber)", "summary changed", "summary")}
      {diff.added.map((s) => line("+", "var(--vb-add)", `${s.title} [${s.role}]`, `a-${s.id}`, s.files.join(", ")))}
      {diff.removed.map((s) => line("−", "var(--vb-del)", `${s.title} [${s.role}]`, `r-${s.id}`, s.files.join(", ")))}
      {diff.changed.map((c) =>
        line(
          "~",
          "var(--vb-amber)",
          `${c.title}: ${[...c.fields, ...(c.previousId ? [`id ${c.previousId}→${c.id}`] : [])].join(", ")}`,
          `c-${c.id}`,
        ),
      )}
      {diff.reordered && line("~", "var(--vb-amber)", "steps reordered", "order")}
      {diff.ownership.length > 0 && (
        <span className="pt-1 text-[10.5px] uppercase tracking-[0.04em]" style={{ color: "var(--vb-text-faint)" }}>
          File ownership
        </span>
      )}
      {diff.ownership.map((o) =>
        line("·", "var(--vb-text-mid)", `${o.file}: ${o.before ?? "—"} → ${o.after ?? "—"}`, `o-${o.file}`),
      )}
    </div>
  );
}

/* ----------------------------- experiments ------------------------------- */

function ExperimentsTab({
  repoKey,
  experiments,
  forkFrom,
  clearFork,
  onChange,
  reload,
}: {
  repoKey: string;
  experiments: ExperimentRecord[];
  forkFrom: PlanVersionSummary | null;
  clearFork: () => void;
  onChange: (record: ExperimentRecord) => void;
  reload: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  useEffect(() => {
    if (forkFrom) setFormOpen(true);
  }, [forkFrom]);

  return (
    <div className="flex flex-col gap-3">
      {formOpen ? (
        <NewExperimentForm
          repoKey={repoKey}
          forkFrom={forkFrom}
          onCancel={() => {
            setFormOpen(false);
            clearFork();
          }}
          onCreated={(record) => {
            setFormOpen(false);
            clearFork();
            onChange(record);
            setOpen(record.id);
          }}
        />
      ) : (
        <button type="button" className="vb-btn self-start" onClick={() => setFormOpen(true)}>
          <FlaskConical className="size-3" />
          New experiment
        </button>
      )}

      {experiments.length === 0 && !formOpen ? (
        <EmptyState
          title="No experiments yet"
          body="Fork a task into branches that differ by model, prompt or plan. Each runs in its own git worktree; compare them on tests fixed and broken, diff size, tokens and cost, then promote the winner."
        />
      ) : (
        <section className="flex flex-col gap-1">
          {experiments.map((record) => (
            <ExperimentCard
              key={record.id}
              repoKey={repoKey}
              record={record}
              open={open === record.id}
              onToggle={() => setOpen(open === record.id ? null : record.id)}
              onChange={onChange}
              reload={reload}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function NewExperimentForm({
  repoKey,
  forkFrom,
  onCancel,
  onCreated,
}: {
  repoKey: string;
  forkFrom: PlanVersionSummary | null;
  onCancel: () => void;
  onCreated: (record: ExperimentRecord) => void;
}) {
  const defaultModel = useViberon((s) => s.settings.model);
  const [task, setTask] = useState(forkFrom?.prompt ?? "");
  const [models, setModels] = useState(defaultModel && defaultModel !== "auto" ? defaultModel : "");
  const [prompts, setPrompts] = useState("");
  const [concurrency, setConcurrency] = useState<"1" | "2" | "3" | "4">("2");
  const [catalog, setCatalog] = useState<{ id: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (forkFrom) setTask(forkFrom.prompt);
  }, [forkFrom]);

  useEffect(() => {
    let live = true;
    void fetch("/api/models")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { models?: { id: string; label: string; available: boolean; agentic: boolean }[] } | null) => {
        if (live && body?.models) setCatalog(body.models.filter((m) => m.available && m.agentic).slice(0, 8));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const variants = useMemo(() => variantsFromForm(models, prompts), [models, prompts]);

  async function start() {
    setBusy(true);
    const result = await createExperimentRequest(repoKey, {
      ...(task.trim() ? { task: task.trim() } : {}),
      source: forkFrom ? { kind: "plan", versionId: forkFrom.id } : { kind: "workspace" },
      variants,
      concurrency: Number(concurrency),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    toast.success(`Experiment started with ${result.data.experiment.branches.length} branches.`);
    onCreated(result.data.experiment);
  }

  const addModel = (id: string) =>
    setModels((current) => (current.split(/[\s,]+/).includes(id) ? current : [current.trim(), id].filter(Boolean).join(", ")));

  return (
    <section className="vb-box flex flex-col gap-2 px-2 py-2">
      <div className="flex items-center gap-1.5">
        <FlaskConical className="size-3" style={{ color: "var(--vb-text-dim)" }} />
        <span className="text-[12px]" style={{ color: "var(--vb-text-hi)" }}>
          New experiment
        </span>
        <div className="flex-1" />
        <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
          {forkFrom ? `from plan ${shortId(forkFrom.id)}` : "from the workspace"}
        </span>
      </div>
      <textarea
        className="vb-input vb-textarea min-h-[56px] resize-y text-[12px]"
        placeholder={forkFrom ? "Task (defaults to the plan's prompt)" : "What should every branch do?"}
        value={task}
        onChange={(e) => setTask(e.target.value)}
      />
      <input
        className="vb-input text-[12px]"
        placeholder="Models, comma-separated (one branch each)"
        value={models}
        onChange={(e) => setModels(e.target.value)}
      />
      {catalog.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {catalog.map((m) => (
            <button key={m.id} type="button" className="vb-btn h-[20px] px-1.5 text-[11px]" onClick={() => addModel(m.id)} title={m.id}>
              + {m.label}
            </button>
          ))}
        </div>
      )}
      <textarea
        className="vb-input vb-textarea min-h-[40px] resize-y text-[12px]"
        placeholder="Prompt variants, one per line (optional)"
        value={prompts}
        onChange={(e) => setPrompts(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <span className="text-[11px]" style={{ color: "var(--vb-text-dim)" }}>
          At once
        </span>
        <Segmented<"1" | "2" | "3" | "4">
          value={concurrency}
          onChange={setConcurrency}
          options={[
            { value: "1", label: "1" },
            { value: "2", label: "2" },
            { value: "3", label: "3" },
            { value: "4", label: "4" },
          ]}
        />
        <div className="flex-1" />
        <span className="font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
          {variants.length} branch{variants.length === 1 ? "" : "es"}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <div className="flex-1" />
        <button type="button" className="vb-btn vb-btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="vb-btn vb-btn-primary"
          disabled={busy || (!task.trim() && !forkFrom && !prompts.trim())}
          onClick={() => void start()}
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
          Run branches
        </button>
      </div>
    </section>
  );
}

function ExperimentCard({
  repoKey,
  record,
  open,
  onToggle,
  onChange,
  reload,
}: {
  repoKey: string;
  record: ExperimentRecord;
  open: boolean;
  onToggle: () => void;
  onChange: (record: ExperimentRecord) => void;
  reload: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [patches, setPatches] = useState<Record<string, string> | null>(null);
  const [shownPatch, setShownPatch] = useState<string | null>(null);
  const recordRef = useRef(record);
  recordRef.current = record;

  // Follow a running experiment live.
  useEffect(() => {
    if (record.status !== "running") return;
    const controller = new AbortController();
    void followExperiment(
      repoKey,
      record.id,
      (event) => {
        const next = applyExperimentEvent(recordRef.current, event);
        if (next && next !== recordRef.current) onChange(next);
      },
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => {
        if (!controller.signal.aborted) reload();
      });
    return () => controller.abort();
    // Re-subscribe only when the experiment itself changes, not on every event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record.id, record.status, repoKey]);

  const comparison = useMemo(() => compareExperiment(record), [record]);
  const promoted = record.promotion && !record.promotion.undoneAt ? record.promotion.branchId : null;
  const done = record.branches.filter((b) => b.status !== "queued" && b.status !== "running").length;

  async function act(fn: () => Promise<{ ok: true; data: { experiment: ExperimentRecord } } | { ok: false; error: string }>, success: string) {
    setBusy(true);
    const result = await fn();
    setBusy(false);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    onChange(result.data.experiment);
    toast.success(success);
    void refreshWorkspace();
  }

  async function togglePatch(branchId: string) {
    if (shownPatch === branchId) return setShownPatch(null);
    if (!patches) {
      const result = await comparePatches(repoKey, record.id);
      if (!result.ok) return toast.error(result.error);
      setPatches(result.data.patches);
    }
    setShownPatch(branchId);
  }

  return (
    <div className="flex flex-col">
      <div className="group flex items-start gap-1.5 rounded px-1 py-1 hover:bg-[var(--vb-hover)]">
        <button type="button" className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center" style={{ color: "var(--vb-text-dim)" }} onClick={onToggle}>
          <ChevronRight className={cx("size-3.5", open && "rotate-90")} />
        </button>
        <button type="button" className="min-w-0 flex-1 text-left" onClick={onToggle}>
          <span className="block truncate text-[11.5px]" style={{ color: "var(--vb-text)" }} title={record.task}>
            {record.task}
          </span>
          <span className="flex items-center gap-1.5 font-mono text-[10.5px]" style={{ color: "var(--vb-text-faint)" }}>
            <Dot color={STATUS_COLOR[record.status] ?? "var(--vb-text-faint)"} size={5} live={record.status === "running"} />
            <span>{record.status}</span>
            <span>
              {done}/{record.branches.length} branches
            </span>
            <span>{formatAgo(record.createdAt)}</span>
            {promoted && <span style={{ color: "var(--vb-mint)" }}>promoted {promoted}</span>}
          </span>
        </button>
        {record.status !== "discarded" && (
          <span className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <IconButton
              title={record.status === "running" ? "Stop and remove the worktrees" : "Discard: remove the worktrees"}
              tone="danger"
              disabled={busy}
              onClick={() => {
                if (!window.confirm("Discard this experiment's branch worktrees? Evidence bundles are kept.")) return;
                void act(() => discardExperimentRequest(repoKey, record.id), "Experiment discarded.");
              }}
            >
              <Trash2 className="size-2.5" />
            </IconButton>
          </span>
        )}
      </div>

      {open && (
        <div className="ml-5 flex flex-col gap-1.5 border-l py-1.5 pl-2" style={{ borderColor: "var(--vb-line)" }}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr style={{ color: "var(--vb-text-faint)" }}>
                  {["#", "branch", "verdict", "tests", "diff", "tokens", "cost", "time", ""].map((h) => (
                    <th key={h} className="whitespace-nowrap px-1 pb-1 text-left font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {comparison.rows.map((row) => (
                  <tr key={row.branchId} className="align-top" style={{ color: "var(--vb-text)" }}>
                    <td className="px-1 py-0.5 font-mono" style={{ color: "var(--vb-text-faint)" }}>
                      {row.rank ?? "–"}
                    </td>
                    <td className="max-w-[120px] px-1 py-0.5">
                      <button
                        type="button"
                        className="flex max-w-full items-center gap-1 truncate text-left hover:underline"
                        title={`${row.label}${row.worktree ? `\n${row.worktree}` : ""}\nClick to show the patch`}
                        onClick={() => void togglePatch(row.branchId)}
                        disabled={row.status === "queued" || row.status === "running"}
                      >
                        {row.branchId === record.winner && <Trophy className="size-3 shrink-0" style={{ color: "var(--vb-amber)" }} />}
                        <span className="truncate">{row.label}</span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-1 py-0.5" style={{ color: STATUS_COLOR[row.verdict] ?? "var(--vb-text-dim)" }}>
                      {row.status === "running" ? <Loader2 className="size-3 animate-spin" /> : row.verdict}
                    </td>
                    <td className="whitespace-nowrap px-1 py-0.5 font-mono">
                      <span style={{ color: "var(--vb-add)" }}>{row.fixed}✓</span>{" "}
                      <span style={{ color: row.regressed ? "var(--vb-del)" : "var(--vb-text-faint)" }}>{row.regressed}✗</span>
                    </td>
                    <td className="px-1 py-0.5">
                      <DiffCounts adds={row.adds} removes={row.removes} />
                    </td>
                    <td className="whitespace-nowrap px-1 py-0.5 font-mono">{formatTokens(row.tokens)}</td>
                    <td className="whitespace-nowrap px-1 py-0.5 font-mono">{formatCost(row.costUsd)}</td>
                    <td className="whitespace-nowrap px-1 py-0.5 font-mono">{row.durationMs ? formatDuration(row.durationMs) : "–"}</td>
                    <td className="px-1 py-0.5">
                      {row.promoted ? (
                        <button
                          type="button"
                          className="vb-btn h-[20px] px-1.5 text-[11px]"
                          disabled={busy}
                          title="Undo the promotion"
                          onClick={() => void act(() => undoExperimentPromotion(repoKey, record.id), "Promotion undone.")}
                        >
                          <RotateCcw className="size-3" />
                          Undo
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={cx("vb-btn h-[20px] px-1.5 text-[11px]", row.branchId === record.winner && "vb-btn-primary")}
                          disabled={busy || Boolean(promoted) || !row.canPromote || record.status === "running"}
                          title="Apply this branch's patch to the workspace (a checkpoint is taken first)"
                          onClick={() => void act(() => promoteExperimentBranch(repoKey, record.id, row.branchId), `Promoted ${row.branchId}.`)}
                        >
                          <Check className="size-3" />
                          Promote
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shownPatch && patches?.[shownPatch] !== undefined && (
            <pre
              className="max-h-[260px] overflow-auto rounded border px-2 py-1 font-mono text-[10.5px] leading-snug"
              style={{ borderColor: "var(--vb-line)", background: "var(--vb-bg-raised)", color: "var(--vb-text)" }}
            >
              {patches[shownPatch] || "(no change)"}
            </pre>
          )}
          <p className="text-[10.5px] leading-relaxed" style={{ color: "var(--vb-text-faint)" }}>
            Ranked by verdict, then regressions, tests fixed, diff size, cost, tokens and time.
          </p>
        </div>
      )}
    </div>
  );
}

export default PlansPanel;
