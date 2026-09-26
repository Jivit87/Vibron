/**
 * The MCP marketplace catalog: a curated list of well-known servers shipped
 * with Viberon (`catalog.json`), optionally extended by a remote registry.
 *
 * Entries are templates, not configs. `{{FIELD}}` placeholders in `args` and
 * `headers` are filled at install time (see `lib/mcp/marketplace`),
 * secret fields becoming `${secret:NAME}` references into the credentials
 * store rather than inline values.
 *
 * Trust model: the bundled catalog is reviewed code. A remote registry is
 * not, so its entries are validated strictly, may not shadow a bundled id,
 * may only launch through `npx`/`uvx`/`docker` or connect over https, and
 * are always labelled "community" whatever they claim.
 *
 * Everything here is pure apart from `fetchRegistry` / `loadCatalog`, which
 * take an injectable `fetch`.
 */

import bundled from "@/lib/mcp/catalog.json";
import { CATEGORIES, type CatalogCategory, type CatalogEntry, type CatalogField } from "@/lib/mcp/catalog-search";

export {
  CATEGORIES,
  CATEGORY_LABEL,
  searchCatalog,
  type CatalogCategory,
  type CatalogEntry,
  type CatalogField,
  type TrustTier,
} from "@/lib/mcp/catalog-search";

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
/** Commands a catalog entry may launch. Anything else needs a hand-written config. */
export const ALLOWED_COMMANDS = new Set(["npx", "uvx", "docker"]);

const MAX_TEXT = 600;
const MAX_ARGS = 32;
const MAX_FIELDS = 16;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === "object" && !Array.isArray(v);

function str(v: unknown, max = MAX_TEXT): string | null {
  return typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null;
}

function httpsUrl(v: unknown): string | null {
  const s = str(v, 2048);
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Placeholder names used by a template string. */
export function placeholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

function validateField(raw: unknown, where: string): CatalogField | string {
  if (!isRecord(raw)) return `${where}: field must be an object`;
  const name = typeof raw.name === "string" && FIELD_NAME.test(raw.name) ? raw.name : null;
  if (!name) return `${where}: field name must be an identifier`;
  const label = str(raw.label, 80);
  if (!label) return `${where}.${name}: label is required`;
  const inject = raw.inject === undefined ? "env" : raw.inject;
  if (inject !== "env" && inject !== "template") return `${where}.${name}: inject must be "env" or "template"`;
  for (const key of ["description", "placeholder", "default"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") return `${where}.${name}: ${key} must be a string`;
  }
  if (raw.secret === true && typeof raw.default === "string" && raw.default) {
    return `${where}.${name}: a secret field cannot have a default`;
  }
  return {
    name,
    label,
    ...(typeof raw.description === "string" && raw.description ? { description: raw.description.slice(0, MAX_TEXT) } : {}),
    ...(typeof raw.placeholder === "string" && raw.placeholder ? { placeholder: raw.placeholder.slice(0, 120) } : {}),
    ...(typeof raw.default === "string" && raw.default ? { default: raw.default } : {}),
    secret: raw.secret === true,
    required: raw.required === true,
    inject,
  };
}

/**
 * Validate one catalog entry. Returns the normalized entry, or an error
 * string naming the first problem.
 */
export function validateEntry(raw: unknown, origin: CatalogEntry["origin"]): CatalogEntry | string {
  if (!isRecord(raw)) return "entry must be an object";
  const id = typeof raw.id === "string" && ID_PATTERN.test(raw.id) ? raw.id : null;
  if (!id) return `invalid id ${JSON.stringify(raw.id)} (lowercase letters, digits and -, max 48)`;
  const name = str(raw.name, 80);
  const description = str(raw.description);
  if (!name || !description) return `${id}: name and description are required`;
  const category = CATEGORIES.includes(raw.category as CatalogCategory) ? (raw.category as CatalogCategory) : null;
  if (!category) return `${id}: category must be one of ${CATEGORIES.join(", ")}`;
  const trust = raw.trust === "official" || raw.trust === "community" ? raw.trust : null;
  if (!trust) return `${id}: trust must be "official" or "community"`;
  const homepage = httpsUrl(raw.homepage);
  if (!homepage) return `${id}: homepage must be an https URL`;
  const publisher = str(raw.publisher, 120) ?? "Unknown";

  const fields: CatalogField[] = [];
  if (raw.fields !== undefined) {
    if (!Array.isArray(raw.fields) || raw.fields.length > MAX_FIELDS) return `${id}: fields must be an array (max ${MAX_FIELDS})`;
    for (const f of raw.fields) {
      const field = validateField(f, id);
      if (typeof field === "string") return field;
      if (fields.some((x) => x.name === field.name)) return `${id}: duplicate field ${field.name}`;
      fields.push(field);
    }
  }
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((t): t is string => typeof t === "string" && t.length <= 40).slice(0, 12)
    : [];

  const transport = raw.transport;
  let command: string | undefined;
  let args: string[] = [];
  let url: string | undefined;
  let headers: Record<string, string> = {};
  let templates: string[];

  if (transport === "stdio") {
    command = typeof raw.command === "string" && ALLOWED_COMMANDS.has(raw.command) ? raw.command : undefined;
    if (!command) return `${id}: command must be one of ${[...ALLOWED_COMMANDS].join(", ")}`;
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || raw.args.length > MAX_ARGS || raw.args.some((a) => typeof a !== "string" || a.length > 512)) {
        return `${id}: args must be an array of strings (max ${MAX_ARGS})`;
      }
      args = raw.args as string[];
    }
    templates = args;
  } else if (transport === "http" || transport === "sse") {
    // Placeholders are not allowed in the URL: a secret there would end up
    // in logs and proxies. Headers carry credentials.
    url = httpsUrl(raw.url) ?? undefined;
    if (!url || /\{\{/.test(String(raw.url))) return `${id}: url must be a literal https URL`;
    if (raw.headers !== undefined) {
      if (!isRecord(raw.headers) || Object.values(raw.headers).some((v) => typeof v !== "string")) {
        return `${id}: headers must map names to strings`;
      }
      headers = raw.headers as Record<string, string>;
    }
    templates = Object.values(headers);
    if (fields.some((f) => f.inject === "env")) {
      return `${id}: HTTP servers have no environment; use inject "template" with a header`;
    }
  } else {
    return `${id}: transport must be "stdio", "http" or "sse"`;
  }

  const known = new Set(fields.map((f) => f.name));
  for (const template of templates) {
    for (const ref of placeholders(template)) {
      if (!known.has(ref)) return `${id}: placeholder {{${ref}}} has no matching field`;
    }
  }
  for (const field of fields) {
    if (field.inject === "template" && !templates.some((t) => placeholders(t).includes(field.name))) {
      return `${id}: template field ${field.name} is not used by any placeholder`;
    }
  }

  return {
    id,
    name,
    description,
    category,
    publisher,
    trust,
    homepage,
    transport,
    ...(command ? { command } : {}),
    args,
    ...(url ? { url } : {}),
    headers,
    fields,
    tags,
    origin,
  };
}

export interface CatalogValidation {
  entries: CatalogEntry[];
  errors: string[];
  /** Set when the document itself (not an entry) is malformed. */
  invalidDocument?: boolean;
}

/**
 * Validate a whole catalog document: `{ version: 1, servers: [...] }` or a
 * bare array. Invalid entries are dropped individually and reported, so one
 * bad entry in a registry does not hide the rest.
 */
export function validateCatalog(doc: unknown, origin: CatalogEntry["origin"]): CatalogValidation {
  const list = Array.isArray(doc) ? doc : isRecord(doc) && Array.isArray(doc.servers) ? doc.servers : null;
  if (!list) return { entries: [], errors: ["catalog must be an array or { servers: [...] }"], invalidDocument: true };
  if (isRecord(doc) && doc.version !== undefined && doc.version !== 1) {
    return { entries: [], errors: [`unsupported catalog version ${JSON.stringify(doc.version)}`], invalidDocument: true };
  }
  const entries: CatalogEntry[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const entry = validateEntry(raw, origin);
    if (typeof entry === "string") errors.push(entry);
    else if (seen.has(entry.id)) errors.push(`${entry.id}: duplicate id`);
    else {
      seen.add(entry.id);
      entries.push(entry);
    }
  }
  return { entries, errors };
}

let bundledCache: CatalogEntry[] | null = null;

/** The catalog shipped with Viberon. Throws if it is ever invalid (a test guards this). */
export function bundledCatalog(): CatalogEntry[] {
  if (bundledCache) return bundledCache;
  const { entries, errors } = validateCatalog(bundled, "bundled");
  if (errors.length > 0) throw new Error(`Bundled MCP catalog is invalid: ${errors.join("; ")}`);
  bundledCache = entries;
  return entries;
}

/**
 * Bundled entries win on id; registry entries are forced to "community".
 * The result is sorted: bundled first in file order, then registry by name.
 */
export function mergeCatalogs(base: CatalogEntry[], remote: CatalogEntry[]): CatalogEntry[] {
  const ids = new Set(base.map((e) => e.id));
  const extra = remote
    .filter((e) => !ids.has(e.id))
    .map((e) => ({ ...e, trust: "community" as const, origin: "registry" as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...base, ...extra];
}

/* ------------------------------- registry --------------------------------- */

export const REGISTRY_TIMEOUT_MS = 5_000;
export const REGISTRY_MAX_BYTES = 512 * 1024;

export interface RegistryResult {
  ok: boolean;
  entries: CatalogEntry[];
  errors: string[];
  error?: string;
}

/** Read a response body, refusing to buffer more than `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`registry index is ${declared} bytes (limit ${maxBytes})`);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw new Error(`registry index exceeds ${maxBytes} bytes`);
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`registry index exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetch and validate a remote registry index. Never throws: every failure
 * (bad URL, timeout, non-200, oversize, bad JSON, bad schema) comes back as
 * `{ ok: false, error }` so callers fall back to the bundled catalog.
 */
export async function fetchRegistry(
  registryUrl: string,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<RegistryResult> {
  const fail = (error: string): RegistryResult => ({ ok: false, entries: [], errors: [], error });
  let url: URL;
  try {
    url = new URL(registryUrl);
  } catch {
    return fail("registry URL is not a valid URL");
  }
  if (url.protocol !== "https:") return fail("registry URL must use https");

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": "viberon" },
      signal: controller.signal,
      // A redirect could leave https; refuse rather than follow.
      redirect: "error",
    });
    if (!response.ok) return fail(`registry returned HTTP ${response.status}`);
    const text = await readCapped(response, options.maxBytes ?? REGISTRY_MAX_BYTES);
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      return fail("registry index is not valid JSON");
    }
    const { entries, errors, invalidDocument } = validateCatalog(doc, "registry");
    if (invalidDocument) return fail(errors[0]!);
    return { ok: true, entries, errors };
  } catch (error) {
    if (controller.signal.aborted) return fail(`registry timed out after ${Math.round(timeoutMs / 100) / 10}s`);
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

export interface LoadedCatalog {
  entries: CatalogEntry[];
  registry: {
    url: string | null;
    status: "disabled" | "ok" | "error";
    error?: string;
    /** Registry entries merged in (after dropping shadowed and invalid ones). */
    added: number;
    /** Registry entries that failed validation. */
    rejected: string[];
  };
}

const CACHE_TTL_MS = 10 * 60_000;
const registryCache = new Map<string, { at: number; result: RegistryResult }>();

export function clearRegistryCache(): void {
  registryCache.clear();
}

/**
 * The effective catalog: bundled, plus the registry at `registryUrl` when
 * one is configured and reachable. Successful registry reads are cached for
 * ten minutes; failures are not cached, so a fixed registry shows up on the
 * next load.
 */
export async function loadCatalog(
  registryUrl: string | null,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; refresh?: boolean } = {},
): Promise<LoadedCatalog> {
  const base = bundledCatalog();
  if (!registryUrl) {
    return { entries: base, registry: { url: null, status: "disabled", added: 0, rejected: [] } };
  }
  const cached = registryCache.get(registryUrl);
  let result: RegistryResult;
  if (cached && !options.refresh && Date.now() - cached.at < CACHE_TTL_MS) {
    result = cached.result;
  } else {
    result = await fetchRegistry(registryUrl, options);
    if (result.ok) registryCache.set(registryUrl, { at: Date.now(), result });
  }
  if (!result.ok) {
    return {
      entries: base,
      registry: { url: registryUrl, status: "error", error: result.error, added: 0, rejected: [] },
    };
  }
  const entries = mergeCatalogs(base, result.entries);
  return {
    entries,
    registry: {
      url: registryUrl,
      status: "ok",
      added: entries.length - base.length,
      rejected: result.errors,
    },
  };
}
