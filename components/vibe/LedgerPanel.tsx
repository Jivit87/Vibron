"use client";

/**
 * Token ledger.
 *
 * Makes the savings claim auditable instead of decorative. Three distinct
 * mechanisms are accounted for separately, because they are genuinely
 * different wins:
 *
 *   graph      — answering from a symbol slice instead of whole files
 *   dedupe     — refusing to re-send content already in the conversation
 *   cache      — provider-side prompt caching on the stable prefix
 */

import { Layers, Repeat, Zap } from "lucide-react";

import { useViberon } from "@/store/viberon";
import {
  EmptyState,
  formatCost,
  formatTokens,
  PanelHeader,
  Stat,
} from "@/components/vibe/primitives";

export function LedgerPanel() {
  const run = useViberon((s) => s.run);
  const ledger = run?.ledger;

  if (!run || (!ledger && run.tokensIn === 0)) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Token ledger" icon={<Zap className="size-3" />} />
        <EmptyState
          icon={<Zap className="size-4" />}
          title="No run yet"
          body="Once agents start working, this shows exactly what the graph, dedupe, and prompt caching saved."
        />
      </div>
    );
  }

  const graphSaved = ledger?.savedTokens ?? 0;
  const dedupeSaved = ledger?.dedupedTokens ?? 0;
  const cacheSavedUsd = Math.max(0, run.uncachedUsd - run.costUsd);
  const naive = ledger?.baselineTokens ?? 0;
  const sent = ledger?.sentTokens ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Token ledger" icon={<Zap className="size-3" />} />

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat
              label="Sent"
              value={formatTokens(run.tokensIn)}
              title="Prompt tokens across every agent turn"
            />
            <Stat
              label="Generated"
              value={formatTokens(run.tokensOut)}
              title="Completion tokens"
            />
            <Stat
              label="From cache"
              value={formatTokens(run.tokensCached)}
              tone="var(--vb-text-mid)"
              title="Served from the provider prompt cache at ~10% of input price"
            />
            <Stat
              label="Cost"
              value={formatCost(run.costUsd)}
              title="Actual billed cost for this run"
            />
          </div>

          {naive > 0 && (
            <Mechanism
              icon={<Layers className="size-3.5" />}
              accent="var(--vb-mint)"
              title="Graph retrieval"
              value={`${formatTokens(graphSaved)} saved`}
              percent={ledger?.savedPercent ?? 0}
              body={`Answered with ${formatTokens(sent)} tokens of graph slices where reading those files whole would have cost ${formatTokens(naive)}.`}
            />
          )}

          {dedupeSaved > 0 && (
            <Mechanism
              icon={<Repeat className="size-3.5" />}
              accent="var(--vb-amber)"
              title="Repeat-read dedupe"
              value={`${formatTokens(dedupeSaved)} avoided`}
              body="Agents asked for content already in context. Those requests returned a pointer instead of the bytes."
            />
          )}

          {cacheSavedUsd > 0.00001 && (
            <Mechanism
              icon={<Zap className="size-3.5" />}
              accent="var(--vb-text-mid)"
              title="Prompt caching"
              value={`${formatCost(cacheSavedUsd)} saved`}
              body="Project memory and the repo map are a stable prefix, so every turn after the first re-reads them at a fraction of the price."
            />
          )}

          {ledger && ledger.events.length > 0 && (
            <section className="flex flex-col gap-1">
              <span
                className="text-[11px] font-semibold uppercase tracking-[0.04em]"
                style={{ color: "var(--vb-text-faint)" }}
              >
                Context reads
              </span>
              <div className="flex flex-col gap-px">
                {ledger.events
                  .slice(-40)
                  .reverse()
                  .map((event, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 rounded px-1.5 py-1 font-mono text-[11px]"
                      style={{ background: "var(--vb-fill)" }}
                    >
                      <span
                        className="w-[86px] shrink-0 truncate"
                        style={{ color: "var(--vb-text-mid)" }}
                      >
                        {event.source}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ color: "var(--vb-text-dim)" }}
                        title={event.label}
                      >
                        {event.label}
                      </span>
                      <span
                        className="shrink-0 tabular-nums"
                        style={{
                          color: event.deduped
                            ? "var(--vb-amber)"
                            : "var(--vb-text-faint)",
                        }}
                      >
                        {event.deduped ? "deduped" : formatTokens(event.tokens)}
                      </span>
                    </div>
                  ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Mechanism({
  icon,
  accent,
  title,
  value,
  percent,
  body,
}: {
  icon: React.ReactNode;
  accent: string;
  title: string;
  value: string;
  percent?: number;
  body: string;
}) {
  return (
    <div className="vb-box p-3">
      <div className="flex items-center gap-2">
        <span style={{ color: accent }}>{icon}</span>
        <span className="text-[12px] font-medium" style={{ color: "var(--vb-text-hi)" }}>
          {title}
        </span>
        <span className="ml-auto font-mono text-[12px]" style={{ color: accent }}>
          {value}
        </span>
      </div>
      {percent !== undefined && percent > 0 && (
        <div
          className="mt-2 h-1 w-full overflow-hidden rounded-[2px]"
          style={{ background: "var(--vb-fill)" }}
        >
          <div
            className="h-full transition-all"
            style={{ width: `${Math.min(100, percent)}%`, background: accent }}
          />
        </div>
      )}
      <p
        className="mt-2 text-[11px] leading-relaxed"
        style={{ color: "var(--vb-text-dim)" }}
      >
        {body}
      </p>
    </div>
  );
}

export default LedgerPanel;
