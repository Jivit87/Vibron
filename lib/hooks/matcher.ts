/**
 * Tool-name matchers.
 *
 *   absent, "" or "*"        every tool
 *   "edit_file"              exactly that tool
 *   "edit_file|write_file"   any of the listed names (exact, no regex)
 *   anything else            a regular expression, anchored at both ends:
 *                            "mcp__github__.*" matches every GitHub MCP tool,
 *                            "view" never matches "preview"
 *
 * An invalid regex is a config error and never matches, so a typo cannot
 * silently turn a guard hook into a hook for every tool.
 */

const PLAIN_LIST = /^[A-Za-z0-9_.-]+(\|[A-Za-z0-9_.-]+)*$/;

export interface CompiledMatcher {
  test(toolName: string): boolean;
  /** Set when the pattern is not a valid regular expression. */
  error?: string;
}

export function compileMatcher(matcher: string | undefined): CompiledMatcher {
  const pattern = (matcher ?? "").trim();
  if (!pattern || pattern === "*") return { test: () => true };
  // Dots are legal in names but also regex syntax; a plain list with dots
  // is still matched literally (tool names never need "any character").
  if (PLAIN_LIST.test(pattern)) {
    const names = new Set(pattern.split("|"));
    return { test: (name) => names.has(name) };
  }
  try {
    const regex = new RegExp(`^(?:${pattern})$`);
    return { test: (name) => regex.test(name) };
  } catch (error) {
    return {
      test: () => false,
      error: `invalid matcher "${pattern}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function matchesTool(matcher: string | undefined, toolName: string): boolean {
  return compileMatcher(matcher).test(toolName);
}
