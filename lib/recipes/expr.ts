/**
 * `{{ … }}` templating and `when:` conditions for recipes.
 *
 * Templates reference parameters (`{{ file }}`) and earlier steps' output
 * (`{{ steps.lint.output }}`). In shell contexts every substituted value is
 * shell-quoted, so a parameter can never inject shell syntax; the rendered
 * command still goes through the terminal's policy and blocklist.
 *
 * Conditions are a tiny boolean language, parsed at validation time so a
 * typo is a load error rather than a surprise halfway through a run:
 *
 *   expr     := or
 *   or       := and ("||" and)*
 *   and      := unary ("&&" unary)*
 *   unary    := "!" unary | compare
 *   compare  := operand (("==" | "!=") operand)?
 *   operand  := "(" expr ")" | literal | "always" | "success" | "failure"
 *             | "params." NAME | STEP_ID "." ("succeeded" | "failed" | "skipped" | "ran")
 *   literal  := "string" | 'string' | number | true | false
 */

import type { ParamValue, StepStatus } from "@/lib/recipes/types";

export class ExprError extends Error {}

/* ------------------------------ templates -------------------------------- */

export type TemplateRef = { kind: "param"; name: string } | { kind: "step"; id: string };

type TemplatePart = string | TemplateRef;

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const STEP_REF = /^steps\.([a-z][a-z0-9_-]*)\.output$/;

/** Split a template into literal text and references. `\{{` is a literal `{{`. */
export function parseTemplate(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let literal = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\\{{", i)) {
      literal += "{{";
      i += 3;
      continue;
    }
    if (!text.startsWith("{{", i)) {
      literal += text[i];
      i += 1;
      continue;
    }
    const close = text.indexOf("}}", i + 2);
    if (close === -1) throw new ExprError(`unterminated "{{" in "${preview(text.slice(i))}" (write \\{{ for a literal)`);
    const inner = text.slice(i + 2, close).trim();
    const step = STEP_REF.exec(inner);
    if (step) {
      if (literal) parts.push(literal);
      literal = "";
      parts.push({ kind: "step", id: step[1] });
    } else if (PARAM_NAME.test(inner)) {
      if (literal) parts.push(literal);
      literal = "";
      parts.push({ kind: "param", name: inner });
    } else {
      throw new ExprError(
        `"{{${inner}}}" is not a parameter name or steps.<id>.output`,
      );
    }
    i = close + 2;
  }
  if (literal) parts.push(literal);
  return parts;
}

export function templateRefs(text: string): TemplateRef[] {
  return parseTemplate(text).filter((p): p is TemplateRef => typeof p !== "string");
}

/** Leave simple words bare for readability; single-quote everything else. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_./@:=+,%-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface TemplateContext {
  params: Record<string, ParamValue>;
  outputs: Record<string, string>;
}

/** Render a template; in `shell` mode each substituted value is shell-quoted. */
export function renderTemplate(text: string, ctx: TemplateContext, mode: "text" | "shell" = "text"): string {
  return parseTemplate(text)
    .map((part) => {
      if (typeof part === "string") return part;
      const raw =
        part.kind === "param"
          ? ctx.params[part.name] === undefined
            ? ""
            : String(ctx.params[part.name])
          : (ctx.outputs[part.id] ?? "");
      return mode === "shell" ? shellQuote(raw) : raw;
    })
    .join("");
}

/* ------------------------------ conditions ------------------------------- */

type Value = boolean | string | number;

export type Condition =
  | { op: "lit"; value: Value }
  | { op: "always" | "success" | "failure" }
  | { op: "param"; name: string }
  | { op: "step"; id: string; state: StepStatus | "ran" }
  | { op: "not"; arg: Condition }
  | { op: "and" | "or"; left: Condition; right: Condition }
  | { op: "eq" | "ne"; left: Condition; right: Condition };

type Token =
  | { t: "op"; v: "!" | "&&" | "||" | "(" | ")" | "==" | "!=" }
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "word"; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (ch === "!" || ch === "(" || ch === ")") {
      out.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      if (end === -1) throw new ExprError(`unterminated string in condition "${src}"`);
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(src.slice(i));
    if (num && !/[A-Za-z_]/.test(src[i + num[0].length] ?? "")) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(src.slice(i));
    if (word) {
      out.push({ t: "word", v: word[0] });
      i += word[0].length;
      continue;
    }
    throw new ExprError(`unexpected "${ch}" in condition "${src}"`);
  }
  return out;
}

const STATES = new Set(["succeeded", "failed", "skipped", "ran"]);

/** Parse a `when:` condition. Throws `ExprError`. */
export function parseCondition(src: string): Condition {
  const tokens = tokenize(src);
  if (!tokens.length) throw new ExprError("the condition is empty");
  let pos = 0;
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.t === "op" && peek()!.v === v;

  const operand = (): Condition => {
    const tok = tokens[pos];
    if (!tok) throw new ExprError(`condition "${src}" ends unexpectedly`);
    pos += 1;
    if (tok.t === "op") {
      if (tok.v !== "(") throw new ExprError(`unexpected "${tok.v}" in condition "${src}"`);
      const inner = or();
      if (!isOp(")")) throw new ExprError(`missing ")" in condition "${src}"`);
      pos += 1;
      return inner;
    }
    if (tok.t === "str" || tok.t === "num") return { op: "lit", value: tok.v };
    const w = tok.v;
    if (w === "true" || w === "false") return { op: "lit", value: w === "true" };
    if (w === "always" || w === "success" || w === "failure") return { op: w };
    if (w.startsWith("params.")) {
      const name = w.slice("params.".length);
      if (!PARAM_NAME.test(name)) throw new ExprError(`"${w}" is not a valid parameter reference`);
      return { op: "param", name };
    }
    const dot = w.lastIndexOf(".");
    const id = dot > 0 ? w.slice(0, dot) : "";
    const state = w.slice(dot + 1);
    if (!id || !STATES.has(state)) {
      throw new ExprError(
        `"${w}" is not a condition; use <step>.succeeded|failed|skipped|ran, params.<name>, always, success or failure`,
      );
    }
    return { op: "step", id, state: state as StepStatus | "ran" };
  };

  const compare = (): Condition => {
    const left = operand();
    if (isOp("==") || isOp("!=")) {
      const op = (tokens[pos] as { v: string }).v === "==" ? "eq" : "ne";
      pos += 1;
      return { op, left, right: operand() };
    }
    return left;
  };
  const unary = (): Condition => {
    if (isOp("!")) {
      pos += 1;
      return { op: "not", arg: unary() };
    }
    return compare();
  };
  const and = (): Condition => {
    let left = unary();
    while (isOp("&&")) {
      pos += 1;
      left = { op: "and", left, right: unary() };
    }
    return left;
  };
  function or(): Condition {
    let left = and();
    while (isOp("||")) {
      pos += 1;
      left = { op: "or", left, right: and() };
    }
    return left;
  }

  const tree = or();
  if (pos < tokens.length) {
    const tok = tokens[pos];
    throw new ExprError(`unexpected "${tok.v}" in condition "${src}"`);
  }
  return tree;
}

/** Every step id and parameter a condition mentions (for validation). */
export function conditionRefs(cond: Condition): { steps: string[]; params: string[] } {
  const steps: string[] = [];
  const params: string[] = [];
  const walk = (c: Condition) => {
    if (c.op === "step") steps.push(c.id);
    else if (c.op === "param") params.push(c.name);
    else if (c.op === "not") walk(c.arg);
    else if ("left" in c) {
      walk(c.left);
      walk(c.right);
    }
  };
  walk(cond);
  return { steps, params };
}

export interface ConditionContext {
  params: Record<string, ParamValue>;
  outcomes: Record<string, StepStatus>;
  /** Whether the recipe has failed so far (a failed step without continue_on_error). */
  failed: boolean;
}

function truthy(v: Value): boolean {
  return typeof v === "string" ? v.length > 0 : typeof v === "number" ? v !== 0 : v;
}

function value(c: Condition, ctx: ConditionContext): Value {
  switch (c.op) {
    case "lit":
      return c.value;
    case "always":
      return true;
    case "success":
      return !ctx.failed;
    case "failure":
      return ctx.failed;
    case "param":
      return ctx.params[c.name] ?? "";
    case "step": {
      const status = ctx.outcomes[c.id];
      return c.state === "ran" ? status === "succeeded" || status === "failed" : status === c.state;
    }
    case "not":
      return !truthy(value(c.arg, ctx));
    case "and":
      return truthy(value(c.left, ctx)) && truthy(value(c.right, ctx));
    case "or":
      return truthy(value(c.left, ctx)) || truthy(value(c.right, ctx));
    case "eq":
    case "ne": {
      // Compare as strings so `params.n == 3` works whatever the param's type.
      const same = String(value(c.left, ctx)) === String(value(c.right, ctx));
      return c.op === "eq" ? same : !same;
    }
  }
}

export function evaluateCondition(cond: Condition, ctx: ConditionContext): boolean {
  return truthy(value(cond, ctx));
}

function preview(text: string): string {
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}
