/**
 * GitLab and Bitbucket credentials, stored like the provider API keys: in
 * the server-side settings store, never sent to the browser (only a masked
 * fingerprint). The GitHub token stays where it was, in the GitHub MCP
 * integration entry (`resolveGithubToken`).
 *
 * Resolution per platform: saved in Settings → Integrations, else env:
 *   GitLab     GITLAB_TOKEN, instance GITLAB_URL (default https://gitlab.com)
 *   Bitbucket  BITBUCKET_TOKEN (access token), or
 *              BITBUCKET_USERNAME + BITBUCKET_APP_PASSWORD
 */

import type { BitbucketAuth } from "@/lib/git-providers/bitbucket";
import { normalizeBaseUrl, type HostConfig } from "@/lib/git-providers/detect";

export const GITLAB_DEFAULT_URL = "https://gitlab.com";
const GITLAB_KEY = "git-credential:gitlab";
const BITBUCKET_KEY = "git-credential:bitbucket";

export interface StoredGitLab {
  token: string;
  /** Normalized instance web root; gitlab.com when empty. */
  baseUrl?: string;
}

export type StoredBitbucket =
  | { mode: "basic"; username: string; appPassword: string }
  | { mode: "bearer"; token: string };

type StoreModule = typeof import("@/lib/store");
let storePromise: Promise<StoreModule> | null = null;
function store(): Promise<StoreModule> {
  if (!storePromise) storePromise = import("@/lib/store");
  return storePromise;
}

async function read<T>(key: string): Promise<T | null> {
  try {
    const { getValueRaw } = await store();
    return await getValueRaw<T>(key);
  } catch {
    // No store (bare headless run): env only.
    return null;
  }
}

export async function getStoredGitLab(): Promise<StoredGitLab | null> {
  const value = await read<StoredGitLab>(GITLAB_KEY);
  return value && typeof value.token === "string" && value.token ? value : null;
}

export async function setStoredGitLab(value: StoredGitLab | null): Promise<void> {
  const { setValueRaw } = await store();
  await setValueRaw(GITLAB_KEY, value);
}

export async function getStoredBitbucket(): Promise<StoredBitbucket | null> {
  const value = await read<StoredBitbucket>(BITBUCKET_KEY);
  if (value?.mode === "basic" && value.username && value.appPassword) return value;
  if (value?.mode === "bearer" && value.token) return value;
  return null;
}

export async function setStoredBitbucket(value: StoredBitbucket | null): Promise<void> {
  const { setValueRaw } = await store();
  await setValueRaw(BITBUCKET_KEY, value);
}

export interface ResolvedGitLab {
  token: string | null;
  baseUrl: string;
  fromEnv: boolean;
}

export async function resolveGitLab(): Promise<ResolvedGitLab> {
  const stored = await getStoredGitLab();
  if (stored) {
    return { token: stored.token, baseUrl: normalizeBaseUrl(stored.baseUrl ?? "") ?? GITLAB_DEFAULT_URL, fromEnv: false };
  }
  const envUrl = normalizeBaseUrl(process.env.GITLAB_URL ?? "") ?? GITLAB_DEFAULT_URL;
  const token = process.env.GITLAB_TOKEN?.trim() || null;
  return { token, baseUrl: envUrl, fromEnv: Boolean(token) };
}

export async function resolveBitbucket(): Promise<(BitbucketAuth & { fromEnv: boolean }) | null> {
  const stored = await getStoredBitbucket();
  if (stored?.mode === "basic") return { kind: "basic", username: stored.username, password: stored.appPassword, fromEnv: false };
  if (stored?.mode === "bearer") return { kind: "bearer", token: stored.token, fromEnv: false };
  const token = process.env.BITBUCKET_TOKEN?.trim();
  if (token) return { kind: "bearer", token, fromEnv: true };
  const username = process.env.BITBUCKET_USERNAME?.trim();
  const password = process.env.BITBUCKET_APP_PASSWORD?.trim();
  if (username && password) return { kind: "basic", username, password, fromEnv: true };
  return null;
}

/** Hosts detection should recognize: the configured self-hosted GitLab instance. */
export async function loadHostConfig(): Promise<HostConfig> {
  const { baseUrl } = await resolveGitLab();
  return baseUrl === GITLAB_DEFAULT_URL ? {} : { gitlabBaseUrls: [baseUrl] };
}

/** `glpat-…a1b2`: enough to recognise, not enough to use. */
export function maskSecret(secret: string): string {
  if (!secret) return "";
  const prefix = /^(glpat-|gloas-|glptt-|ATBB|ATCTT|ATATT)/.exec(secret)?.[0] ?? "";
  return `${prefix}••••${secret.slice(-4)}`;
}

export interface GitCredentialStatus {
  gitlab: { configured: boolean; masked: string | null; baseUrl: string; fromEnv: boolean };
  bitbucket: { configured: boolean; masked: string | null; mode: "basic" | "bearer" | null; username: string | null; fromEnv: boolean };
}

/** What the settings UI may see: masked fingerprints, never the secrets. */
export async function gitCredentialStatus(): Promise<GitCredentialStatus> {
  const [gitlab, bitbucket] = await Promise.all([resolveGitLab(), resolveBitbucket()]);
  return {
    gitlab: {
      configured: Boolean(gitlab.token),
      masked: gitlab.token ? maskSecret(gitlab.token) : null,
      baseUrl: gitlab.baseUrl,
      fromEnv: gitlab.fromEnv,
    },
    bitbucket: {
      configured: Boolean(bitbucket),
      masked: bitbucket ? maskSecret(bitbucket.kind === "basic" ? bitbucket.password : bitbucket.token) : null,
      mode: bitbucket?.kind ?? null,
      username: bitbucket?.kind === "basic" ? bitbucket.username : null,
      fromEnv: bitbucket?.fromEnv ?? false,
    },
  };
}
