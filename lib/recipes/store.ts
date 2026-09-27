/**
 * Where recipes live, how they are found by name, and how one is imported.
 *
 * Lookup order (first wins, so a repository can override a shared recipe):
 *   1. `<repo>/.viberon/recipes/<name>.yaml|yml`   (repo)
 *   2. `$VIBERON_RECIPES_DIR` or `~/Viberon/recipes` (global)
 *   3. the built-in examples                        (builtin)
 * A reference containing a path separator or ending in .yaml/.yml is read
 * as a file instead (source "file").
 *
 * Sharing is the file itself. `importRecipe` fetches (https only, size
 * capped) or reads one, validates it, and only then saves it verbatim.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BUILTIN_RECIPES } from "@/lib/recipes/builtin";
import { parseRecipe, RECIPE_NAME_RE } from "@/lib/recipes/schema";
import type { Recipe, RecipeEntry, RecipeIssue, RecipeSource } from "@/lib/recipes/types";
import { MAX_YAML_BYTES } from "@/lib/recipes/yaml";

/** Remote imports larger than this are refused. */
export const MAX_IMPORT_BYTES = 64 * 1024;
const IMPORT_TIMEOUT_MS = 15_000;
const MAX_FILES_PER_DIR = 200;

export class RecipeError extends Error {
  constructor(
    message: string,
    readonly issues: RecipeIssue[] = [],
  ) {
    super(message);
    this.name = "RecipeError";
  }
}

export function globalRecipesDir(): string {
  return process.env.VIBERON_RECIPES_DIR || path.join(os.homedir(), "Viberon", "recipes");
}

export function repoRecipesDir(repoRoot: string): string {
  return path.join(repoRoot, ".viberon", "recipes");
}

function isRecipeFile(name: string): boolean {
  return /\.ya?ml$/i.test(name);
}

/** Parse one file into an entry; a problem becomes the entry's errors, never a throw. */
async function entryFromFile(file: string, source: RecipeSource): Promise<RecipeEntry> {
  const base = path.basename(file).replace(/\.ya?ml$/i, "");
  try {
    const info = await stat(file);
    if (info.size > MAX_YAML_BYTES) {
      return { name: base, source, path: file, errors: [{ path: "", message: `the file is larger than ${MAX_YAML_BYTES / 1024} KB` }] };
    }
    const { recipe, issues } = parseRecipe(await readFile(file, "utf8"));
    if (!recipe) return { name: base, source, path: file, errors: issues };
    if (recipe.name !== base && source !== "file") {
      return {
        name: base,
        source,
        path: file,
        errors: [{ path: "name", message: `the recipe is named "${recipe.name}" but the file is ${path.basename(file)}; rename the file to ${recipe.name}.yaml` }],
      };
    }
    return { name: recipe.name, source, path: file, recipe };
  } catch (error) {
    return { name: base, source, path: file, errors: [{ path: "", message: error instanceof Error ? error.message : String(error) }] };
  }
}

async function entriesIn(dir: string, source: RecipeSource): Promise<RecipeEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = names.filter(isRecipeFile).sort().slice(0, MAX_FILES_PER_DIR);
  return Promise.all(files.map((f) => entryFromFile(path.join(dir, f), source)));
}

function builtinEntries(): RecipeEntry[] {
  return Object.entries(BUILTIN_RECIPES).map(([name, source]) => {
    const { recipe, issues } = parseRecipe(source);
    return recipe ? { name, source: "builtin" as const, recipe } : { name, source: "builtin" as const, errors: issues };
  });
}

/**
 * Every recipe visible from a repository (or globally, without one), one
 * entry per name in precedence order. Invalid files are listed with errors.
 */
export async function listRecipes(repoRoot?: string | null): Promise<RecipeEntry[]> {
  const layers: RecipeEntry[][] = [
    repoRoot ? await entriesIn(repoRecipesDir(repoRoot), "repo") : [],
    await entriesIn(globalRecipesDir(), "global"),
    builtinEntries(),
  ];
  const byName = new Map<string, RecipeEntry>();
  for (const layer of layers) {
    for (const entry of layer) {
      const winner = byName.get(entry.name);
      if (winner) winner.shadows = [...(winner.shadows ?? []), entry.source];
      else byName.set(entry.name, { ...entry });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.includes(path.sep) || isRecipeFile(ref);
}

/** Find a recipe by name (or file path). Returns null when nothing matches. */
export async function findRecipe(ref: string, repoRoot?: string | null): Promise<RecipeEntry | null> {
  if (looksLikePath(ref)) {
    const file = path.resolve(repoRoot && !path.isAbsolute(ref) && !existsSync(path.resolve(ref)) ? path.join(repoRoot, ref) : ref);
    if (!existsSync(file)) return null;
    return entryFromFile(file, "file");
  }
  if (!RECIPE_NAME_RE.test(ref)) return null;
  return (await listRecipes(repoRoot)).find((e) => e.name === ref) ?? null;
}

/** Like `findRecipe`, but throws a `RecipeError` for a missing or invalid recipe. */
export async function loadRecipe(ref: string, repoRoot?: string | null): Promise<{ entry: RecipeEntry; recipe: Recipe }> {
  const entry = await findRecipe(ref, repoRoot);
  if (!entry) {
    const names = (await listRecipes(repoRoot)).map((e) => e.name);
    throw new RecipeError(`No recipe named "${ref}". Available: ${names.join(", ") || "none"}.`);
  }
  if (!entry.recipe) throw new RecipeError(`Recipe "${entry.name}" is invalid.`, entry.errors ?? []);
  return { entry, recipe: entry.recipe };
}

/** The YAML text of an entry, for `recipe show` and sharing. */
export async function recipeSourceText(entry: RecipeEntry): Promise<string> {
  if (entry.source === "builtin") return BUILTIN_RECIPES[entry.name] ?? "";
  if (!entry.path) return "";
  return readFile(entry.path, "utf8");
}

/* -------------------------------- import --------------------------------- */

/** GitHub "blob" pages are HTML; fetch the raw file behind them instead. */
export function normalizeImportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RecipeError(`"${raw}" is not a valid URL or an existing file.`);
  }
  if (url.protocol !== "https:") throw new RecipeError(`Only https:// URLs can be imported (got ${url.protocol}).`);
  if (url.username || url.password) throw new RecipeError("URLs with embedded credentials are not accepted.");
  const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (url.hostname === "github.com" && blob) {
    return new URL(`https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`);
  }
  return url;
}

/** Fetch at most `MAX_IMPORT_BYTES` over https; refuses redirects off https. */
export async function fetchRecipeText(raw: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = normalizeImportUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMPORT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { redirect: "follow", signal: controller.signal, headers: { Accept: "text/plain, application/yaml, */*" } });
    } catch (error) {
      throw new RecipeError(
        controller.signal.aborted
          ? `Fetching ${url.href} timed out after ${IMPORT_TIMEOUT_MS / 1000}s.`
          : `Could not fetch ${url.href}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.url && !response.url.startsWith("https://")) {
      throw new RecipeError(`${url.href} redirected to a non-https URL; refusing it.`);
    }
    if (!response.ok) throw new RecipeError(`Fetching ${url.href} failed: HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_IMPORT_BYTES) {
      throw new RecipeError(`The recipe is ${declared} bytes; the import limit is ${MAX_IMPORT_BYTES / 1024} KB.`);
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMPORT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RecipeError(`The recipe is larger than the ${MAX_IMPORT_BYTES / 1024} KB import limit.`);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

export interface ImportOptions {
  /** Save into this repository's `.viberon/recipes` (default: the global dir). */
  repoRoot?: string | null;
  scope?: "repo" | "global";
  /** Replace an existing recipe with a different content. */
  force?: boolean;
  fetchImpl?: typeof fetch;
}

export interface ImportResult {
  recipe: Recipe;
  path: string;
  /** False when an identical file was already there. */
  written: boolean;
}

/** Import a recipe from an https URL or a local file: validate first, then save verbatim. */
export async function importRecipe(ref: string, options: ImportOptions = {}): Promise<ImportResult> {
  let text: string;
  const local = !/^[a-z][a-z0-9+.-]*:\/\//i.test(ref);
  if (local) {
    const file = path.resolve(ref);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new RecipeError(`No such file: ${file}`);
    if (info.size > MAX_IMPORT_BYTES) throw new RecipeError(`The recipe is larger than the ${MAX_IMPORT_BYTES / 1024} KB import limit.`);
    text = await readFile(file, "utf8");
  } else {
    text = await fetchRecipeText(ref, options.fetchImpl);
  }

  const { recipe, issues } = parseRecipe(text);
  if (!recipe) throw new RecipeError(`The recipe at ${ref} is invalid; nothing was saved.`, issues);

  const scope = options.scope ?? (options.repoRoot ? "repo" : "global");
  if (scope === "repo" && !options.repoRoot) throw new RecipeError("Importing into a repository needs --repo.");
  const dir = scope === "repo" ? repoRecipesDir(options.repoRoot!) : globalRecipesDir();
  const target = path.join(dir, `${recipe.name}.yaml`);
  const saved = text.endsWith("\n") ? text : `${text}\n`;
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing !== null) {
    if (existing === saved) return { recipe, path: target, written: false };
    if (!options.force) {
      throw new RecipeError(`${target} already exists with different content; pass --force to replace it.`);
    }
  }
  await mkdir(dir, { recursive: true });
  await writeFile(target, saved, "utf8");
  return { recipe, path: target, written: true };
}
