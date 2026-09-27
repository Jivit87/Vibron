import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchRecipeText,
  findRecipe,
  globalRecipesDir,
  importRecipe,
  listRecipes,
  loadRecipe,
  MAX_IMPORT_BYTES,
  normalizeImportUrl,
  recipeSourceText,
  RecipeError,
  repoRecipesDir,
} from "@/lib/recipes/store";

const recipe = (name: string, description = "d") => `name: ${name}\ndescription: ${description}\nversion: 1\nsteps:\n  - shell: ls\n`;

let tmp: string;
let repo: string;
let globalDir: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "viberon-recipes-"));
  repo = path.join(tmp, "repo");
  globalDir = path.join(tmp, "global");
  mkdirSync(repoRecipesDir(repo), { recursive: true });
  mkdirSync(globalDir, { recursive: true });
  vi.stubEnv("VIBERON_RECIPES_DIR", globalDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

function put(dir: string, file: string, text: string) {
  writeFileSync(path.join(dir, file), text);
}

/** A fetch that serves `body` from `finalUrl` (after any "redirect"). */
function fakeFetch(body: string | Uint8Array, init: { status?: number; finalUrl?: string; headers?: Record<string, string> } = {}) {
  return vi.fn(async (input: string | URL | Request) => {
    const response = new Response(body as BodyInit, { status: init.status ?? 200, headers: init.headers });
    Object.defineProperty(response, "url", { value: init.finalUrl ?? String(input) });
    return response;
  });
}

describe("listing and lookup", () => {
  it("merges repo, global and built-in recipes with repo > global > builtin precedence", async () => {
    put(repoRecipesDir(repo), "add-tests.yaml", recipe("add-tests", "repo version"));
    put(globalDir, "add-tests.yml", recipe("add-tests", "global version"));
    put(globalDir, "mine.yaml", recipe("mine"));
    put(repoRecipesDir(repo), "notes.txt", "ignored");
    const entries = await listRecipes(repo);
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(byName["add-tests"]).toMatchObject({ source: "repo", shadows: ["global", "builtin"], recipe: { description: "repo version" } });
    expect(byName.mine).toMatchObject({ source: "global", path: path.join(globalDir, "mine.yaml") });
    expect(byName["fix-lint"]).toMatchObject({ source: "builtin" });
    expect(entries.map((e) => e.name)).toEqual([...entries.map((e) => e.name)].sort());
    expect(globalRecipesDir()).toBe(globalDir);
  });

  it("lists invalid files with their errors instead of failing", async () => {
    put(repoRecipesDir(repo), "broken.yaml", "name: broken\nsteps: [\n");
    put(repoRecipesDir(repo), "wrong-name.yaml", recipe("other-name"));
    const entries = await listRecipes(repo);
    expect(entries.find((e) => e.name === "broken")).toMatchObject({
      source: "repo",
      errors: [{ line: 2, message: expect.stringMatching(/unterminated flow sequence/) }],
    });
    expect(entries.find((e) => e.name === "wrong-name")?.errors?.[0]?.message).toMatch(/rename the file to other-name\.yaml/);
  });

  it("finds by name or by file path, and explains a missing or invalid recipe", async () => {
    put(repoRecipesDir(repo), "broken.yaml", "name: broken\n");
    const file = path.join(tmp, "loose.yaml");
    writeFileSync(file, recipe("loose-one"));
    expect(await findRecipe(file, repo)).toMatchObject({ source: "file", name: "loose-one" });
    expect(await findRecipe("nope", repo)).toBeNull();
    expect(await findRecipe("Not A Name", repo)).toBeNull();
    await expect(loadRecipe("nope", repo)).rejects.toThrow(/No recipe named "nope". Available: add-tests, broken/);
    await expect(loadRecipe("broken", repo)).rejects.toMatchObject({ issues: expect.arrayContaining([expect.objectContaining({ path: "description" })]) });
    const { recipe: loaded } = await loadRecipe("add-tests", repo);
    expect(loaded.name).toBe("add-tests");
  });

  it("returns the source text verbatim for show", async () => {
    const text = `# a comment survives\n${recipe("mine")}`;
    put(globalDir, "mine.yaml", text);
    const entry = (await findRecipe("mine", null))!;
    expect(await recipeSourceText(entry)).toBe(text);
    expect(await recipeSourceText((await findRecipe("add-tests", null))!)).toMatch(/^# Write unit tests/);
  });
});

describe("import", () => {
  it("imports a local file into the repository, verbatim, and is idempotent", async () => {
    const src = path.join(tmp, "share.yaml");
    writeFileSync(src, `# shared\n${recipe("shared")}`);
    const first = await importRecipe(src, { repoRoot: repo });
    expect(first).toMatchObject({ written: true, path: path.join(repoRecipesDir(repo), "shared.yaml") });
    expect(readFileSync(first.path, "utf8")).toBe(`# shared\n${recipe("shared")}`);
    expect(await importRecipe(src, { repoRoot: repo })).toMatchObject({ written: false });
  });

  it("refuses to overwrite a different recipe without force", async () => {
    const src = path.join(tmp, "share.yaml");
    writeFileSync(src, recipe("shared", "new"));
    put(globalDir, "shared.yaml", recipe("shared", "old"));
    await expect(importRecipe(src, {})).rejects.toThrow(/already exists with different content; pass --force/);
    const forced = await importRecipe(src, { force: true });
    expect(forced.path).toBe(path.join(globalDir, "shared.yaml"));
    expect(readFileSync(forced.path, "utf8")).toContain("description: new");
  });

  it("validates before saving: an invalid recipe is never written", async () => {
    const src = path.join(tmp, "bad.yaml");
    writeFileSync(src, "name: bad\nversion: 1\nsteps:\n  - shell: ls\n");
    const error = await importRecipe(src, {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RecipeError);
    expect((error as RecipeError).issues).toEqual([{ path: "description", message: "is required", line: 1 }]);
    expect(existsSync(path.join(globalDir, "bad.yaml"))).toBe(false);
    await expect(importRecipe(path.join(tmp, "missing.yaml"))).rejects.toThrow(/No such file/);
  });

  it("fetches https URLs, rewriting GitHub blob links to raw", async () => {
    const fetchImpl = fakeFetch(recipe("remote"));
    const result = await importRecipe("https://github.com/acme/recipes/blob/main/remote.yaml", { fetchImpl });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://raw.githubusercontent.com/acme/recipes/main/remote.yaml");
    expect(result).toMatchObject({ written: true, recipe: { name: "remote" } });
    expect(normalizeImportUrl("https://example.com/r.yaml").href).toBe("https://example.com/r.yaml");
  });

  it("refuses non-https URLs, credentials, redirects off https and HTTP errors", async () => {
    const fetchImpl = fakeFetch(recipe("x"));
    await expect(importRecipe("http://example.com/r.yaml", { fetchImpl })).rejects.toThrow(/Only https:\/\/ URLs/);
    await expect(importRecipe("file:///etc/passwd", { fetchImpl })).rejects.toThrow(/Only https:\/\/ URLs/);
    await expect(importRecipe("https://u:p@example.com/r.yaml", { fetchImpl })).rejects.toThrow(/credentials/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      fetchRecipeText("https://example.com/r.yaml", fakeFetch(recipe("x"), { finalUrl: "http://evil.example/r.yaml" })),
    ).rejects.toThrow(/redirected to a non-https URL/);
    await expect(fetchRecipeText("https://example.com/r.yaml", fakeFetch("nope", { status: 404 }))).rejects.toThrow(/HTTP 404/);
    const failing = vi.fn(async () => {
      throw new TypeError("getaddrinfo ENOTFOUND");
    });
    await expect(fetchRecipeText("https://nowhere.example/r.yaml", failing)).rejects.toThrow(/Could not fetch .*ENOTFOUND/);
  });

  it("caps the download size, by header and while streaming", async () => {
    await expect(
      fetchRecipeText("https://example.com/r.yaml", fakeFetch("x", { headers: { "content-length": String(MAX_IMPORT_BYTES + 1) } })),
    ).rejects.toThrow(/import limit/);
    const big = new Uint8Array(MAX_IMPORT_BYTES + 10).fill(97);
    await expect(fetchRecipeText("https://example.com/r.yaml", fakeFetch(big))).rejects.toThrow(/larger than the 64 KB import limit/);
    const bigFile = path.join(tmp, "big.yaml");
    writeFileSync(bigFile, "#".repeat(MAX_IMPORT_BYTES + 1));
    await expect(importRecipe(bigFile)).rejects.toThrow(/import limit/);
  });

  it("needs a repository for a repo-scoped import", async () => {
    const src = path.join(tmp, "s.yaml");
    writeFileSync(src, recipe("s"));
    await expect(importRecipe(src, { scope: "repo" })).rejects.toThrow(/needs --repo/);
  });
});
