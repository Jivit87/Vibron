import { describe, expect, it } from "vitest";

import { formToParams, initialForm, missingRequired, parseRecipeCommand } from "@/lib/client/recipes";
import { BUILTIN_RECIPES } from "@/lib/recipes/builtin";
import { parseRecipe } from "@/lib/recipes/schema";

const recipe = parseRecipe(`name: r
description: d
version: 1
params:
  file:
    type: path
    required: true
  on:
    type: boolean
    default: true
  off: boolean
  mode:
    type: enum
    values: [a, b]
    default: a
  n: number
steps:
  - shell: ls
`).recipe!;

describe("composer /recipe command", () => {
  it("opens the picker, optionally on a recipe with prefilled params", () => {
    expect(parseRecipeCommand("/recipe")).toEqual({});
    expect(parseRecipeCommand("/recipes")).toEqual({});
    expect(parseRecipeCommand("/recipe add-tests")).toEqual({ name: "add-tests" });
    expect(parseRecipeCommand('/recipe add-tests file=src/a.ts focus="edge cases" junk')).toEqual({
      name: "add-tests",
      params: { file: "src/a.ts", focus: "edge cases" },
    });
    expect(parseRecipeCommand("/fix the bug")).toBeNull();
    expect(parseRecipeCommand("recipe add-tests")).toBeNull();
  });
});

describe("recipe dialog form", () => {
  it("starts from defaults and prefilled values", () => {
    expect(initialForm(recipe)).toEqual({ file: "", on: true, off: false, mode: "a", n: "" });
    expect(initialForm(recipe, { file: "src/x.ts", off: "yes", mode: "b" })).toEqual({ file: "src/x.ts", on: true, off: true, mode: "b", n: "" });
  });

  it("sends only filled values and reports empty required fields", () => {
    const form = { file: " src/x.ts ", on: false, off: false, mode: "b", n: "" };
    expect(formToParams(recipe, form)).toEqual({ file: "src/x.ts", on: false, off: false, mode: "b" });
    expect(missingRequired(recipe, { ...form, file: "  " })).toEqual(["file"]);
    expect(missingRequired(recipe, form)).toEqual([]);
  });

  it("every built-in recipe renders a form", () => {
    for (const source of Object.values(BUILTIN_RECIPES)) {
      const r = parseRecipe(source).recipe!;
      expect(Object.keys(initialForm(r))).toEqual(r.params.map((p) => p.name));
    }
  });
});
