/**
 * Recipe schema: YAML value → typed `Recipe`, with every problem reported
 * at once, each with its path and source line.
 *
 * Validation is deliberately strict — unknown keys, unknown roles, tools a
 * role does not have, templates naming parameters that do not exist, and
 * conditions naming later steps are all errors — because a recipe is shared
 * and run unattended, and a typo should fail at load time, not mid-run.
 */

import { ROLES, type RoleId } from "@/lib/agents/roles";
import {
  conditionRefs,
  ExprError,
  parseCondition,
  templateRefs,
  type TemplateRef,
} from "@/lib/recipes/expr";
import type {
  AgentStep,
  ParamType,
  ParamValue,
  Recipe,
  RecipeIssue,
  RecipeParam,
  RecipeStep,
  VerifyStep,
} from "@/lib/recipes/types";
import { parseYaml, YamlError, type YamlValue } from "@/lib/recipes/yaml";

export const RECIPE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STEP_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION_RE = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;
const RESERVED_IDS = new Set(["always", "success", "failure", "params", "steps", "true", "false"]);
const PARAM_TYPES: ParamType[] = ["string", "number", "boolean", "enum", "path"];
const CHECK_KINDS = ["test", "typecheck", "compile", "lint"] as const;
export const MAX_STEPS = 50;
const MAX_TIMEOUT_SEC = 3600;

/** Roles a recipe step may use: the whole roster except the planner. */
export const RECIPE_ROLES: RoleId[] = (Object.keys(ROLES) as RoleId[]).filter((r) => r !== "orchestrator");

type Obj = { [key: string]: YamlValue };

function isObj(v: YamlValue | undefined): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: YamlValue | undefined): string {
  if (v === undefined || v === null) return "nothing";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "object") return "a mapping";
  return `${typeof v} ${JSON.stringify(v).slice(0, 40)}`;
}

class Checker {
  readonly issues: RecipeIssue[] = [];
  constructor(private readonly lines: Map<string, number>) {}

  lineOf(path: string): number | undefined {
    for (let p = path; ; ) {
      const line = this.lines.get(p);
      if (line !== undefined) return line;
      if (!p) return undefined;
      const cut = Math.max(p.lastIndexOf("."), p.lastIndexOf("["));
      p = cut > 0 ? p.slice(0, cut) : "";
    }
  }

  add(path: string, message: string): void {
    const line = this.lineOf(path);
    this.issues.push({ path, message, ...(line !== undefined ? { line } : {}) });
  }

  keys(obj: Obj, path: string, allowed: string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.add(join(path, key), `unknown key "${key}" (expected one of: ${allowed.join(", ")})`);
      }
    }
  }

  str(obj: Obj, key: string, path: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    const v = obj[key];
    const at = join(path, key);
    if (v === undefined || v === null) {
      if (opts.required) this.add(at, "is required");
      return undefined;
    }
    if (typeof v !== "string") {
      this.add(at, `must be a string, found ${describe(v)}`);
      return undefined;
    }
    if (opts.required && !v.trim()) {
      this.add(at, "must not be empty");
      return undefined;
    }
    if (opts.max && v.length > opts.max) this.add(at, `is longer than ${opts.max} characters`);
    return v;
  }

  bool(obj: Obj, key: string, path: string): boolean | undefined {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "boolean") {
      this.add(join(path, key), `must be true or false, found ${describe(v)}`);
      return undefined;
    }
    return v;
  }

  int(obj: Obj, key: string, path: string, min: number, max: number): number | undefined {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      this.add(join(path, key), `must be a whole number from ${min} to ${max}, found ${describe(v)}`);
      return undefined;
    }
    return v;
  }

  strList(obj: Obj, key: string, path: string): string[] | undefined {
    const v = obj[key];
    if (v === undefined || v === null) return undefined;
    const at = join(path, key);
    if (!Array.isArray(v)) {
      this.add(at, `must be a list of strings, found ${describe(v)}`);
      return undefined;
    }
    const out: string[] = [];
    v.forEach((item, i) => {
      if (typeof item !== "string" || !item.trim()) this.add(`${at}[${i}]`, `must be a non-empty string, found ${describe(item)}`);
      else out.push(item.trim());
    });
    return out;
  }
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/* -------------------------------- params --------------------------------- */

function checkParams(c: Checker, raw: YamlValue | undefined): RecipeParam[] {
  if (raw === undefined || raw === null) return [];
  if (!isObj(raw)) {
    c.add("params", `must be a mapping of parameter name to spec, found ${describe(raw)}`);
    return [];
  }
  const out: RecipeParam[] = [];
  for (const [name, spec0] of Object.entries(raw)) {
    const path = `params.${name}`;
    if (!PARAM_NAME_RE.test(name)) {
      c.add(path, `invalid parameter name "${name}" (letters, digits and _, not starting with a digit)`);
      continue;
    }
    // Shorthand: `file: path`.
    const spec: Obj | null = typeof spec0 === "string" ? { type: spec0 } : isObj(spec0) ? spec0 : spec0 === null ? {} : null;
    if (!spec) {
      c.add(path, `must be a type name or a mapping, found ${describe(spec0)}`);
      continue;
    }
    c.keys(spec, path, ["type", "description", "required", "default", "values"]);
    const typeRaw = spec.type ?? "string";
    if (typeof typeRaw !== "string" || !PARAM_TYPES.includes(typeRaw as ParamType)) {
      c.add(`${path}.type`, `must be one of ${PARAM_TYPES.join(", ")}, found ${describe(typeRaw)}`);
      continue;
    }
    const type = typeRaw as ParamType;
    const description = c.str(spec, "description", path, { max: 500 }) ?? "";
    const required = c.bool(spec, "required", path) ?? false;
    let values: string[] | undefined;
    if (type === "enum") {
      values = c.strList(spec, "values", path);
      if (!values?.length) {
        if (spec.values === undefined) c.add(`${path}.values`, "is required for an enum parameter");
        else if (values) c.add(`${path}.values`, "must list at least one value");
        continue;
      }
    } else if (spec.values !== undefined) {
      c.add(`${path}.values`, "only applies to enum parameters");
    }
    const param: RecipeParam = { name, type, description, required, ...(values ? { values } : {}) };
    if (spec.default !== undefined && spec.default !== null) {
      if (required) c.add(`${path}.default`, "a required parameter cannot have a default");
      const coerced = coerceParam(param, spec.default as ParamValue);
      if ("error" in coerced) c.add(`${path}.default`, coerced.error);
      else param.default = coerced.value;
    }
    out.push(param);
  }
  return out;
}

/**
 * Coerce one parameter value. Strings (from the CLI or a form) are parsed
 * into numbers and booleans; `path` values must stay inside the repository.
 */
export function coerceParam(param: RecipeParam, raw: unknown): { value: ParamValue } | { error: string } {
  switch (param.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      return Number.isFinite(n) ? { value: n } : { error: `must be a number, got ${JSON.stringify(raw)}` };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { value: raw };
      const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
      if (["true", "yes", "1", "on"].includes(s)) return { value: true };
      if (["false", "no", "0", "off"].includes(s)) return { value: false };
      return { error: `must be true or false, got ${JSON.stringify(raw)}` };
    }
    case "enum": {
      const s = typeof raw === "string" || typeof raw === "number" ? String(raw) : null;
      return s !== null && param.values?.includes(s)
        ? { value: s }
        : { error: `must be one of ${param.values?.join(", ")}, got ${JSON.stringify(raw)}` };
    }
    case "path": {
      if (typeof raw !== "string" || !raw.trim()) return { error: `must be a relative file path, got ${JSON.stringify(raw)}` };
      const p = raw.trim().replace(/^\.\//, "");
      if (p.includes("\0") || p.length > 500) return { error: "is not a valid path" };
      if (p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("~")) {
        return { error: `must be relative to the repository, got "${p}"` };
      }
      if (p.split(/[\\/]/).includes("..")) return { error: `must stay inside the repository (no ".."), got "${p}"` };
      return { value: p };
    }
    case "string": {
      if (typeof raw === "string") return raw.length > 20_000 ? { error: "is longer than 20000 characters" } : { value: raw };
      if (typeof raw === "number" || typeof raw === "boolean") return { value: String(raw) };
      return { error: `must be a string, got ${JSON.stringify(raw)}` };
    }
  }
}

/** Resolve supplied values against the recipe's parameters (defaults, required, types, unknown names). */
export function resolveParams(
  recipe: Recipe,
  supplied: Record<string, unknown>,
): { values: Record<string, ParamValue>; issues: RecipeIssue[] } {
  const values: Record<string, ParamValue> = {};
  const issues: RecipeIssue[] = [];
  const known = new Set(recipe.params.map((p) => p.name));
  for (const name of Object.keys(supplied)) {
    if (!known.has(name)) {
      issues.push({
        path: `params.${name}`,
        message: `unknown parameter "${name}"${known.size ? ` (this recipe takes: ${[...known].join(", ")})` : " (this recipe takes no parameters)"}`,
      });
    }
  }
  for (const param of recipe.params) {
    const raw = supplied[param.name];
    if (raw === undefined || raw === null || raw === "") {
      if (param.default !== undefined) values[param.name] = param.default;
      else if (param.required) issues.push({ path: `params.${param.name}`, message: "is required" });
      else if (param.type === "boolean") values[param.name] = false;
      else values[param.name] = "";
      continue;
    }
    const coerced = coerceParam(param, raw);
    if ("error" in coerced) issues.push({ path: `params.${param.name}`, message: coerced.error });
    else values[param.name] = coerced.value;
  }
  return { values, issues };
}

/* -------------------------------- steps ---------------------------------- */

const COMMON_STEP_KEYS = ["id", "title", "when", "continue_on_error", "timeout"];

function checkSteps(c: Checker, raw: YamlValue | undefined, params: RecipeParam[]): RecipeStep[] {
  if (raw === undefined || raw === null) {
    c.add("steps", "is required");
    return [];
  }
  if (!Array.isArray(raw)) {
    c.add("steps", `must be a list, found ${describe(raw)}`);
    return [];
  }
  if (raw.length === 0) c.add("steps", "must contain at least one step");
  if (raw.length > MAX_STEPS) c.add("steps", `has ${raw.length} steps; the limit is ${MAX_STEPS}`);

  const paramNames = new Set(params.map((p) => p.name));
  const earlier: string[] = [];
  const steps: RecipeStep[] = [];

  const checkTemplate = (text: string | undefined, path: string) => {
    if (text === undefined) return;
    let refs: TemplateRef[];
    try {
      refs = templateRefs(text);
    } catch (error) {
      c.add(path, (error as Error).message);
      return;
    }
    for (const ref of refs) {
      if (ref.kind === "param" && !paramNames.has(ref.name)) {
        c.add(path, `"{{${ref.name}}}" is not a declared parameter${paramNames.size ? ` (declared: ${[...paramNames].join(", ")})` : ""}`);
      }
      if (ref.kind === "step" && !earlier.includes(ref.id)) {
        c.add(path, `"{{steps.${ref.id}.output}}" must name an earlier step`);
      }
    }
  };

  raw.slice(0, MAX_STEPS).forEach((item, index) => {
    const path = `steps[${index}]`;
    if (!isObj(item)) {
      c.add(path, `must be a mapping with one of agent, shell or verify, found ${describe(item)}`);
      return;
    }
    const kinds = (["agent", "shell", "verify"] as const).filter((k) => k in item);
    if (kinds.length !== 1) {
      c.add(path, kinds.length ? `has ${kinds.join(" and ")}; a step is exactly one of agent, shell or verify` : "needs one of agent, shell or verify");
      return;
    }
    const kind = kinds[0];
    c.keys(item, path, [...COMMON_STEP_KEYS, kind]);

    let id = `step-${index + 1}`;
    const idRaw = c.str(item, "id", path);
    if (idRaw !== undefined) {
      if (!STEP_ID_RE.test(idRaw)) c.add(`${path}.id`, `invalid step id "${idRaw}" (lowercase letters, digits, - and _, starting with a letter)`);
      else if (RESERVED_IDS.has(idRaw)) c.add(`${path}.id`, `"${idRaw}" is reserved`);
      else id = idRaw;
    }
    if (earlier.includes(id) || steps.some((s) => s.id === id)) c.add(`${path}.id`, `duplicate step id "${id}"`);

    const title = c.str(item, "title", path, { max: 200 });
    checkTemplate(title, `${path}.title`);

    let when: string | undefined;
    const whenRaw = item.when;
    if (whenRaw !== undefined && whenRaw !== null) {
      when = typeof whenRaw === "boolean" ? String(whenRaw) : typeof whenRaw === "string" ? whenRaw.trim() : undefined;
      if (when === undefined) c.add(`${path}.when`, `must be a condition string, found ${describe(whenRaw)}`);
      else {
        try {
          const refs = conditionRefs(parseCondition(when));
          for (const s of refs.steps) {
            if (!earlier.includes(s)) c.add(`${path}.when`, `"${s}" is not an earlier step${earlier.length ? ` (earlier: ${earlier.join(", ")})` : ""}`);
          }
          for (const p of refs.params) {
            if (!paramNames.has(p)) c.add(`${path}.when`, `"params.${p}" is not a declared parameter`);
          }
        } catch (error) {
          c.add(`${path}.when`, error instanceof ExprError ? error.message : String(error));
        }
      }
    }
    const continueOnError = c.bool(item, "continue_on_error", path) ?? false;
    const timeoutSec = c.int(item, "timeout", path, 1, MAX_TIMEOUT_SEC);
    if (kind === "agent" && timeoutSec !== undefined) {
      c.add(`${path}.timeout`, "applies to shell and verify steps; limit an agent step with max_turns");
    }
    const base = {
      id,
      title: title ?? "",
      ...(when !== undefined ? { when } : {}),
      continueOnError,
      ...(timeoutSec !== undefined ? { timeoutSec } : {}),
    };

    if (kind === "agent") {
      const agent = checkAgent(c, item.agent, `${path}.agent`, checkTemplate);
      if (agent) steps.push({ ...base, kind: "agent", ...agent, title: base.title || firstLine(agent.prompt) });
    } else if (kind === "shell") {
      const cmd = item.shell;
      if (typeof cmd !== "string" || !cmd.trim()) {
        c.add(`${path}.shell`, `must be a command string, found ${describe(cmd)}`);
      } else {
        checkTemplate(cmd, `${path}.shell`);
        steps.push({ ...base, kind: "shell", command: cmd.trim(), title: base.title || `$ ${firstLine(cmd)}` });
      }
    } else {
      const verify = checkVerify(c, item.verify, `${path}.verify`, checkTemplate);
      if (verify) {
        steps.push({
          ...base,
          kind: "verify",
          ...verify,
          title: base.title || (verify.command ? `Check: ${firstLine(verify.command)}` : `Run the repository's ${verify.checkKind ?? "checks"}`),
        });
      }
    }
    earlier.push(id);
  });
  return steps;
}

function checkAgent(
  c: Checker,
  raw: YamlValue | undefined,
  path: string,
  checkTemplate: (text: string | undefined, path: string) => void,
): Omit<AgentStep, "kind" | "id" | "title" | "when" | "continueOnError" | "timeoutSec"> | null {
  // Shorthand: `agent: "Do the thing"`.
  const spec: Obj | null = typeof raw === "string" ? { prompt: raw } : isObj(raw) ? raw : null;
  if (!spec) {
    c.add(path, `must be a prompt string or a mapping with prompt, found ${describe(raw)}`);
    return null;
  }
  c.keys(spec, path, ["prompt", "role", "tools", "files", "max_turns"]);
  const prompt = c.str(spec, "prompt", path, { required: true, max: 20_000 });
  checkTemplate(prompt, `${path}.prompt`);
  const roleRaw = c.str(spec, "role", path) ?? "generalist";
  let role: RoleId = "generalist";
  if (!RECIPE_ROLES.includes(roleRaw as RoleId)) {
    c.add(`${path}.role`, `unknown role "${roleRaw}" (one of: ${RECIPE_ROLES.join(", ")})`);
  } else role = roleRaw as RoleId;

  const tools = c.strList(spec, "tools", path);
  if (tools) {
    const allowed = ROLES[role].tools;
    tools.forEach((tool, i) => {
      if (!allowed.includes(tool)) {
        c.add(`${path}.tools[${i}]`, `"${tool}" is not one of the ${role} role's tools (${allowed.join(", ")})`);
      }
    });
    if (!tools.length) c.add(`${path}.tools`, "must list at least one tool (omit it to use the role's tools)");
  }
  const files = c.strList(spec, "files", path) ?? [];
  files.forEach((file, i) => {
    checkTemplate(file, `${path}.files[${i}]`);
    if (file.startsWith("/") || file.split("/").includes("..")) {
      c.add(`${path}.files[${i}]`, `must be a path inside the repository, found "${file}"`);
    }
  });
  const maxTurns = c.int(spec, "max_turns", path, 1, 200);
  if (role === "solver" && (tools || files.length)) {
    c.add(path, "the solver role runs the full solve loop; it does not take tools or files");
  }
  if (prompt === undefined) return null;
  return {
    prompt,
    role,
    ...(tools && tools.length ? { tools } : {}),
    files,
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

function checkVerify(
  c: Checker,
  raw: YamlValue | undefined,
  path: string,
  checkTemplate: (text: string | undefined, path: string) => void,
): Pick<VerifyStep, "command" | "checkKind" | "targets"> | null {
  if (raw === null || raw === undefined || raw === "auto" || raw === true) return { targets: [] };
  if (!isObj(raw)) {
    c.add(path, `must be "auto" or a mapping with command, kind or targets, found ${describe(raw)}`);
    return null;
  }
  c.keys(raw, path, ["command", "kind", "targets"]);
  const command = c.str(raw, "command", path, { max: 4000 });
  checkTemplate(command, `${path}.command`);
  const kindRaw = c.str(raw, "kind", path);
  let checkKind: VerifyStep["checkKind"];
  if (kindRaw !== undefined) {
    if (!(CHECK_KINDS as readonly string[]).includes(kindRaw)) c.add(`${path}.kind`, `must be one of ${CHECK_KINDS.join(", ")}`);
    else checkKind = kindRaw as VerifyStep["checkKind"];
  }
  const targets = c.strList(raw, "targets", path) ?? [];
  targets.forEach((t, i) => checkTemplate(t, `${path}.targets[${i}]`));
  if (command && targets.length) c.add(`${path}.targets`, "targets apply to the auto-detected check; put the files in the command instead");
  return { ...(command?.trim() ? { command: command.trim() } : {}), ...(checkKind ? { checkKind } : {}), targets };
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/* ------------------------------- entry ----------------------------------- */

export function validateRecipe(value: YamlValue, lines: Map<string, number> = new Map()): { recipe?: Recipe; issues: RecipeIssue[] } {
  const c = new Checker(lines);
  if (!isObj(value)) {
    c.add("", `a recipe must be a mapping with name, description, version and steps; found ${describe(value)}`);
    return { issues: c.issues };
  }
  c.keys(value, "", ["name", "description", "version", "author", "params", "steps"]);
  const name = c.str(value, "name", "", { required: true });
  if (name !== undefined && name.trim() && !RECIPE_NAME_RE.test(name)) {
    c.add("name", `invalid name "${name}" (lowercase letters, digits and -, at most 64 characters)`);
  }
  const description = c.str(value, "description", "", { required: true, max: 500 });
  let version: string | undefined;
  const v = value.version;
  if (v === undefined || v === null) c.add("version", "is required (e.g. 1.0.0)");
  else if (typeof v === "number" && Number.isFinite(v) && v >= 0) version = String(v);
  else if (typeof v === "string" && VERSION_RE.test(v.trim())) version = v.trim();
  else c.add("version", `must look like 1, 1.2 or 1.2.3, found ${describe(v)}`);
  const author = c.str(value, "author", "", { max: 200 });
  const params = checkParams(c, value.params);
  const steps = checkSteps(c, value.steps, params);

  if (c.issues.length || !name || !description || !version) return { issues: c.issues };
  return {
    recipe: { name, description: description.trim(), version, ...(author ? { author } : {}), params, steps },
    issues: [],
  };
}

/** Parse and validate recipe source text. YAML errors become issues with their line. */
export function parseRecipe(source: string): { recipe?: Recipe; issues: RecipeIssue[] } {
  try {
    const doc = parseYaml(source);
    return validateRecipe(doc.value, doc.lines);
  } catch (error) {
    if (error instanceof YamlError) {
      return { issues: [{ path: "", message: error.message.replace(/^line \d+: /, ""), line: error.line }] };
    }
    throw error;
  }
}
