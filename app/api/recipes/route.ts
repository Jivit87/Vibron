/**
 * Recipes: list, show and validate.
 *
 *   GET  /api/recipes?repoKey=           → { recipes: RecipeEntry[] }  (repo, global, built-in; invalid ones carry errors)
 *   GET  /api/recipes?repoKey=&name=x    → { entry: RecipeEntry, text }  (404 when unknown)
 *   POST /api/recipes  { source }        → { ok, recipe?, errors }       (validate YAML text)
 *   POST /api/recipes  { repoKey?, name, params? }
 *                                        → { ok, recipe?, errors, params? } (validate a saved recipe and,
 *                                           with `params`, the values a run would get)
 *
 * Running is `POST /api/recipes/run` (SSE).
 */

import { jsonBody, str } from "@/lib/deliver/errors";
import { parseRecipe, RECIPE_NAME_RE, resolveParams } from "@/lib/recipes/schema";
import { findRecipe, listRecipes, recipeSourceText } from "@/lib/recipes/store";
import { MAX_YAML_BYTES } from "@/lib/recipes/yaml";
import { openWorkspace } from "@/lib/workspace";

export const runtime = "nodejs";

async function rootFor(repoKey: string): Promise<string | null> {
  return repoKey ? (await openWorkspace(repoKey)).rootPath : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const repoKey = str(url.searchParams.get("repoKey"));
  const name = str(url.searchParams.get("name"));
  const root = await rootFor(repoKey);
  if (name) {
    // Names only: the API never reads arbitrary files by path.
    if (!RECIPE_NAME_RE.test(name)) return Response.json({ error: "name must be a recipe name" }, { status: 400 });
    const entry = await findRecipe(name, root);
    if (!entry || entry.source === "file") return Response.json({ error: `No recipe named "${name}".` }, { status: 404 });
    return Response.json({ entry, text: await recipeSourceText(entry) });
  }
  return Response.json({ recipes: await listRecipes(root) });
}

export async function POST(request: Request) {
  const body = await jsonBody(request);
  if (body instanceof Response) return body;

  if (typeof body.source === "string") {
    if (Buffer.byteLength(body.source, "utf8") > MAX_YAML_BYTES) {
      return Response.json({ error: `source is larger than ${MAX_YAML_BYTES / 1024} KB` }, { status: 413 });
    }
    const { recipe, issues } = parseRecipe(body.source);
    return Response.json({ ok: Boolean(recipe), ...(recipe ? { recipe } : {}), errors: issues });
  }

  const name = str(body.name);
  if (!name) return Response.json({ error: "source or name is required" }, { status: 400 });
  if (!RECIPE_NAME_RE.test(name)) return Response.json({ error: "name must be a recipe name" }, { status: 400 });
  const entry = await findRecipe(name, await rootFor(str(body.repoKey)));
  if (!entry || entry.source === "file") return Response.json({ error: `No recipe named "${name}".` }, { status: 404 });
  if (!entry.recipe) return Response.json({ ok: false, errors: entry.errors ?? [] });
  if (body.params === undefined) return Response.json({ ok: true, recipe: entry.recipe, errors: [] });
  if (!body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
    return Response.json({ error: "params must be an object" }, { status: 400 });
  }
  const { values, issues } = resolveParams(entry.recipe, body.params as Record<string, unknown>);
  return Response.json({ ok: issues.length === 0, recipe: entry.recipe, errors: issues, params: values });
}
