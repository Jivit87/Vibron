/**
 * Network intent in shell commands, checked against the egress policy.
 *
 * BEST EFFORT, BY DESIGN. This reads the command *string*: it recognises
 * the common ways a command reaches the network (curl/wget, git
 * clone/fetch/pull/push, package installs, ssh/scp/rsync, nc, docker pull)
 * and maps them to hosts. It cannot see what a script, a Makefile, a
 * postinstall hook or `python -c` does once it runs. The Docker sandbox
 * (and the egress proxy it is pointed at) is the real boundary for
 * arbitrary processes; this check exists so the obvious cases get a clear
 * refusal or an approval prompt *before* anything runs, and land in the
 * audit log.
 *
 * Outcome per command: "allow" (no change to the normal safety verdict),
 * "ask" (force a human approval, even under the Auto command policy), or
 * "block" (refuse).
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { parseShell } from "@/lib/terminal/safety";

import { appendAudit } from "./audit";
import { formatTarget, normalizeHost, parseHostPort, targetFromUrl } from "./host";
import { classifyIp, parseIp } from "./ip";
import { evaluateHost, type EffectiveEgressPolicy, type EgressDecision, type EgressSource } from "./policy";

export interface NetworkIntent {
  /** What reaches out, e.g. `curl`, `git push`, `npm install`. */
  tool: string;
  /** Normalized host, or null when it cannot be determined from the text. */
  host: string | null;
  port: number | null;
  /** The argument the host came from (or why it is unknown). */
  detail: string;
}

export interface IntentOptions {
  /** Resolve a git remote name (`origin`) to its URL. */
  gitRemoteUrl?: (name: string) => string | null;
}

/* ------------------------------ target parsing ---------------------------- */

const NETWORK_SCHEMES = new Set([
  "http", "https", "ftp", "ftps", "ws", "wss", "ssh", "git", "sftp", "scp", "rsync", "telnet",
]);

type Where = { host: string; port: number | null } | "local" | null;

/** `git+https://…` → `https://…`; `github:user/repo` → github.com. */
function hostFromSpec(spec: string, fallbackScheme: string | null): Where {
  const text = spec.trim().replace(/^git\+/, "");
  if (!text || text.includes("$") || text.includes("`")) return null;
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === "file") return "local";
    if (!NETWORK_SCHEMES.has(scheme)) return null;
    const target = targetFromUrl(text);
    return target ? { host: target.host, port: target.port } : null;
  }
  const shorthand = text.match(/^(github|gitlab|bitbucket):/i)?.[1]?.toLowerCase();
  if (shorthand) return { host: shorthand === "bitbucket" ? "bitbucket.org" : `${shorthand}.com`, port: 443 };
  if (fallbackScheme) {
    const target = targetFromUrl(`${fallbackScheme}://${text}`);
    return target ? { host: target.host, port: target.port } : null;
  }
  return null;
}

/** `user@host:path` (scp-like, used by git and scp). Not `C:\…`, not `./a:b`. */
function scpLike(arg: string): Where {
  const m = arg.match(/^(?:[^@/\s]+@)?(\[[^\]]+\]|[^:/\s]+):(?!\/\/)/);
  if (!m || /^[a-z]$/i.test(m[1]) || arg.startsWith(".") || arg.startsWith("/")) return null;
  const host = normalizeHost(m[1]);
  return host ? { host, port: 22 } : null;
}

function gitRemote(arg: string): Where {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return hostFromSpec(arg, null);
  const scp = scpLike(arg);
  if (scp) return scp;
  // A path (or a bundle file) — local.
  if (arg.startsWith(".") || arg.startsWith("/") || arg.startsWith("~") || existsLocal(arg)) return "local";
  return null;
}

function existsLocal(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}

/* ---------------------------- per-tool analysis --------------------------- */

const WRAPPERS = /^(env|command|exec|nice|nohup|time|timeout|stdbuf|xargs|caffeinate)$/;

function base(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/** Drop `env FOO=1 nice -n 5 …` down to the real command and its args. */
function unwrap(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const b = base(w);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (WRAPPERS.test(b)) {
      i++;
      // Wrapper options and `timeout 30`.
      while (i < words.length && (words[i].startsWith("-") || /^\d+[smhd]?$/.test(words[i]))) i++;
      continue;
    }
    break;
  }
  return words.slice(i);
}

/** Positional args, skipping flags and the values of flags that take one. */
function positionals(args: string[], valueFlags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      if (!a.includes("=") && valueFlags.has(a)) i++;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      // `-o file` or `-ofile`: only the bare form consumes the next word.
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** Value of `--flag value` / `--flag=value` / `-f value`. All occurrences. */
function flagValues(args: string[], names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    for (const name of names) {
      if (a === name && i + 1 < args.length) out.push(args[i + 1]);
      else if (name.startsWith("--") && a.startsWith(`${name}=`)) out.push(a.slice(name.length + 1));
    }
  }
  return out;
}

const CURL_VALUE_FLAGS = new Set([
  "-o", "--output", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-X", "--request", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie",
  "-c", "--cookie-jar", "-F", "--form", "-T", "--upload-file", "-w", "--write-out", "-x", "--proxy",
  "-K", "--config", "-m", "--max-time", "--connect-timeout", "--retry", "-r", "--range", "-E", "--cert",
  "--key", "--cacert", "--resolve", "--connect-to", "--url", "-U", "--proxy-user", "-z", "--time-cond",
  "--limit-rate", "-Y", "-y", "--interface", "--dns-servers", "-D", "--dump-header", "--output-dir",
]);
const WGET_VALUE_FLAGS = new Set([
  "-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix",
  "-U", "--user-agent", "--header", "-t", "--tries", "-T", "--timeout", "--user", "--password",
  "--post-data", "--post-file", "-e", "--execute", "-i", "--input-file", "--referer", "-B", "--base",
  "--load-cookies", "--save-cookies", "-Q", "--quota", "-w", "--wait", "-l", "--level",
]);

function httpClient(tool: string, args: string[]): NetworkIntent[] {
  const flags = tool === "wget" ? WGET_VALUE_FLAGS : CURL_VALUE_FLAGS;
  const urls = [...positionals(args, flags), ...flagValues(args, ["--url"])];
  const proxies = tool === "curl" ? flagValues(args, ["-x", "--proxy"]) : [];
  const out: NetworkIntent[] = [];
  let sawLocal = false;
  for (const u of [...urls, ...proxies]) {
    const where = hostFromSpec(u, "http");
    if (where === "local") {
      sawLocal = true;
      continue;
    }
    out.push(where ? { tool, ...where, detail: u } : { tool, host: null, port: null, detail: u });
  }
  if (out.length === 0 && !sawLocal && !args.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-V")) {
    out.push({ tool, host: null, port: null, detail: "no URL in the command text" });
  }
  return out;
}

const GIT_GLOBAL_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
const GIT_CLONE_VALUE = new Set([
  "-b", "--branch", "-o", "--origin", "--depth", "--reference", "--reference-if-able", "-c", "--config",
  "--template", "--separate-git-dir", "-j", "--jobs", "--filter", "--shallow-since", "--shallow-exclude",
  "-u", "--upload-pack", "--server-option", "--bundle-uri",
]);
const GIT_REMOTE_VALUE = new Set(["--depth", "-j", "--jobs", "--upload-pack", "--receive-pack", "--exec", "-o", "--push-option", "--server-option", "--shallow-since", "--shallow-exclude", "--deepen", "--negotiation-tip", "--refmap", "--recurse-submodules-default"]);

function git(args: string[], options: IntentOptions): NetworkIntent[] {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    i += GIT_GLOBAL_VALUE.has(args[i]) ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  const tool = `git ${sub}`;
  if (sub === "clone") {
    const [repo] = positionals(rest, GIT_CLONE_VALUE);
    if (!repo) return [];
    const where = gitRemote(repo);
    if (where === "local") return [];
    return [where ? { tool, ...where, detail: repo } : { tool, host: null, port: null, detail: repo }];
  }
  if (sub === "fetch" || sub === "pull" || sub === "push" || sub === "ls-remote") {
    if (rest.includes("--all") || rest.includes("--multiple")) {
      return [{ tool, host: null, port: null, detail: "all remotes" }];
    }
    const [first] = positionals(rest, GIT_REMOTE_VALUE);
    const remote = first ?? "origin";
    let where = gitRemote(remote);
    if (where === null && /^[\w.-]+$/.test(remote)) {
      const url = options.gitRemoteUrl?.(remote) ?? null;
      if (url) where = gitRemote(url);
      if (where === "local") return [];
      return [where ? { tool, ...where, detail: `${remote} → ${url}` } : { tool, host: null, port: null, detail: `remote "${remote}"` }];
    }
    if (where === "local") return [];
    return [where ? { tool, ...where, detail: remote } : { tool, host: null, port: null, detail: remote }];
  }
  if (sub === "submodule" && rest.includes("update")) {
    return [{ tool: "git submodule update", host: null, port: null, detail: "hosts from .gitmodules" }];
  }
  return [];
}

const NPM_NETWORK = new Set([
  "install", "i", "ci", "add", "update", "up", "upgrade", "publish", "audit", "outdated", "view", "info",
  "show", "dlx", "create", "exec", "x", "search", "unpublish", "dist-tag", "login", "whoami",
]);

function registryIntents(tool: string, defaultHosts: string[], args: string[], registryFlags: string[]): NetworkIntent[] {
  const custom = flagValues(args, registryFlags);
  const out: NetworkIntent[] = [];
  if (custom.length) {
    for (const u of custom) {
      const where = hostFromSpec(u, "https");
      if (where === "local") continue;
      out.push(where ? { tool, ...where, detail: u } : { tool, host: null, port: null, detail: u });
    }
  } else {
    for (const host of defaultHosts) out.push({ tool, host, port: 443, detail: "default registry" });
  }
  // Direct URL / git dependencies named on the command line.
  for (const a of args) {
    if (a.startsWith("-")) continue;
    if (/^(git\+)?[a-z][a-z0-9+.-]*:\/\//i.test(a) || /^(github|gitlab|bitbucket):/i.test(a)) {
      const where = hostFromSpec(a, null);
      if (where && where !== "local" && !out.some((o) => o.host === where.host && o.port === where.port)) {
        out.push({ tool, ...where, detail: a });
      }
    }
  }
  return out;
}

const NPM_HOSTS = ["registry.npmjs.org"];
const YARN_HOSTS = ["registry.yarnpkg.com"];
const PYPI_HOSTS = ["pypi.org", "files.pythonhosted.org"];
const CRATES_HOSTS = ["index.crates.io", "static.crates.io"];
const GO_HOSTS = ["proxy.golang.org", "sum.golang.org"];
const RUBY_HOSTS = ["rubygems.org"];

function jsPackageManager(cmd: string, args: string[]): NetworkIntent[] {
  if (cmd === "npx" || cmd === "bunx" || cmd === "pnpx") {
    return registryIntents(cmd, NPM_HOSTS, args, ["--registry"]);
  }
  const sub = args.find((a) => !a.startsWith("-"));
  const bareYarn = cmd === "yarn" && sub === undefined;
  if (!bareYarn && (!sub || !NPM_NETWORK.has(sub))) return [];
  const tool = `${cmd} ${sub ?? "install"}`;
  return registryIntents(tool, cmd === "yarn" ? YARN_HOSTS : NPM_HOSTS, args, ["--registry"]);
}

const PIP_NETWORK = new Set(["install", "download", "index", "search", "wheel"]);
const PIP_INDEX_FLAGS = ["-i", "--index-url", "--extra-index-url", "-f", "--find-links"];

function pip(tool: string, args: string[]): NetworkIntent[] {
  const sub = args.find((a) => !a.startsWith("-"));
  if (!sub || !PIP_NETWORK.has(sub)) return [];
  const intents = registryIntents(`${tool} ${sub}`, PYPI_HOSTS, args, PIP_INDEX_FLAGS);
  // --extra-index-url adds to PyPI rather than replacing it.
  if (flagValues(args, ["-i", "--index-url"]).length === 0 && flagValues(args, ["--extra-index-url", "-f", "--find-links"]).length) {
    for (const host of PYPI_HOSTS) intents.push({ tool: `${tool} ${sub}`, host, port: 443, detail: "default registry" });
  }
  return intents;
}

function docker(args: string[]): NetworkIntent[] {
  const sub = args.find((a) => !a.startsWith("-"));
  if (sub !== "pull" && sub !== "push" && sub !== "login") return [];
  const rest = positionals(args.slice(args.indexOf(sub) + 1), new Set(["--platform", "-u", "--username", "-p", "--password"]));
  const ref = rest[0];
  if (sub === "login") {
    const where = ref ? hostFromSpec(ref, "https") : null;
    return [where && where !== "local" ? { tool: "docker login", ...where, detail: ref } : { tool: "docker login", host: "index.docker.io", port: 443, detail: ref ?? "Docker Hub" }];
  }
  if (!ref) return [];
  const first = ref.split("/")[0];
  const hasRegistry = ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost");
  if (hasRegistry) {
    const hp = parseHostPort(first);
    if (hp) return [{ tool: `docker ${sub}`, host: hp.host, port: hp.port ?? 443, detail: ref }];
  }
  return [{ tool: `docker ${sub}`, host: "registry-1.docker.io", port: 443, detail: ref }];
}

const SSH_VALUE_FLAGS = new Set([
  "-p", "-i", "-l", "-o", "-F", "-J", "-L", "-R", "-D", "-b", "-c", "-e", "-m", "-O", "-Q", "-S", "-W", "-w", "-E", "-B", "-I",
]);

function ssh(tool: string, args: string[]): NetworkIntent[] {
  const [target] = positionals(args, SSH_VALUE_FLAGS);
  const port = Number(flagValues(args, ["-p"])[0]) || 22;
  const out: NetworkIntent[] = [];
  for (const jump of flagValues(args, ["-J"])) {
    const hp = parseHostPort(jump.replace(/^[^@]*@/, ""));
    out.push(hp ? { tool, host: hp.host, port: hp.port ?? 22, detail: jump } : { tool, host: null, port: null, detail: jump });
  }
  if (!target) return out;
  if (target.startsWith("ssh://")) {
    const where = hostFromSpec(target, null);
    out.push(where && where !== "local" ? { tool, ...where, detail: target } : { tool, host: null, port: null, detail: target });
    return out;
  }
  const host = normalizeHost(target.replace(/^[^@]*@/, ""));
  out.push(host ? { tool, host, port, detail: target } : { tool, host: null, port: null, detail: target });
  return out;
}

function copyTool(tool: string, args: string[]): NetworkIntent[] {
  const out: NetworkIntent[] = [];
  const port = tool === "scp" ? Number(flagValues(args, ["-P"])[0]) || 22 : 22;
  for (const a of positionals(args, new Set(["-P", "-i", "-o", "-F", "-e", "--rsh", "-J", "-l", "-c", "-S"]))) {
    if (/^rsync:\/\//i.test(a)) {
      const where = hostFromSpec(a, null);
      if (where && where !== "local") out.push({ tool, ...where, detail: a });
      continue;
    }
    const daemon = a.match(/^(?:[^@/\s]+@)?([^:/\s]+)::/);
    if (daemon) {
      const host = normalizeHost(daemon[1]);
      out.push(host ? { tool, host, port: 873, detail: a } : { tool, host: null, port: null, detail: a });
      continue;
    }
    const scp = scpLike(a);
    if (scp && scp !== "local") out.push({ tool, host: scp.host, port, detail: a });
  }
  return out;
}

function rawSocket(tool: string, args: string[]): NetworkIntent[] {
  if (args.some((a) => /^-[a-zA-Z]*l/.test(a) || a === "--listen")) return [];
  const pos = positionals(args, new Set(["-p", "-s", "-w", "-i", "-e", "-c", "-x", "-X", "-q"]));
  if (!pos[0]) return [];
  const host = normalizeHost(pos[0]);
  const port = Number(pos[1]) || (tool === "telnet" ? 23 : null);
  return [host ? { tool, host, port, detail: pos.join(" ") } : { tool, host: null, port: null, detail: pos[0] }];
}

function segmentIntents(words: string[], options: IntentOptions, depth: number): NetworkIntent[] {
  const unwrapped = unwrap(words);
  if (unwrapped.length === 0) return [];
  const cmd = base(unwrapped[0]);
  const args = unwrapped.slice(1);

  // `bash -c "curl …"`: look inside, once or twice.
  if (/^(ba|z|da|k|fi)?sh$/.test(cmd) && depth < 3) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
    if (c !== -1 && args[c + 1]) return findNetworkIntents(args[c + 1], options, depth + 1);
    return [];
  }

  switch (cmd) {
    case "curl":
    case "wget":
    case "http":
    case "https":
    case "xh":
    case "aria2c":
      return httpClient(cmd === "wget" ? "wget" : cmd, args);
    case "git":
      return git(args, options);
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "npx":
    case "bunx":
    case "pnpx":
      return jsPackageManager(cmd, args);
    case "pip":
    case "pip3":
      return pip(cmd, args);
    case "python":
    case "python3": {
      const m = args.findIndex((a) => a === "-m");
      if (m !== -1 && (args[m + 1] === "pip" || args[m + 1] === "pip3")) return pip("pip", args.slice(m + 2));
      return [];
    }
    case "uv": {
      if (args[0] === "pip") return pip("uv pip", args.slice(1));
      if (["add", "sync", "lock", "tool"].includes(args[0] ?? "")) return registryIntents(`uv ${args[0]}`, PYPI_HOSTS, args, ["--index-url", "--default-index", "--index"]);
      return [];
    }
    case "poetry":
    case "pipx":
      return ["install", "add", "update", "lock", "run"].includes(args[0] ?? "")
        ? registryIntents(`${cmd} ${args[0]}`, PYPI_HOSTS, args, [])
        : [];
    case "cargo":
      return ["install", "add", "fetch", "update", "search", "publish", "generate-lockfile"].includes(args[0] ?? "")
        ? registryIntents(`cargo ${args[0]}`, CRATES_HOSTS, args, ["--index", "--registry"])
        : [];
    case "go":
      return args[0] === "get" || args[0] === "install" || (args[0] === "mod" && ["download", "tidy"].includes(args[1] ?? ""))
        ? GO_HOSTS.map((host) => ({ tool: `go ${args[0]}`, host, port: 443, detail: "module proxy" }))
        : [];
    case "gem":
      return ["install", "update", "fetch", "push"].includes(args[0] ?? "")
        ? registryIntents(`gem ${args[0]}`, RUBY_HOSTS, args, ["--source", "-s"])
        : [];
    case "bundle":
      return args[0] === undefined || ["install", "update"].includes(args[0])
        ? RUBY_HOSTS.map((host) => ({ tool: `bundle ${args[0] ?? "install"}`, host, port: 443, detail: "default registry" }))
        : [];
    case "composer":
      return ["install", "require", "update", "create-project"].includes(args[0] ?? "")
        ? [{ tool: `composer ${args[0]}`, host: "repo.packagist.org", port: 443, detail: "default registry" }]
        : [];
    case "docker":
    case "podman":
      return docker(args);
    case "ssh":
    case "mosh":
      return ssh(cmd, args);
    case "scp":
    case "rsync":
    case "sftp":
      return cmd === "sftp" ? ssh(cmd, args) : copyTool(cmd, args);
    case "nc":
    case "ncat":
    case "netcat":
    case "telnet":
    case "socat":
      return cmd === "socat" ? socat(args) : rawSocket(cmd, args);
    case "ftp":
      return rawSocket(cmd, args);
    default:
      return [];
  }
}

function socat(args: string[]): NetworkIntent[] {
  const out: NetworkIntent[] = [];
  for (const a of args) {
    const m = a.match(/^(?:tcp|tcp4|tcp6|udp|udp4|udp6|openssl|ssl)(?:-connect)?:(.+):(\d+)/i);
    if (m && !/listen/i.test(a)) {
      const host = normalizeHost(m[1]);
      out.push(host ? { tool: "socat", host, port: Number(m[2]), detail: a } : { tool: "socat", host: null, port: null, detail: a });
    }
  }
  return out;
}

/** Every network destination the command text names (or implies). */
export function findNetworkIntents(command: string, options: IntentOptions = {}, depth = 0): NetworkIntent[] {
  const parsed = parseShell(command);
  const out: NetworkIntent[] = [];
  for (const segment of parsed.segments) {
    out.push(...segmentIntents(segment.words, options, depth));
  }
  return out;
}

/* --------------------------------- deciding -------------------------------- */

export type CommandEgressAction = "allow" | "ask" | "block";

export interface CommandEgressFinding {
  intent: NetworkIntent;
  action: CommandEgressAction;
  /** Null for unknown hosts and local targets. */
  decision: EgressDecision | null;
  rule: string;
  reason: string;
}

export interface CommandEgressVerdict {
  action: CommandEgressAction;
  findings: CommandEgressFinding[];
  /** One line for a refusal or an approval prompt; null when allowed. */
  reason: string | null;
}

function isLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  const ip = parseIp(host);
  return Boolean(ip && classifyIp(ip) === "loopback");
}

const RANK: Record<CommandEgressAction, number> = { allow: 0, ask: 1, block: 2 };

export function evaluateCommandEgress(
  command: string,
  policy: EffectiveEgressPolicy,
  options: IntentOptions & { source?: EgressSource } = {},
): CommandEgressVerdict {
  const source = options.source ?? "terminal";
  const intents = findNetworkIntents(command, options);
  const findings: CommandEgressFinding[] = [];
  const offPolicy: CommandEgressAction = policy.offPolicyCommands === "block" ? "block" : "ask";

  for (const intent of intents) {
    if (intent.host === null) {
      const action: CommandEgressAction = policy.mode === "open" ? "allow" : policy.mode === "deny" ? "block" : offPolicy;
      findings.push({
        intent,
        action,
        decision: null,
        rule: policy.mode === "open" ? "mode:open" : `unknown-host (mode:${policy.mode})`,
        reason: `${intent.tool} reaches the network, but the host cannot be determined from the command (${intent.detail})`,
      });
      continue;
    }
    if (isLocalHost(intent.host)) {
      findings.push({ intent, action: "allow", decision: null, rule: "local", reason: `${intent.host} is this machine` });
      continue;
    }
    const decision = evaluateHost(policy, intent.host, intent.port, source);
    let action: CommandEgressAction = "allow";
    if (!decision.allowed) {
      action = decision.rule === "mode:allowlist" ? offPolicy : "block";
    }
    findings.push({ intent, action, decision, rule: decision.rule, reason: `${intent.tool}: ${decision.reason}` });
  }

  let action: CommandEgressAction = "allow";
  for (const f of findings) if (RANK[f.action] > RANK[action]) action = f.action;
  const worst = findings.filter((f) => f.action === action && action !== "allow");
  return {
    action,
    findings,
    reason: worst.length ? worst.map((f) => f.reason).join("; ") : null,
  };
}

/** Log every finding of a command verdict. `final` overrides per-finding actions (e.g. a user approval). */
export async function auditCommandEgress(
  verdict: CommandEgressVerdict,
  context: { rootPath?: string | null; repoKey?: string; command: string; source?: EgressSource; approved?: boolean },
): Promise<void> {
  for (const f of verdict.findings) {
    const decision = f.action === "block" ? "deny" : f.action === "ask" ? (context.approved === undefined ? "ask" : context.approved ? "allow" : "deny") : "allow";
    await appendAudit(context.rootPath, {
      host: f.intent.host ?? "(unknown)",
      port: f.intent.port,
      decision,
      source: context.source ?? "terminal",
      rule: f.action === "ask" && context.approved !== undefined ? `${f.rule} → ${context.approved ? "approved" : "declined"} by user` : f.rule,
      reason: f.reason,
      command: context.command,
      repoKey: context.repoKey || undefined,
    });
  }
}

export function describeFinding(f: CommandEgressFinding): string {
  return f.intent.host ? `${f.intent.tool} → ${formatTarget(f.intent.host, f.intent.port)}` : `${f.intent.tool} → (unknown host)`;
}

/* ------------------------------ git remotes -------------------------------- */

function gitConfigPath(rootPath: string): string | null {
  const dotGit = path.join(rootPath, ".git");
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return path.join(dotGit, "config");
    // Worktree / submodule: `.git` is a file pointing at the real git dir.
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return null;
    const gitDir = path.resolve(rootPath, pointer);
    const common = path.join(gitDir, "commondir");
    const commonDir = existsSync(common) ? path.resolve(gitDir, readFileSync(common, "utf8").trim()) : gitDir;
    return path.join(commonDir, "config");
  } catch {
    return null;
  }
}

/** Resolver for `git push origin` → the remote's URL, from `.git/config`. */
export function gitRemoteResolver(rootPath: string | null | undefined): (name: string) => string | null {
  return (name) => {
    if (!rootPath) return null;
    const file = gitConfigPath(rootPath);
    if (!file) return null;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let inRemote = false;
    for (const line of text.split(/\r?\n/)) {
      const section = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
      if (section) {
        inRemote = section[1] === name;
        continue;
      }
      if (/^\s*\[/.test(line)) {
        inRemote = false;
        continue;
      }
      if (inRemote) {
        const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1];
        if (url) return url.replace(/^"|"$/g, "");
      }
    }
    return null;
  };
}
