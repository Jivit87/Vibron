/**
 * Browser helpers for recipes: the `/recipe` composer command, the dialog's
 * form state, and the event that opens the dialog from anywhere (composer,
 * command palette) without a store field.
 */

import { parseSlashCommand, splitArgs } from "@/lib/composer/parsing";
import type { ParamValue, Recipe, RecipeEntry, RecipeIssue } from "@/lib/recipes/types";

export const OPEN_RECIPE_EVENT = "viberon:recipe";

export interface OpenRecipeDetail {
  name?: string;
  /** Prefilled values, as typed (`/recipe add-tests file=src/a.ts`). */
  params?: Record<string, string>;
}

export function openRecipeDialog(detail: OpenRecipeDetail = {}): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<OpenRecipeDetail>(OPEN_RECIPE_EVENT, { detail }));
}

/**
 * `/recipe`, `/recipe add-tests`, `/recipe add-tests file=src/a.ts focus="edge cases"`
 * → what the dialog should open with; null when the text is not a /recipe command.
 */
export function parseRecipeCommand(text: string): OpenRecipeDetail | null {
  const slash = parseSlashCommand(text);
  if (!slash || (slash.name !== "recipe" && slash.name !== "recipes")) return null;
  const [name] = splitArgs(slash.args);
  const params: Record<string, string> = {};
  const rest = slash.args.slice(slash.args.indexOf(name ?? "") + (name?.length ?? 0));
  const pair = /(?:^|\s)([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|(\S*))/g;
  for (let m = pair.exec(rest); m; m = pair.exec(rest)) params[m[1]!] = m[2] ?? m[3] ?? m[4] ?? "";
  return { ...(name ? { name } : {}), ...(Object.keys(params).length ? { params } : {}) };
}

/** Form state for a recipe: defaults, then anything prefilled. Booleans stay booleans. */
export function initialForm(recipe: Recipe, prefill: Record<string, string> = {}): Record<string, string | boolean> {
  const form: Record<string, string | boolean> = {};
  for (const p of recipe.params) {
    const given = prefill[p.name];
    if (p.type === "boolean") {
      form[p.name] = given !== undefined ? ["true", "yes", "1", "on"].includes(given.toLowerCase()) : p.default === true;
    } else {
      form[p.name] = given ?? (p.default !== undefined ? String(p.default) : "");
    }
  }
  return form;
}

/** The request's `params`: empty optional fields are left out so defaults apply server-side. */
export function formToParams(recipe: Recipe, form: Record<string, string | boolean>): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const p of recipe.params) {
    const v = form[p.name];
    if (typeof v === "boolean") out[p.name] = v;
    else if (typeof v === "string" && v.trim() !== "") out[p.name] = v.trim();
  }
  return out;
}

/** Required parameters still empty in the form. */
export function missingRequired(recipe: Recipe, form: Record<string, string | boolean>): string[] {
  return recipe.params
    .filter((p) => p.required && p.type !== "boolean" && String(form[p.name] ?? "").trim() === "")
    .map((p) => p.name);
}

export async function fetchRecipes(repoKey: string | null): Promise<RecipeEntry[]> {
  const response = await fetch(`/api/recipes${repoKey ? `?repoKey=${encodeURIComponent(repoKey)}` : ""}`);
  if (!response.ok) throw new Error(`Could not load recipes (${response.status})`);
  return ((await response.json()) as { recipes: RecipeEntry[] }).recipes;
}

/** Server-side check of the values a run would get; returns the problems. */
export async function checkParams(
  repoKey: string | null,
  name: string,
  params: Record<string, ParamValue>,
): Promise<RecipeIssue[]> {
  const response = await fetch("/api/recipes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(repoKey ? { repoKey } : {}), name, params }),
  });
  const body = (await response.json().catch(() => null)) as { errors?: RecipeIssue[]; error?: string } | null;
  if (!response.ok) return [{ path: "", message: body?.error ?? `Request failed (${response.status})` }];
  return body?.errors ?? [];
}
