/**
 * Web browsing capability for agents.
 *
 * Inspired by OpenHands (BrowseURLAction) and Cline's browser integration.
 * When solving a task, agents often need to look up:
 *  - API documentation
 *  - Library changelogs and migration guides
 *  - Stack Overflow answers
 *  - GitHub issue discussions
 *  - Package registry pages (npm, PyPI)
 *
 * Without this, agents either hallucinate API signatures or ask the user
 * to look things up. This module provides a `browse` tool that fetches
 * a URL, extracts the main content (HTML → markdown), and returns it
 * within a token budget.
 *
 * Design:
 *  - Uses Node.js `fetch` (no browser dependency) for speed and
 *    compatibility with sandboxed/headless environments.
 *  - Converts HTML to a compact markdown representation, stripping
 *    navigation, scripts, styles, ads, and boilerplate.
 *  - Supports a search fallback: if the agent doesn't have a URL, it
 *    can search with a query string and get back relevant snippets.
 *  - Token-budgeted: the output is capped at a configurable size
 *    (default 4000 tokens ≈ 16KB) to avoid blowing context.
 *  - Safe: every fetch goes through the egress policy (lib/egress):
 *    the host is checked before the request, redirects are followed by
 *    hand and re-checked hop by hop, and private / loopback / link-local /
 *    cloud-metadata addresses are refused unless a rule names them
 *    (SSRF guard). Never sends credentials or cookies.
 *
 * Tool definitions at the bottom of this file are registered in the
 * tool registry alongside the existing tools.
 */

import { egressFetch, type EgressFetchResult, type Lookup } from "@/lib/egress/fetch";
import type { EffectiveEgressPolicy } from "@/lib/egress/policy";

/* -------------------------------- types ---------------------------------- */

export interface BrowseResult {
  url: string;
  title: string;
  content: string;
  /** Truncated content length indicator. */
  truncated: boolean;
  /** HTTP status code. */
  status: number;
  /** Error message if the fetch failed. */
  error?: string;
  /** True when the egress policy refused a hop. */
  blocked?: boolean;
  /** Every URL requested, in order (redirects included), without queries. */
  hops?: string[];
}

/** Egress context for a fetch. Omitted fields fall back to the global policy. */
export interface BrowseEgress {
  policy?: EffectiveEgressPolicy;
  repoKey?: string;
  rootPath?: string | null;
  /** DNS seam for tests. */
  lookup?: Lookup;
  /** fetch seam for tests; default is the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface BrowseOptions {
  /** Maximum output size in characters. Default: 16_000 (~4k tokens). */
  maxChars?: number;
  /** Timeout in ms. Default: 15_000. */
  timeoutMs?: number;
  /** Extract only the main content area (skip nav, footer, etc.). */
  mainContentOnly?: boolean;
  /**
   * Extra narrowing on top of the egress policy: only these domains (and
   * their subdomains). Null/undefined = whatever the policy allows.
   */
  allowedDomains?: string[] | null;
  egress?: BrowseEgress;
}

async function policyFor(egress: BrowseEgress | undefined): Promise<EffectiveEgressPolicy> {
  if (egress?.policy) return egress.policy;
  const { loadEffectivePolicy } = await import("@/lib/egress/settings");
  return loadEffectivePolicy(egress?.repoKey ?? "");
}

async function guardedFetch(
  url: string,
  init: RequestInit,
  egress: BrowseEgress | undefined,
): Promise<EgressFetchResult> {
  return egressFetch(url, init, {
    policy: await policyFor(egress),
    source: "browse",
    repoKey: egress?.repoKey,
    rootPath: egress?.rootPath ?? null,
    lookup: egress?.lookup,
    fetchImpl: egress?.fetchImpl,
  });
}

/* ------------------------------ constants -------------------------------- */

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_TIMEOUT = 15_000;

/** User agent string for requests. */
const USER_AGENT =
  "Viberon/1.0 (AI Coding Agent; +https://github.com/Nishant25code/Vibron)";

/**
 * Domains commonly needed for software development research.
 * Used as the default allowlist when in restricted mode.
 */
export const DEV_DOMAINS = [
  // Documentation
  "developer.mozilla.org",
  "docs.python.org",
  "docs.rs",
  "pkg.go.dev",
  "typescriptlang.org",
  "nodejs.org",
  "reactjs.org",
  "react.dev",
  "nextjs.org",
  "vuejs.org",
  "angular.io",
  "svelte.dev",
  // Registries
  "npmjs.com",
  "www.npmjs.com",
  "pypi.org",
  "crates.io",
  "rubygems.org",
  "packagist.org",
  // Q&A and community
  "stackoverflow.com",
  "github.com",
  "gist.github.com",
  "raw.githubusercontent.com",
  // Tutorials and references
  "css-tricks.com",
  "web.dev",
  "medium.com",
  "dev.to",
  "learn.microsoft.com",
  "docs.oracle.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "wikipedia.org",
  "en.wikipedia.org",
];

/* ------------------------------ HTML → markdown -------------------------- */

/**
 * Strip HTML tags and convert to a readable plain text / markdown format.
 * This is a lightweight extractor — no dependency on cheerio or jsdom.
 */
function htmlToMarkdown(html: string): { title: string; content: string } {
  let title = "";

  // Extract title.
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = decodeEntities(titleMatch[1].trim());
  }

  // Remove scripts, styles, SVGs, and comments.
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Remove nav, header, footer, aside (navigation boilerplate).
  text = text
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "");

  // Try to find the main content area.
  const mainMatch = text.match(
    /<(?:main|article|div\s[^>]*class="[^"]*(?:content|article|post|entry|main)[^"]*")[^>]*>([\s\S]*?)<\/(?:main|article|div)>/i,
  );
  if (mainMatch) {
    text = mainMatch[1];
  }

  // Convert common elements to markdown.
  text = text
    // Headings.
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    // Code blocks.
    .replace(/<pre[^>]*><code[^>]*class="[^"]*language-(\w+)[^"]*"[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```$1\n$2\n```\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, "\n```\n$1\n```\n")
    // Inline code.
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    // Bold and italic.
    .replace(/<(?:b|strong)[^>]*>([\s\S]*?)<\/(?:b|strong)>/gi, "**$1**")
    .replace(/<(?:i|em)[^>]*>([\s\S]*?)<\/(?:i|em)>/gi, "*$1*")
    // Links.
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    // Lists.
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?[ou]l[^>]*>/gi, "\n")
    // Paragraphs and line breaks.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div[^>]*>/gi, "")
    // Tables (simplified).
    .replace(/<\/tr>/gi, "|\n")
    .replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "| $1 ")
    // Remove all remaining tags.
    .replace(/<[^>]+>/g, "");

  // Decode HTML entities.
  text = decodeEntities(text);

  // Clean up whitespace.
  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/^ +/gm, "")
    .trim();

  return { title, content: text };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

/* ------------------------------ fetching --------------------------------- */

/**
 * Fetch a URL and convert its content to a compact markdown representation.
 */
export async function browseUrl(
  url: string,
  options: BrowseOptions = {},
): Promise<BrowseResult> {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;

  // Validate URL.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      url,
      title: "",
      content: "",
      truncated: false,
      status: 0,
      error: `Invalid URL: ${url}`,
    };
  }

  // Domain allowlist check.
  if (options.allowedDomains) {
    const hostname = parsed.hostname.replace(/^www\./, "");
    const allowed = options.allowedDomains.some(
      (d) => hostname === d || hostname === `www.${d}` || hostname.endsWith(`.${d}`),
    );
    if (!allowed) {
      return {
        url,
        title: "",
        content: "",
        truncated: false,
        status: 0,
        error: `Domain "${parsed.hostname}" is not in the allowed list. Allowed: ${options.allowedDomains.slice(0, 5).join(", ")}…`,
      };
    }
  }

  // Fetch, re-checking the egress policy on every redirect hop.
  let response: Response;
  let hops: string[] = [];
  let finalUrl = url;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let fetched: EgressFetchResult;
    try {
      fetched = await guardedFetch(
        url,
        {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "text/html, application/json, text/plain, */*",
          },
          signal: controller.signal,
        },
        options.egress,
      );
    } finally {
      clearTimeout(timeout);
    }
    hops = fetched.hops;
    if (fetched.ok === false) {
      return {
        url,
        title: "",
        content: "",
        truncated: false,
        status: 0,
        blocked: true,
        hops,
        error: `Blocked by the network egress policy: ${fetched.blocked.reason}${
          hops.length > 1 ? ` (after redirects: ${hops.join(" → ")})` : ""
        }`,
      };
    }
    response = fetched.response;
    finalUrl = fetched.finalUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      url,
      title: "",
      content: "",
      truncated: false,
      status: 0,
      error: `Fetch failed: ${message}`,
    };
  }

  if (!response.ok) {
    return {
      url: finalUrl,
      hops,
      title: "",
      content: "",
      truncated: false,
      status: response.status,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  }

  const contentType = response.headers.get("content-type") ?? "";
  let body: string;
  try {
    body = await response.text();
  } catch (error) {
    return {
      url,
      title: "",
      content: "",
      truncated: false,
      status: response.status,
      error: `Failed to read response body: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  // JSON responses: pretty-print.
  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(body);
      const pretty = JSON.stringify(json, null, 2);
      const truncated = pretty.length > maxChars;
      return {
        url: finalUrl,
        hops,
        title: parsed.pathname,
        content: truncated ? pretty.slice(0, maxChars) + "\n[…truncated]" : pretty,
        truncated,
        status: response.status,
      };
    } catch {
      // Fall through to text handling.
    }
  }

  // Plain text responses.
  if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
    const truncated = body.length > maxChars;
    return {
      url: finalUrl,
      hops,
      title: parsed.pathname,
      content: truncated ? body.slice(0, maxChars) + "\n[…truncated]" : body,
      truncated,
      status: response.status,
    };
  }

  // HTML: convert to markdown.
  const { title, content } = htmlToMarkdown(body);
  const truncated = content.length > maxChars;
  return {
    url: finalUrl,
    hops,
    title: title || parsed.hostname + parsed.pathname,
    content: truncated ? content.slice(0, maxChars) + "\n[…truncated]" : content,
    truncated,
    status: response.status,
  };
}

/**
 * Search the web using a DuckDuckGo HTML search (no API key needed).
 * Returns a summary of the top results with URLs for the agent to
 * follow up with `browse`.
 */
export async function searchWeb(
  query: string,
  options: { maxResults?: number; timeoutMs?: number; egress?: BrowseEgress } = {},
): Promise<string> {
  const maxResults = options.maxResults ?? 5;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const encodedQuery = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;

  let response: Response;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let fetched: EgressFetchResult;
    try {
      fetched = await guardedFetch(
        url,
        { headers: { "User-Agent": USER_AGENT, Accept: "text/html" }, signal: controller.signal },
        options.egress,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (fetched.ok === false) {
      return `Search blocked by the network egress policy: ${fetched.blocked.reason}`;
    }
    response = fetched.response;
  } catch (error) {
    return `Search failed: ${error instanceof Error ? error.message : String(error)}`;
  }

  if (!response.ok) {
    return `Search failed: HTTP ${response.status}`;
  }

  const html = await response.text();

  // Extract search results from DuckDuckGo HTML.
  const results: { title: string; url: string; snippet: string }[] = [];
  const resultPattern =
    /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  let match;
  while ((match = resultPattern.exec(html)) !== null && results.length < maxResults) {
    const rawUrl = match[1];
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, "").trim());
    const snippet = decodeEntities(match[3].replace(/<[^>]+>/g, "").trim());

    // DuckDuckGo wraps URLs in a redirect; extract the real URL.
    let cleanUrl = rawUrl;
    try {
      const parsed = new URL(rawUrl, "https://duckduckgo.com");
      cleanUrl = parsed.searchParams.get("uddg") || rawUrl;
    } catch {
      // Use as-is.
    }

    if (title && cleanUrl) {
      results.push({ title, url: cleanUrl, snippet });
    }
  }

  if (results.length === 0) {
    return `No results found for: ${query}`;
  }

  const lines = [`Search results for: "${query}"\n`];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`${i + 1}. **${r.title}**`);
    lines.push(`   URL: ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  }
  lines.push("Use the `browse` tool with a URL above to read the full page.");

  return lines.join("\n");
}

/* ------------------------------ tool defs -------------------------------- */

/**
 * Tool definition for the `browse` tool.
 * Register this in the tool registry.
 */
export const BROWSE_TOOL_DEF = {
  name: "browse",
  description:
    "Fetch a web page and return its content as markdown. Use this to read documentation, API references, library changelogs, Stack Overflow answers, or GitHub discussions. Returns the main content, stripped of navigation and ads. For searching, use `web_search` first to find relevant URLs.",
  input_schema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string" as const,
        description: "The full URL to fetch (must start with http:// or https://).",
      },
    },
    required: ["url"],
  },
};

/**
 * Tool definition for the `web_search` tool.
 * Register this in the tool registry.
 */
export const WEB_SEARCH_TOOL_DEF = {
  name: "web_search",
  description:
    "Search the web for documentation, API references, error messages, or technical topics. Returns a list of relevant results with URLs. Follow up with `browse` to read the full content of a result.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description: "The search query. Be specific: include the library name, version, and the specific topic.",
      },
    },
    required: ["query"],
  },
};
