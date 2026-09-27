import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { BUILTIN_RECIPES } from "@/lib/recipes/builtin";
import {
  conditionRefs,
  evaluateCondition,
  ExprError,
  parseCondition,
  parseTemplate,
  renderTemplate,
  shellQuote,
} from "@/lib/recipes/expr";
import { coerceParam, parseRecipe, resolveParams } from "@/lib/recipes/schema";
import { formatIssue, type Recipe } from "@/lib/recipes/types";

const MINIMAL = `name: demo
description: A demo
version: 1.2.3
steps:
  - shell: ls
`;

function issuesOf(src: string) {
  const { recipe, issues } = parseRecipe(src);
  expect(recipe).toBeUndefined();
  return issues;
}

function valid(src: string): Recipe {
  const { recipe, issues } = parseRecipe(src);
  expect(issues).toEqual([]);
  return recipe!;
}

describe("built-in recipes", () => {
  it.each(Object.keys(BUILTIN_RECIPES))("%s parses and validates", (name) => {
    const recipe = valid(BUILTIN_RECIPES[name]!);
    expect(recipe.name).toBe(name);
    expect(recipe.steps.length).toBeGreaterThan(1);
    expect(recipe.steps.some((s) => s.kind === "verify" || s.kind === "shell")).toBe(true);
  });

  it("ships at least four examples covering agent, shell and verify steps", () => {
    const recipes = Object.values(BUILTIN_RECIPES).map(valid);
    expect(recipes.length).toBeGreaterThanOrEqual(4);
    const kinds = new Set(recipes.flatMap((r) => r.steps.map((s) => s.kind)));
    expect([...kinds].sort()).toEqual(["agent", "shell", "verify"]);
  });
});

describe("parseRecipe: valid recipes", () => {
  it("accepts the documented example in docs/RECIPES.md", () => {
    const doc = readFileSync(path.join(__dirname, "..", "docs", "RECIPES.md"), "utf8");
    const example = /```yaml\n([\s\S]*?)```/.exec(doc)![1]!;
    const recipe = valid(example);
    expect(recipe.steps.map((s) => s.kind)).toEqual(["agent", "verify", "agent", "shell"]);
  });

  it("fills defaults: step ids, titles, generalist role, numeric version", () => {
    const recipe = valid(`name: demo
description: d
version: 2
steps:
  - agent: Do the thing
  - shell: npm test
  - verify: auto
  - verify:
      command: npx tsc --noEmit
      kind: typecheck
`);
    expect(recipe.version).toBe("2");
    expect(recipe.steps.map((s) => [s.id, s.kind, s.title])).toEqual([
      ["step-1", "agent", "Do the thing"],
      ["step-2", "shell", "$ npm test"],
      ["step-3", "verify", "Run the repository's checks"],
      ["step-4", "verify", "Check: npx tsc --noEmit"],
    ]);
    expect(recipe.steps[0]).toMatchObject({ role: "generalist", files: [], continueOnError: false });
    expect(recipe.steps[3]).toMatchObject({ command: "npx tsc --noEmit", checkKind: "typecheck" });
  });

  it("parses typed params, including shorthand and defaults", () => {
    const recipe = valid(`name: p
description: d
version: 1.0
params:
  file: path
  count:
    type: number
    default: 3
  flag:
    type: boolean
    default: true
  mode:
    type: enum
    values: [a, b]
    default: b
  who:
    required: true
    description: Someone
steps:
  - agent:
      prompt: "{{file}} {{count}} {{flag}} {{mode}} {{who}}"
      role: tester
      tools: [read_file, write_file]
      files: ["{{file}}", "tests/**"]
      max_turns: 5
    when: params.flag && params.mode == "b"
    continue_on_error: true
`);
    expect(recipe.params).toEqual([
      { name: "file", type: "path", description: "", required: false },
      { name: "count", type: "number", description: "", required: false, default: 3 },
      { name: "flag", type: "boolean", description: "", required: false, default: true },
      { name: "mode", type: "enum", description: "", required: false, values: ["a", "b"], default: "b" },
      { name: "who", type: "string", description: "Someone", required: true },
    ]);
    expect(recipe.steps[0]).toMatchObject({
      kind: "agent",
      role: "tester",
      tools: ["read_file", "write_file"],
      files: ["{{file}}", "tests/**"],
      maxTurns: 5,
      when: 'params.flag && params.mode == "b"',
      continueOnError: true,
    });
  });
});

describe("parseRecipe: precise errors", () => {
  it("turns YAML errors into a line-numbered issue", () => {
    expect(issuesOf("name: x\nsteps: &a []\n")).toEqual([{ path: "", message: expect.stringMatching(/anchors/), line: 2 }]);
  });

  it("reports missing and malformed top-level fields", () => {
    const issues = issuesOf("name: Bad Name\nversion: v1\nextra: 1\n");
    expect(issues.map(formatIssue)).toEqual([
      'line 3: extra: unknown key "extra" (expected one of: name, description, version, author, params, steps)',
      "line 1: name: invalid name \"Bad Name\" (lowercase letters, digits and -, at most 64 characters)",
      "line 1: description: is required",
      'line 2: version: must look like 1, 1.2 or 1.2.3, found string "v1"',
      "line 1: steps: is required",
    ]);
  });

  it("rejects a non-mapping document", () => {
    expect(issuesOf("- a\n- b\n")[0]!.message).toMatch(/must be a mapping/);
  });

  it("validates steps: kinds, ids, roles, tools, files, templates and conditions", () => {
    const src = `name: demo
description: d
version: 1
params:
  file: path
steps:
  - id: one
    shell: ls
    agent: also
  - id: one
    shell: ls {{nope}}
  - id: Bad
    agent:
      prompt: x
      role: wizard
  - id: three
    agent:
      prompt: "{{steps.later.output}}"
      role: reviewer
      tools: [write_file]
      files: [../escape.ts]
  - id: four
    when: missing.failed || params.ghost
    verify:
      command: npm test
      targets: [a.test.ts]
  - id: five
    when: "three.failed &&"
    shell: echo
    timeout: 99999
  - id: later
    agent:
      prompt: x
      role: solver
      files: [a.ts]
    timeout: 5
  - verify: [1]
  - {}
  - id: always
    shell: ls
`;
    const messages = issuesOf(src).map(formatIssue);
    expect(messages).toEqual([
      "line 7: steps[0]: has agent and shell; a step is exactly one of agent, shell or verify",
      'line 11: steps[1].shell: "{{nope}}" is not a declared parameter (declared: file)',
      'line 12: steps[2].id: invalid step id "Bad" (lowercase letters, digits, - and _, starting with a letter)',
      expect.stringMatching(/^line 15: steps\[2\]\.agent\.role: unknown role "wizard" \(one of: assistant, .*solver\)$/),
      'line 18: steps[3].agent.prompt: "{{steps.later.output}}" must name an earlier step',
      expect.stringMatching(/^line 20: steps\[3\]\.agent\.tools\[0\]: "write_file" is not one of the reviewer role's tools/),
      'line 21: steps[3].agent.files[0]: must be a path inside the repository, found "../escape.ts"',
      expect.stringMatching(/^line 23: steps\[4\]\.when: "missing" is not an earlier step \(earlier: one, step-3, three\)$/),
      'line 23: steps[4].when: "params.ghost" is not a declared parameter',
      "line 26: steps[4].verify.targets: targets apply to the auto-detected check; put the files in the command instead",
      expect.stringMatching(/^line 28: steps\[5\]\.when: condition "three\.failed &&" ends unexpectedly/),
      "line 30: steps[5].timeout: must be a whole number from 1 to 3600, found number 99999",
      "line 36: steps[6].timeout: applies to shell and verify steps; limit an agent step with max_turns",
      "line 32: steps[6].agent: the solver role runs the full solve loop; it does not take tools or files",
      'line 37: steps[7].verify: must be "auto" or a mapping with command, kind or targets, found a list',
      "line 38: steps[8]: needs one of agent, shell or verify",
      'line 39: steps[9].id: "always" is reserved',
    ]);
  });

  it("rejects duplicate step ids", () => {
    const issues = issuesOf("name: d\ndescription: d\nversion: 1\nsteps:\n  - id: a\n    shell: ls\n  - id: a\n    shell: ls\n");
    expect(issues.map(formatIssue)).toEqual(['line 7: steps[1].id: duplicate step id "a"']);
  });

  it("validates params: names, types, enums, defaults", () => {
    const messages = issuesOf(`name: demo
description: d
version: 1
params:
  9bad: string
  a:
    type: color
  b:
    type: enum
  c:
    type: enum
    values: []
  d:
    type: number
    default: lots
  e:
    type: string
    values: [x]
  f:
    required: true
    default: x
  g:
    type: path
    default: /etc/passwd
  h: [1]
steps:
  - shell: ls
`).map(formatIssue);
    expect(messages).toEqual([
      'line 5: params.9bad: invalid parameter name "9bad" (letters, digits and _, not starting with a digit)',
      "line 7: params.a.type: must be one of string, number, boolean, enum, path, found string \"color\"",
      "line 8: params.b.values: is required for an enum parameter",
      "line 12: params.c.values: must list at least one value",
      'line 15: params.d.default: must be a number, got "lots"',
      "line 18: params.e.values: only applies to enum parameters",
      "line 21: params.f.default: a required parameter cannot have a default",
      'line 24: params.g.default: must be relative to the repository, got "/etc/passwd"',
      "line 25: params.h: must be a type name or a mapping, found a list",
    ]);
  });

  it("caps the number of steps", () => {
    const steps = Array.from({ length: 51 }, () => "  - shell: ls").join("\n");
    expect(issuesOf(`name: x\ndescription: d\nversion: 1\nsteps:\n${steps}\n`).map((i) => i.message)).toContain(
      "has 51 steps; the limit is 50",
    );
  });

  it("accepts the minimal recipe", () => {
    expect(valid(MINIMAL).steps).toHaveLength(1);
  });
});

describe("parameters", () => {
  const recipe = valid(`name: p
description: d
version: 1
params:
  file:
    type: path
    required: true
  n:
    type: number
    default: 2
  on: boolean
  mode:
    type: enum
    values: [fast, slow]
  note: string
steps:
  - shell: ls
`);

  it("coerces CLI strings and fills defaults", () => {
    expect(resolveParams(recipe, { file: "./src/a.ts", n: "7", on: "yes", mode: "slow" })).toEqual({
      values: { file: "src/a.ts", n: 7, on: true, mode: "slow", note: "" },
      issues: [],
    });
    expect(resolveParams(recipe, { file: "a" }).values).toEqual({ file: "a", n: 2, on: false, mode: "", note: "" });
  });

  it("reports missing, malformed and unknown parameters", () => {
    const { issues } = resolveParams(recipe, { n: "x", on: "maybe", mode: "medium", ghost: 1 });
    expect(issues.map(formatIssue)).toEqual([
      'params.ghost: unknown parameter "ghost" (this recipe takes: file, n, on, mode, note)',
      "params.file: is required",
      'params.n: must be a number, got "x"',
      'params.on: must be true or false, got "maybe"',
      'params.mode: must be one of fast, slow, got "medium"',
    ]);
  });

  it("keeps path parameters inside the repository", () => {
    const param = { name: "p", type: "path" as const, description: "", required: true };
    expect(coerceParam(param, "../x")).toEqual({ error: expect.stringMatching(/no "\.\."/) });
    expect(coerceParam(param, "a/../../x")).toEqual({ error: expect.stringMatching(/no "\.\."/) });
    expect(coerceParam(param, "/abs")).toEqual({ error: expect.stringMatching(/relative/) });
    expect(coerceParam(param, "~/x")).toEqual({ error: expect.stringMatching(/relative/) });
    expect(coerceParam(param, "C:\\x")).toEqual({ error: expect.stringMatching(/relative/) });
    expect(coerceParam(param, 3)).toEqual({ error: expect.stringMatching(/relative file path/) });
    expect(coerceParam(param, "src/a b.ts")).toEqual({ value: "src/a b.ts" });
  });
});

describe("templates", () => {
  it("parses params, step outputs and escapes", () => {
    expect(parseTemplate("a {{ x }} b {{steps.one.output}} \\{{literal}}")).toEqual([
      "a ",
      { kind: "param", name: "x" },
      " b ",
      { kind: "step", id: "one" },
      " {{literal}}",
    ]);
    expect(() => parseTemplate("{{ x")).toThrow(ExprError);
    expect(() => parseTemplate("{{ x.y }}")).toThrow(/not a parameter name/);
  });

  it("shell-quotes every substituted value in shell mode", () => {
    const ctx = { params: { file: "src/a b.ts", evil: "x; rm -rf ~", n: 3, safe: "src/a.ts" }, outputs: { s: "it's" } };
    expect(renderTemplate("ls {{file}} {{evil}} {{n}} {{safe}} {{steps.s.output}}", ctx, "shell")).toBe(
      "ls 'src/a b.ts' 'x; rm -rf ~' 3 src/a.ts 'it'\\''s'",
    );
    expect(renderTemplate("{{file}}: {{steps.s.output}}", ctx)).toBe("src/a b.ts: it's");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
  });
});

describe("conditions", () => {
  const ctx = {
    params: { flag: true, mode: "fast", n: 3, empty: "" },
    outcomes: { a: "succeeded" as const, b: "failed" as const, c: "skipped" as const },
    failed: false,
  };
  const run = (src: string, over: Partial<typeof ctx> = {}) => evaluateCondition(parseCondition(src), { ...ctx, ...over });

  it("evaluates step states, params, comparisons and boolean operators", () => {
    expect(run("a.succeeded")).toBe(true);
    expect(run("b.failed && a.ran")).toBe(true);
    expect(run("c.ran")).toBe(false);
    expect(run("c.skipped || b.succeeded")).toBe(true);
    expect(run("!(a.succeeded && b.failed)")).toBe(false);
    expect(run("params.flag")).toBe(true);
    expect(run("params.empty")).toBe(false);
    expect(run('params.mode == "fast"')).toBe(true);
    expect(run("params.mode != 'fast'")).toBe(false);
    expect(run("params.n == 3")).toBe(true);
    expect(run("always")).toBe(true);
    expect(run("success")).toBe(true);
    expect(run("failure", { failed: true })).toBe(true);
    expect(run("unknown.failed")).toBe(false);
  });

  it("lists referenced steps and params", () => {
    expect(conditionRefs(parseCondition("x-1.failed || (params.p && y_2.ran)"))).toEqual({ steps: ["x-1", "y_2"], params: ["p"] });
  });

  it("rejects malformed conditions with a clear message", () => {
    for (const [src, re] of [
      ["", /empty/],
      ["a.done", /not a condition/],
      ["a.failed b.failed", /unexpected "b.failed"/],
      ["(a.failed", /missing "\)"/],
      ["a.failed &", /unexpected "&"/],
      ["'unterminated", /unterminated string/],
      ["params.", /not a valid parameter reference/],
    ] as const) {
      expect(() => parseCondition(src)).toThrow(re);
    }
  });
});
