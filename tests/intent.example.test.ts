import { describe, expect, it } from "vitest";

import { guessIntent, isChitchat } from "@/lib/agents/intent";
import { ensureSubstantiveSummary } from "@/lib/agents/orchestrator";

/**
 * Intent routing decides whether a prompt gets an answer or a build. Getting
 * it wrong is the difference between "explain the auth flow" returning a
 * walkthrough and it dispatching agents that rewrite auth.
 *
 * The classifier is deliberately allowed to return `null` ("unsure") — those
 * prompts reach the orchestrator, which can still choose to answer. What it
 * must never do is confidently pick the wrong branch.
 */

describe("guessIntent", () => {
  const questions = [
    "what does this codebase do?",
    "how does the auth flow work",
    "where is the router defined?",
    "explain the graph engine",
    "walk me through the orchestrator",
    "why is the terminal slow?",
    "can you describe the file structure",
    "list the API routes",
    "which file owns the token ledger?",
    "show me how retrieval works",
  ];

  it.each(questions)("routes %j to an answer", (prompt) => {
    expect(guessIntent(prompt)).toBe("ask");
  });

  const builds = [
    "add dark mode with a toggle",
    "fix the duplicate meta tag bug",
    "build a task manager app",
    "refactor the parser into modules",
    "install tailwind and set it up",
    "rename createShell to makeShell",
    "write tests for the ledger",
    "delete the unused chat route",
  ];

  it.each(builds)("routes %j to a build", (prompt) => {
    expect(guessIntent(prompt)).toBe("build");
  });

  it("treats a question *about* building as a question", () => {
    // The build verb is present, but the framing is interrogative — the user
    // wants to know how, not for it to be done.
    expect(guessIntent("how do I add a new route?")).toBe("ask");
    expect(guessIntent("where should I create the config file?")).toBe("ask");
    expect(guessIntent("should I refactor this?")).toBe("ask");
  });

  it("answers small talk instead of building something", () => {
    for (const greeting of ["hi", "hello", "thanks", "ok", "yo"]) {
      expect(guessIntent(greeting)).toBe("ask");
      expect(isChitchat(greeting)).toBe(true);
    }
  });

  it("treats a politely-phrased order as a build, not a question", () => {
    // The worst failure mode: answering instead of doing the work that was
    // plainly requested, just because it ended in a question mark.
    expect(guessIntent("can you add a dark mode toggle?")).toBe("build");
    expect(guessIntent("could you fix the parser bug?")).toBe("build");
    expect(guessIntent("please write tests for the ledger")).toBe("build");
    expect(guessIntent("I'd like you to refactor the store")).toBe("build");
  });

  it("still distinguishes asking how from asking for it", () => {
    expect(guessIntent("how do I add a dark mode toggle?")).toBe("ask");
    expect(guessIntent("can you add a dark mode toggle?")).toBe("build");
  });

  it("defers to the model when the prompt is genuinely ambiguous", () => {
    // A build verb inside question framing that matches no known shape.
    expect(guessIntent("is the parser refactor done?")).toBeNull();
  });

  it("handles empty and whitespace input without throwing", () => {
    expect(guessIntent("")).toBeNull();
    expect(guessIntent("   ")).toBeNull();
  });

  it("does not mistake a substring for a build verb", () => {
    // "addendum" contains "add"; word boundaries must prevent a false match.
    expect(guessIntent("what is the addendum section about?")).toBe("ask");
  });
});

describe("ensureSubstantiveSummary", () => {
  /**
   * Regression: a model that ends its loop after one exploratory tool call
   * used to produce an empty chat bubble — no changes, no text, no error.
   * That reads as the app being broken, so a run must always say something.
   */
  it("never returns an empty reply", () => {
    for (const empty of ["", "   ", "No summary returned."]) {
      const out = ensureSubstantiveSummary(empty, 0, "build");
      expect(out.length).toBeGreaterThan(40);
      expect(out).toMatch(/stopped before making any changes/i);
      // It must tell the user what to do next, not just that it failed.
      expect(out).toMatch(/Settings|narrow|retrieval/i);
    }
  });

  it("words the fallback for a question differently than a build", () => {
    expect(ensureSubstantiveSummary("", 0, "ask")).toMatch(/could not produce an answer/i);
    expect(ensureSubstantiveSummary("", 0, "build")).toMatch(/stopped before making/i);
  });

  it("flags files changed without an explanation", () => {
    const out = ensureSubstantiveSummary("", 3, "build");
    expect(out).toMatch(/Changed 3 files/);
    expect(out).toMatch(/Review the diffs/i);
  });

  it("passes a real summary through untouched", () => {
    const real = "Added a header comment to script.js explaining the game loop.";
    expect(ensureSubstantiveSummary(real, 1, "build")).toBe(real);
  });

  it("preserves an explicit failure message", () => {
    const failure = "Failed: provider rejected the request as too large.";
    expect(ensureSubstantiveSummary(failure, 0, "build")).toBe(failure);
  });
});
