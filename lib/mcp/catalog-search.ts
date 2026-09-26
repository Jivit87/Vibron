/**
 * Catalog types and search, split from `catalog.ts` so the browser bundle
 * can filter entries without pulling in the bundled JSON or registry code.
 */

export const CATEGORIES = [
  "files",
  "developer",
  "databases",
  "web",
  "search",
  "browser",
  "productivity",
  "knowledge",
  "reasoning",
  "observability",
  "cloud",
  "utilities",
] as const;
export type CatalogCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<CatalogCategory, string> = {
  files: "Files",
  developer: "Developer",
  databases: "Databases",
  web: "Web",
  search: "Search",
  browser: "Browser",
  productivity: "Productivity",
  knowledge: "Knowledge",
  reasoning: "Reasoning",
  observability: "Observability",
  cloud: "Cloud",
  utilities: "Utilities",
};

export type TrustTier = "official" | "community";

export interface CatalogField {
  /** Environment variable name, also the `{{NAME}}` placeholder. */
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  default?: string;
  /** Stored in the credentials store; the config only holds a reference. */
  secret: boolean;
  required: boolean;
  /**
   * "env" (default): passed to the server as an environment variable (stdio).
   * "template": only substituted into `{{NAME}}` placeholders.
   */
  inject: "env" | "template";
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  publisher: string;
  trust: TrustTier;
  homepage: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  url?: string;
  headers: Record<string, string>;
  fields: CatalogField[];
  tags: string[];
  /** Where the entry came from. */
  origin: "bundled" | "registry";
}

/* -------------------------------- search ---------------------------------- */

/**
 * Case-insensitive search over id, name, description, publisher and tags,
 * optionally within one category. Every whitespace-separated term must
 * match somewhere. Name/id hits rank above description hits.
 */
export function searchCatalog(
  entries: CatalogEntry[],
  query: string,
  category?: CatalogCategory | "all" | null,
): CatalogEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { entry: CatalogEntry; score: number; index: number }[] = [];
  entries.forEach((entry, index) => {
    if (category && category !== "all" && entry.category !== category) return;
    const head = `${entry.id} ${entry.name}`.toLowerCase();
    const body = `${entry.description} ${entry.publisher} ${entry.tags.join(" ")} ${entry.category}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (head.includes(term)) score += 2;
      else if (body.includes(term)) score += 1;
      else return;
    }
    scored.push({ entry, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.entry);
}
