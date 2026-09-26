/**
 * The context ledger.
 *
 * Two jobs:
 *
 *  1. **Never send the same bytes twice.** Every chunk of context handed to
 *     a model is hashed and recorded. If a later tool call would return the
 *     identical chunk — the same graph slice, the same file window, the same
 *     symbol index — the engine returns a one-line pointer instead
 *     ("already in context above"). In a long agent run this is where most
 *     of the savings come from: agents re-request the same file constantly.
 *
 *  2. **Account honestly.** Track what was actually sent, what was skipped,
 *     and what a naive "dump every file" approach would have cost, so the
 *     savings number in the UI is a real measurement rather than a guess.
 */

import { createHash } from "node:crypto";

import { countTokens } from "@/lib/tokens";

export interface LedgerEvent {
  at: number;
  /** What produced this chunk: `graph_slice`, `read_file`, `skeleton`, … */
  source: string;
  /** Short human label, e.g. the path or query. */
  label: string;
  tokens: number;
  /** True when the chunk was suppressed because it was already delivered. */
  deduped: boolean;
}

export interface LedgerSnapshot {
  /** Tokens actually placed into a prompt. */
  sentTokens: number;
  /** Tokens avoided by dedupe (chunks we refused to repeat). */
  dedupedTokens: number;
  /**
   * Tokens a naive agent would have sent — the full text of every file it
   * touched, every time it touched it.
   */
  baselineTokens: number;
  /** baseline - sent, floored at zero. */
  savedTokens: number;
  savedPercent: number;
  events: LedgerEvent[];
}

function hash(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Accounting shared by a ledger and every fork of it, so the run-level
 * snapshot adds up the whole team while dedupe stays per agent.
 */
interface LedgerTotals {
  naiveReads: { path: string; tokens: number }[];
  events: LedgerEvent[];
  sentTokens: number;
  dedupedTokens: number;
}

export class ContextLedger {
  /** hash → tokens, for every chunk already delivered to *this* agent. */
  private delivered = new Map<string, number>();
  private totals: LedgerTotals;
  /** Set on forks; the root ledger belongs to the run. */
  readonly agentId: string | null;

  constructor(totals?: LedgerTotals, agentId: string | null = null) {
    this.agentId = agentId;
    this.totals = totals ?? {
      naiveReads: [],
      events: [],
      sentTokens: 0,
      dedupedTokens: 0,
    };
  }

  /**
   * A ledger for one agent. Dedupe must be per agent: a pointer saying
   * "already in context above" is a lie to an agent whose transcript never
   * contained that chunk. Token accounting still rolls up into this ledger.
   */
  fork(agentId: string): ContextLedger {
    return new ContextLedger(this.totals, agentId);
  }

  /**
   * Offer a chunk of context. Returns the text to actually use — either the
   * chunk itself, or a short pointer when it has already been delivered.
   */
  offer(
    source: string,
    label: string,
    text: string,
  ): { text: string; deduped: boolean; tokens: number } {
    const key = hash(text);
    const tokens = countTokens(text);
    const seen = this.delivered.has(key);

    const totals = this.totals;
    totals.events.push({ at: Date.now(), source, label, tokens, deduped: seen });
    if (totals.events.length > 500) totals.events.splice(0, totals.events.length - 500);

    if (seen) {
      totals.dedupedTokens += tokens;
      return {
        text: `[already in context — ${label} was returned earlier in this run, unchanged. Scroll up rather than re-reading.]`,
        deduped: true,
        tokens: 0,
      };
    }

    this.delivered.set(key, tokens);
    totals.sentTokens += tokens;
    return { text, deduped: false, tokens };
  }

  /**
   * Record what the naive alternative would have cost. Called whenever the
   * engine answers a question *about* a file without sending the file.
   */
  chargeBaseline(path: string, fullTokens: number): void {
    this.totals.naiveReads.push({ path, tokens: fullTokens });
  }

  /** Forget a chunk so a genuinely changed file can be re-delivered. */
  invalidate(text: string): void {
    this.delivered.delete(hash(text));
  }

  /** Drop every cached chunk mentioning a path — used after an edit. */
  invalidatePath(path: string): void {
    for (const event of this.totals.events) {
      if (event.label.includes(path)) {
        // We cannot reverse the hash, so clear wholesale: correctness first.
        this.delivered.clear();
        return;
      }
    }
  }

  snapshot(): LedgerSnapshot {
    const { naiveReads, sentTokens, dedupedTokens, events } = this.totals;
    const baselineTokens = naiveReads.reduce((sum, r) => sum + r.tokens, 0);
    const savedTokens = Math.max(0, baselineTokens - sentTokens);
    return {
      sentTokens,
      dedupedTokens,
      baselineTokens,
      savedTokens,
      savedPercent:
        baselineTokens > 0 ? Math.round((savedTokens / baselineTokens) * 100) : 0,
      events: [...events],
    };
  }
}
