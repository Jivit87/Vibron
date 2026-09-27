/**
 * Docker sandbox for isolated code execution.
 *
 * Inspired by OpenHands (Docker containers) and E2B (Firecracker microVMs).
 * Viberon runs agents against untrusted repositories — a cloned repo could
 * contain malicious Makefiles, postinstall scripts, or test fixtures that
 * execute arbitrary code. This module wraps command execution in a
 * Docker container when sandboxing is enabled.
 *
 * Design:
 *  - The workspace directory is bind-mounted read-write into the container.
 *  - Network access is restricted by default (no egress). When the caller
 *    goes through `prepareProcessEgress` (lib/egress), the network mode is
 *    derived from the egress policy: deny -> `none`; allowlist -> a bridge
 *    network with HTTP(S)_PROXY pointed at the policy-enforcing egress
 *    proxy. Docker cannot filter by hostname on its own, so "restricted"
 *    without that proxy is just a bridge network.
 *  - Resource limits (CPU, memory, PID count) prevent fork bombs and OOM.
 *  - A lightweight base image (node:20-slim + python3 + build essentials)
 *    covers the common case; users can specify a custom image.
 *  - Commands run via `docker exec` on a warm container that persists for
 *    the duration of a solve run, so venv activation and state survive
 *    across tool calls.
 *  - Falls back to direct execution when Docker is unavailable or when
 *    explicitly opted out (desktop IDE with trusted local repos).
 *
 * This is the sandbox backend. It integrates into the terminal module via
 * `SandboxExecutor`, which `startCommand` delegates to when sandbox mode
 * is active.
 */

import { spawn, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { PACKAGE_REGISTRY_HOSTS } from "@/lib/egress/presets";

/* -------------------------------- types ---------------------------------- */

export interface SandboxConfig {
  /** Enable Docker sandboxing. Default: false (direct execution). */
  enabled: boolean;
  /** Docker image to use. Default: "viberon/sandbox:latest". */
  image?: string;
  /** Max memory in MB. Default: 4096. */
  memoryMb?: number;
  /** Max CPU cores. Default: 2. */
  cpus?: number;
  /** Max PIDs (prevents fork bombs). Default: 256. */
  pidsLimit?: number;
  /** Network mode. Default: "none" (no network). */
  network?: "none" | "host" | "bridge" | "restricted";
  /** Allowed egress domains when network is "restricted". */
  allowedDomains?: string[];
  /** Timeout for container startup in ms. Default: 30_000. */
  startupTimeoutMs?: number;
  /** Extra docker run arguments. */
  extraArgs?: string[];
}

export interface SandboxSession {
  containerId: string;
  containerName: string;
  workspaceMount: string;
  status: "starting" | "ready" | "stopped" | "error";
  config: Required<SandboxConfig>;
  createdAt: number;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/* ------------------------------ defaults --------------------------------- */

const DEFAULT_IMAGE = "viberon/sandbox:latest";
const FALLBACK_IMAGE = "node:20-slim";
const DEFAULT_MEMORY_MB = 4096;
const DEFAULT_CPUS = 2;
const DEFAULT_PIDS = 256;
const DEFAULT_STARTUP_TIMEOUT = 30_000;
const CONTAINER_WORKSPACE = "/workspace";

/**
 * Package registry domains allowed when network mode is "restricted". The
 * list is shared with the egress policy's "packageRegistries" preset.
 */
const PACKAGE_REGISTRY_DOMAINS = [...PACKAGE_REGISTRY_HOSTS, "github.com"];

/* ----------------------------- detection --------------------------------- */

let _dockerAvailable: boolean | null = null;

/** Check whether Docker is installed and the daemon is responsive. */
export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/** Reset the Docker availability cache (for testing). */
export function resetDockerCache(): void {
  _dockerAvailable = null;
}

/* ----------------------------- lifecycle --------------------------------- */

const activeSandboxes = new Map<string, SandboxSession>();

function resolveConfig(config: SandboxConfig): Required<SandboxConfig> {
  return {
    enabled: config.enabled,
    image: config.image ?? DEFAULT_IMAGE,
    memoryMb: config.memoryMb ?? DEFAULT_MEMORY_MB,
    cpus: config.cpus ?? DEFAULT_CPUS,
    pidsLimit: config.pidsLimit ?? DEFAULT_PIDS,
    network: config.network ?? "none",
    allowedDomains: config.allowedDomains ?? PACKAGE_REGISTRY_DOMAINS,
    startupTimeoutMs: config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT,
    extraArgs: config.extraArgs ?? [],
  };
}

/**
 * Check whether a Docker image exists locally.
 */
function imageExists(image: string): boolean {
  try {
    execSync(`docker image inspect ${image}`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pull a Docker image if it doesn't exist locally.
 * Returns the image name to use (falls back to FALLBACK_IMAGE on failure).
 */
function ensureImage(image: string): string {
  if (imageExists(image)) return image;
  try {
    execSync(`docker pull ${image}`, { stdio: "ignore", timeout: 120_000 });
    return image;
  } catch {
    // If the custom image can't be pulled, try the fallback.
    if (image !== FALLBACK_IMAGE) {
      if (imageExists(FALLBACK_IMAGE)) return FALLBACK_IMAGE;
      try {
        execSync(`docker pull ${FALLBACK_IMAGE}`, { stdio: "ignore", timeout: 120_000 });
        return FALLBACK_IMAGE;
      } catch {
        throw new Error(
          `Failed to pull Docker image "${image}" and fallback "${FALLBACK_IMAGE}". ` +
          `Ensure Docker is running and has internet access.`
        );
      }
    }
    throw new Error(`Failed to pull Docker image "${image}".`);
  }
}

/**
 * Build the `docker run` command for creating a warm sandbox container.
 */
export function buildRunCommand(
  name: string,
  workspacePath: string,
  config: Required<SandboxConfig>,
): string[] {
  const args = [
    "docker", "run",
    "--detach",
    "--name", name,
    // Resource limits.
    "--memory", `${config.memoryMb}m`,
    "--cpus", String(config.cpus),
    "--pids-limit", String(config.pidsLimit),
    // Security: drop all capabilities, no privilege escalation.
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    // Read-only root filesystem with writable /tmp and /workspace.
    "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=512m",
    // Bind-mount the workspace.
    "--volume", `${path.resolve(workspacePath)}:${CONTAINER_WORKSPACE}:rw`,
    "--workdir", CONTAINER_WORKSPACE,
    // Network.
    "--network", config.network === "restricted" ? "bridge" : config.network,
    // Keep it alive with a long sleep.
    "--entrypoint", "sleep",
  ];

  // User mapping: run as the current user to avoid permission issues.
  if (process.platform !== "win32") {
    try {
      const uid = execSync("id -u", { encoding: "utf8" }).trim();
      const gid = execSync("id -g", { encoding: "utf8" }).trim();
      args.push("--user", `${uid}:${gid}`);
    } catch {
      // Fall back to default user in the container.
    }
  }

  // Linux has no built-in host.docker.internal; the egress proxy is
  // reached through it (Docker Desktop provides it on macOS/Windows).
  if (process.platform === "linux" && config.network !== "none" && config.network !== "host") {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }

  // Extra user-specified arguments.
  args.push(...config.extraArgs);

  // Image and command.
  args.push(config.image, "infinity");

  return args;
}

/**
 * Start a warm sandbox container for a workspace. The container stays
 * alive for the duration of the solve run, and commands are executed
 * via `docker exec`.
 */
export async function startSandbox(
  workspacePath: string,
  config: SandboxConfig,
): Promise<SandboxSession> {
  if (!isDockerAvailable()) {
    throw new Error(
      "Docker is not available. Install Docker Desktop or disable sandbox mode."
    );
  }

  const resolved = resolveConfig(config);
  const name = `viberon-sandbox-${randomUUID().slice(0, 8)}`;

  // Ensure the image is available.
  resolved.image = ensureImage(resolved.image);

  const args = buildRunCommand(name, workspacePath, resolved);

  const session: SandboxSession = {
    containerId: "",
    containerName: name,
    workspaceMount: workspacePath,
    status: "starting",
    config: resolved,
    createdAt: Date.now(),
  };

  try {
    const result = execSync(args.join(" "), {
      encoding: "utf8",
      timeout: resolved.startupTimeoutMs,
    }).trim();
    session.containerId = result.slice(0, 12);
    session.status = "ready";
  } catch (error) {
    session.status = "error";
    throw new Error(
      `Failed to start sandbox container: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  activeSandboxes.set(name, session);
  return session;
}

/**
 * Execute a command inside a running sandbox container.
 * This is the sandboxed equivalent of `child_process.spawn`.
 */
export function execInSandbox(
  session: SandboxSession,
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    if (session.status !== "ready") {
      resolve({ exitCode: 1, stdout: "", stderr: "Sandbox is not ready", timedOut: false });
      return;
    }

    const args = ["docker", "exec"];

    // Working directory inside container.
    const workdir = options.cwd
      ? `${CONTAINER_WORKSPACE}/${path.relative(session.workspaceMount, options.cwd)}`
      : CONTAINER_WORKSPACE;
    args.push("--workdir", workdir);

    // Environment variables.
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("--env", `${key}=${value}`);
      }
    }

    // Standard safety env vars.
    args.push("--env", "FORCE_COLOR=0");
    args.push("--env", "CI=1");
    args.push("--env", "NO_COLOR=1");

    args.push(session.containerName, "/bin/bash", "-c", command);

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    };

    child.on("close", (code) => finish(code));
    child.on("error", () => finish(1));

    // Timeout.
    const timeoutMs = options.timeoutMs ?? 300_000; // 5 min default
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, timeoutMs);
      child.on("close", () => clearTimeout(timer));
    }

    // Abort signal.
    if (options.signal) {
      const onAbort = () => {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      child.on("close", () => options.signal?.removeEventListener("abort", onAbort));
    }
  });
}

/**
 * Spawn a streaming command inside a running sandbox container.
 * Returns the ChildProcess for the terminal module to attach to.
 */
export function spawnInSandbox(
  session: SandboxSession,
  command: string,
  options: {
    cwd?: string;
    env?: Record<string, string>;
  } = {},
): ChildProcess {
  const args = ["exec"];

  const workdir = options.cwd
    ? `${CONTAINER_WORKSPACE}/${path.relative(session.workspaceMount, options.cwd)}`
    : CONTAINER_WORKSPACE;
  args.push("--workdir", workdir);

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push("--env", `${key}=${value}`);
    }
  }

  args.push("--env", "FORCE_COLOR=0");
  args.push("--env", "CI=1");
  args.push("--env", "NO_COLOR=1");

  args.push(session.containerName, "/bin/bash", "-c", command);

  return spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Stop and remove a sandbox container.
 */
export async function stopSandbox(session: SandboxSession): Promise<void> {
  try {
    execSync(`docker rm -f ${session.containerName}`, {
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // Container may already be gone.
  }
  session.status = "stopped";
  activeSandboxes.delete(session.containerName);
}

/**
 * Stop all active sandbox containers. Called on process exit.
 */
export function stopAllSandboxes(): void {
  for (const session of activeSandboxes.values()) {
    try {
      execSync(`docker rm -f ${session.containerName}`, {
        stdio: "ignore",
        timeout: 5_000,
      });
      session.status = "stopped";
    } catch {
      // Best effort cleanup.
    }
  }
  activeSandboxes.clear();
}

/**
 * Get all active sandbox sessions.
 */
export function getActiveSandboxes(): SandboxSession[] {
  return Array.from(activeSandboxes.values());
}

// Clean up on exit.
process.on("exit", stopAllSandboxes);
