/**
 * What the configured NVIDIA key can actually call.
 *
 * The NVIDIA API Catalog retires models on a schedule (a retired model
 * answers 410 Gone) and lists models an account cannot invoke (404
 * "Function … not found for account"). A hard-coded list goes stale within
 * months, so availability comes from two live sources:
 *
 *  - the catalog (`GET /v1/models`), fetched once per key and cached;
 *  - calls that came back 404/410, remembered for the life of the process.
 *
 * `runTurn` uses the second to move a run onto the next usable model instead
 * of failing it.
 */

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const CATALOG_TTL_MS = 60 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 10_000;

export function nvidiaBaseUrl(): string {
  return (process.env.NVIDIA_BASE_URL || NVIDIA_BASE_URL).replace(/\/+$/, "");
}

let catalog: { key: string; at: number; ids: Set<string> } | null = null;
const unavailable = new Set<string>();

/**
 * The model ids the key's catalog lists, or null when the catalog could not
 * be read (offline, self-hosted NIM without `/models`): unknown is treated
 * as "try it", never as "nothing works".
 */
export async function nvidiaCatalog(key: string | null): Promise<Set<string> | null> {
  if (!key) return null;
  if (catalog && catalog.key === key && Date.now() - catalog.at < CATALOG_TTL_MS) return catalog.ids;
  try {
    const response = await fetch(`${nvidiaBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    const ids = new Set(
      (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string"),
    );
    if (ids.size === 0) return null;
    catalog = { key, at: Date.now(), ids };
    return ids;
  } catch {
    return null;
  }
}

/** Remember that a model answered 404/410 for this account. */
export function markNvidiaUnavailable(wireModel: string): void {
  unavailable.add(wireModel);
}

export function nvidiaModelUsable(wireModel: string, ids: Set<string> | null): boolean {
  if (unavailable.has(wireModel)) return false;
  return ids === null || ids.has(wireModel);
}

/** A model the account cannot call: retired (410) or not enabled (404). */
export class ModelUnavailableError extends Error {
  constructor(
    readonly model: string,
    readonly status: number,
    detail: string,
    provider = "NVIDIA",
  ) {
    super(
      `${provider} model ${model} is not available to this key (HTTP ${status}${
        status === 410 ? ", retired" : status === 429 ? ", daily quota used up" : ""
      }): ${detail.slice(0, 300)}`,
    );
    this.name = "ModelUnavailableError";
  }
}

export const nvidiaCatalogTesting = {
  reset(): void {
    catalog = null;
    unavailable.clear();
  },
};
