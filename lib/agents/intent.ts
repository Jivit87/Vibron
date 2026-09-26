/**
 * Intent routing.
 *
 * Not every prompt is a build request. "How does auth work?" should get an
 * answer, not a task DAG and a squad of agents with write access. Treating
 * questions as builds is the single biggest cause of the tool feeling like
 * it is not listening.
 *
 * This is a fast, conservative heuristic that runs before any model call:
 *
 *   "ask"   — answer from the code. Read-only tools, prose reply.
 *   "build" — change the workspace. Full agent/orchestrator path.
 *   null    — genuinely ambiguous; let the orchestrator decide, since it
 *             can see the repo and has both options available.
 *
 * Deliberately biased toward returning `null` over guessing wrong: a bad
 * "ask" classification silently refuses to do requested work, which is far
 * more annoying than an unnecessary planning turn.
 */

export type Intent = "ask" | "build";

/** Verbs that mean "change the workspace". */
const BUILD_VERBS = [
  "add",
  "build",
  "change",
  "clean\\s*up",
  "configure",
  "convert",
  "create",
  "delete",
  "deploy",
  "extract",
  "fix",
  "generate",
  "implement",
  "improve",
  "init",
  "initialise",
  "initialize",
  "install",
  "integrate",
  "make",
  "migrate",
  "modify",
  "move",
  "optimise",
  "optimize",
  "port",
  "refactor",
  "remove",
  "rename",
  "replace",
  "rewrite",
  "scaffold",
  "set\\s*up",
  "setup",
  "simplify",
  "update",
  "upgrade",
  "wire",
  "write",
];

/** Openers that mean "explain something to me". */
const ASK_OPENERS = [
  "what",
  "why",
  "how",
  "when",
  "where",
  "who",
  "which",
  "whose",
  "is",
  "are",
  "was",
  "were",
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "will",
  "explain",
  "describe",
  "summarise",
  "summarize",
  "tell\\s+me",
  "show\\s+me",
  "walk\\s+me",
  "help\\s+me\\s+understand",
  "give\\s+me\\s+an?\\s+overview",
  "list",
  "find",
  "locate",
  "search",
  "look\\s+up",
  "review",
  "analyse",
  "analyze",
  "compare",
  "any\\s+idea",
  "do\\s+you",
];

const BUILD_RE = new RegExp(`\\b(${BUILD_VERBS.join("|")})\\b`, "i");
const ASK_OPENER_RE = new RegExp(`^\\s*(${ASK_OPENERS.join("|")})\\b`, "i");

/**
 * Interrogatives that ask *about* doing something rather than asking for it
 * to be done: "how do I add a route?", "where should I put the config?".
 * These want instructions, so a build verb inside them is not an order.
 */
const INSTRUCTIONAL_RE =
  /^\s*(?:how\s+(?:do|would|should|can|could)\s+(?:i|we)\b|how\s+to\b|where\s+(?:do|should|would)\s+(?:i|we)\b|what'?s?\s+the\s+(?:best\s+)?way\s+to\b|should\s+(?:i|we)\b|is\s+it\s+(?:possible|worth|better)\b)/i;

/**
 * Politeness wrappers around an imperative: "can you add X", "please fix Y",
 * "could you refactor Z". These read as questions but are requests, and
 * treating them as questions is the worst failure mode — the tool answers
 * instead of doing the work it was plainly asked to do.
 */
const POLITE_REQUEST_RE =
  /^\s*(?:please\b|(?:can|could|would|will)\s+(?:you|u)\b|(?:i'?d?\s+like|i\s+want|i\s+need)\b|let'?s\b|go\s+ahead\b)/i;

/** Small talk that deserves a reply, never a build. */
const CHITCHAT = new Set([
  "hi",
  "hii",
  "hello",
  "hey",
  "yo",
  "sup",
  "thanks",
  "thank you",
  "ty",
  "thx",
  "ok",
  "okay",
  "k",
  "cool",
  "nice",
  "great",
  "good",
  "lol",
  "test",
  "testing",
  "ping",
  "?",
]);

export function isChitchat(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase().replace(/[!.?,;:]+$/, "");
  if (!normalized) return true;
  return CHITCHAT.has(normalized);
}

/**
 * Classify a prompt. Returns null when genuinely ambiguous so the caller can
 * fall back to letting a model decide with full repo context.
 */
export function guessIntent(prompt: string): Intent | null {
  const text = prompt.trim();
  if (!text) return null;
  if (isChitchat(text)) return "ask";

  const hasBuildVerb = BUILD_RE.test(text);
  const opensAsQuestion = ASK_OPENER_RE.test(text);
  const endsWithQuestionMark = /\?\s*$/.test(text);

  // "Can you add X?" / "please fix Y" — phrased as a question, meant as an
  // order. Checked before the interrogative rules, which would otherwise
  // swallow it and leave the user's request undone.
  if (POLITE_REQUEST_RE.test(text) && hasBuildVerb) return "build";

  // "How do I add a route?" — wants instructions, not the change.
  if (INSTRUCTIONAL_RE.test(text)) return "ask";

  // An imperative build verb with no question framing is a build request.
  if (hasBuildVerb && !opensAsQuestion && !endsWithQuestionMark) return "build";

  // Question framing with no build verb anywhere is a question.
  if ((opensAsQuestion || endsWithQuestionMark) && !hasBuildVerb) return "ask";

  // Both signals present in an unfamiliar shape. Too risky to guess — the
  // orchestrator can see the repo and has `answer_directly` available.
  return null;
}
