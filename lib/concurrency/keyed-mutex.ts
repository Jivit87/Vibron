/**
 * Keyed async mutex.
 *
 * The same Promise-chaining pattern `graph-index.ts` uses for `graph.json`,
 * made reusable: every writer for a key appends itself to that key's chain
 * and runs only after the previous writer settles, so read-modify-write
 * sequences on one shared blob (raw files, memory, a checkpoint journal)
 * can no longer interleave. Different keys never wait on each other.
 *
 * The chains live on globalThis so dev-mode HMR does not split one lock into
 * two, and a key's entry is dropped once its chain drains, so the map does
 * not grow with every key ever locked.
 *
 * Not reentrant: calling `withKeyedLock` for the same key from inside `fn`
 * deadlocks. Callers lock at the outermost read-modify-write only.
 */

const KEY = Symbol.for("viberon.keyedMutex");
type GlobalWithLocks = typeof globalThis & { [KEY]?: Map<string, Promise<unknown>> };
const host = globalThis as GlobalWithLocks;
const chains: Map<string, Promise<unknown>> = host[KEY] ?? new Map();
host[KEY] = chains;

export function withKeyedLock<T>(
  namespace: string,
  key: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const id = `${namespace}\u0000${key}`;
  const previous = chains.get(id) ?? Promise.resolve();
  // Always advance the chain, even when the previous holder threw.
  const run = previous.then(
    () => fn(),
    () => fn(),
  );
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(id, tail);
  void tail.then(() => {
    if (chains.get(id) === tail) chains.delete(id);
  });
  return run;
}

/** Number of keys with a live chain (tests: proves chains drain). */
export function activeLockCount(): number {
  return chains.size;
}
