/**
 * Live experiments inside the app server: start one in the background and
 * let any number of SSE subscribers follow it. A late subscriber gets a
 * replay of what happened so far, then the live tail (the task queue's
 * pattern). The map lives on globalThis to survive dev-mode HMR.
 */

import {
  createExperiment,
  runPreparedExperiment,
  type ExperimentDeps,
  type ExperimentEvent,
  type ExperimentInput,
  type ExperimentRecord,
} from "@/lib/experiments";

interface LiveExperiment {
  events: ExperimentEvent[];
  listeners: Set<(event: ExperimentEvent) => void>;
  closers: Set<() => void>;
  done: boolean;
}

/** Replay buffer cap; the oldest relayed agent events go first. */
const MAX_BUFFER = 4000;

const KEY = Symbol.for("viberon.experiments.live");
type GlobalWithLive = typeof globalThis & { [KEY]?: Map<string, LiveExperiment> };
const host = globalThis as GlobalWithLive;
const live: Map<string, LiveExperiment> = host[KEY] ?? new Map();
host[KEY] = live;

function push(entry: LiveExperiment, event: ExperimentEvent): void {
  entry.events.push(event);
  if (entry.events.length > MAX_BUFFER) {
    const drop = entry.events.findIndex((e) => e.type === "branch_event");
    entry.events.splice(drop === -1 ? 0 : drop, 1);
  }
  for (const listener of entry.listeners) listener(event);
}

/**
 * Validate and create the experiment, then run it in the background.
 * Resolves with the new record as soon as it exists; failures to create
 * reject (so the route can answer 4xx), failures while running are events.
 */
export async function startExperiment(input: ExperimentInput, deps: ExperimentDeps = {}): Promise<ExperimentRecord> {
  const entry: LiveExperiment = { events: [], listeners: new Set(), closers: new Set(), done: false };
  const prepared = await createExperiment({ ...input, embedded: true, onEvent: (event) => push(entry, event) }, deps);
  live.set(prepared.record.id, entry);
  const finish = () => {
    entry.done = true;
    for (const close of entry.closers) close();
    entry.listeners.clear();
    entry.closers.clear();
  };
  void runPreparedExperiment(prepared)
    .catch((error: unknown) => {
      push(entry, { type: "experiment_error", message: error instanceof Error ? error.message : String(error) });
    })
    .finally(finish);
  return structuredClone(prepared.record);
}

/**
 * Follow an experiment: replay, then live events; `onEnd` fires when it
 * finishes (at once for one that is already over or unknown here).
 */
export function subscribeExperiment(
  id: string,
  listener: (event: ExperimentEvent) => void,
  onEnd: () => void,
): () => void {
  const entry = live.get(id);
  if (!entry) {
    onEnd();
    return () => {};
  }
  for (const event of entry.events) listener(event);
  if (entry.done) {
    onEnd();
    return () => {};
  }
  entry.listeners.add(listener);
  entry.closers.add(onEnd);
  return () => {
    entry.listeners.delete(listener);
    entry.closers.delete(onEnd);
  };
}

/** Forget a finished experiment's buffered events (after discard). */
export function forgetExperiment(id: string): void {
  const entry = live.get(id);
  if (entry?.done) live.delete(id);
}
