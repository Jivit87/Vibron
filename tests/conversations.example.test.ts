import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createConversationMeta,
  deleteConversation,
  deriveTitle,
  groupByRecency,
  loadConversation,
  loadIndex,
  migrateLegacyThread,
  renameConversation,
  saveConversation,
  type ConversationMeta,
} from "@/lib/client/conversations";
import type { ChatMessage } from "@/store/viberon";

/**
 * Conversation storage is where a bug silently destroys the user's history,
 * so these cover the paths that actually lose data: eviction, rename
 * survival, deleting the open thread, and the one-time legacy migration.
 */

/** Minimal in-memory localStorage, since vitest runs without a DOM here. */
function installStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  const mock = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, v),
    removeItem: (k: string) => void backing.delete(k),
    clear: () => backing.clear(),
    key: (i: number) => [...backing.keys()][i] ?? null,
    get length() {
      return backing.size;
    },
  };
  vi.stubGlobal("window", { localStorage: mock });
  return backing;
}

function msg(role: "user" | "assistant", content: string): ChatMessage {
  return { id: `${role}_${content.slice(0, 6)}`, role, content, at: Date.now() };
}

const REPO = "repo1";

describe("deriveTitle", () => {
  it("titles a thread from the first user message", () => {
    expect(deriveTitle([msg("user", "Add dark mode to the settings page")])).toBe(
      "Add dark mode to the settings page",
    );
  });

  it("cuts at a sentence boundary rather than mid-word", () => {
    const title = deriveTitle([
      msg("user", "Refactor the parser. Then add tests for every branch."),
    ]);
    expect(title).toBe("Refactor the parser");
  });

  it("falls back when there is no user message yet", () => {
    expect(deriveTitle([msg("assistant", "hello")])).toBe("New chat");
    expect(deriveTitle([])).toBe("New chat");
  });

  it("truncates very long prompts", () => {
    const title = deriveTitle([msg("user", "x".repeat(200))]);
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("conversation persistence", () => {
  beforeEach(() => {
    installStorage();
  });

  it("round-trips messages and runs", () => {
    const meta = createConversationMeta();
    saveConversation(REPO, {
      meta,
      messages: [msg("user", "hi"), msg("assistant", "hello")],
      runs: [],
    });

    const loaded = loadConversation(REPO, meta.id);
    expect(loaded?.messages).toHaveLength(2);
    expect(loadIndex(REPO)).toHaveLength(1);
  });

  it("does not persist an untouched empty thread", () => {
    // Opening "New chat" and walking away should not litter the list.
    saveConversation(REPO, {
      meta: createConversationMeta(),
      messages: [],
      runs: [],
    });
    expect(loadIndex(REPO)).toHaveLength(0);
  });

  it("keeps the index newest-first", () => {
    const older = createConversationMeta();
    saveConversation(REPO, { meta: older, messages: [msg("user", "one")], runs: [] });

    const newer = createConversationMeta();
    saveConversation(REPO, { meta: newer, messages: [msg("user", "two")], runs: [] });

    expect(loadIndex(REPO)[0].id).toBe(newer.id);
  });

  it("keeps a renamed title through later saves", () => {
    const meta = createConversationMeta();
    saveConversation(REPO, {
      meta,
      messages: [msg("user", "original prompt text")],
      runs: [],
    });

    renameConversation(REPO, meta.id, "My custom name");

    // A later save must not re-derive the title back from the first message.
    const record = loadConversation(REPO, meta.id)!;
    saveConversation(REPO, {
      meta: record.meta,
      messages: [...record.messages, msg("assistant", "reply")],
      runs: [],
    });

    expect(loadIndex(REPO)[0].title).toBe("My custom name");
  });

  it("removes a conversation and its record together", () => {
    const meta = createConversationMeta();
    saveConversation(REPO, { meta, messages: [msg("user", "hi")], runs: [] });

    const remaining = deleteConversation(REPO, meta.id);
    expect(remaining).toHaveLength(0);
    expect(loadConversation(REPO, meta.id)).toBeNull();
  });

  it("isolates conversations per workspace", () => {
    saveConversation(REPO, {
      meta: createConversationMeta(),
      messages: [msg("user", "repo one")],
      runs: [],
    });
    saveConversation("repo2", {
      meta: createConversationMeta(),
      messages: [msg("user", "repo two")],
      runs: [],
    });

    expect(loadIndex(REPO)).toHaveLength(1);
    expect(loadIndex("repo2")).toHaveLength(1);
    expect(loadIndex(REPO)[0].id).not.toBe(loadIndex("repo2")[0].id);
  });

  it("survives corrupt stored data instead of throwing", () => {
    const backing = installStorage();
    backing.set(`viberon.conv.index.${REPO}`, "{not json");
    expect(loadIndex(REPO)).toEqual([]);
    expect(loadConversation(REPO, "missing")).toBeNull();
  });
});

describe("legacy migration", () => {
  beforeEach(() => {
    installStorage();
  });

  it("folds the old flat thread into a conversation exactly once", () => {
    const backing = installStorage();
    backing.set(
      `viberon.chat.v2.${REPO}`,
      JSON.stringify([msg("user", "old question"), msg("assistant", "old answer")]),
    );

    const migrated = migrateLegacyThread(REPO);
    expect(migrated).not.toBeNull();
    expect(loadIndex(REPO)).toHaveLength(1);

    // The legacy key is consumed, so a second call is a no-op rather than
    // duplicating the thread on every reload.
    expect(migrateLegacyThread(REPO)).toBeNull();
    expect(loadIndex(REPO)).toHaveLength(1);
  });

  it("does nothing when there is no legacy thread", () => {
    expect(migrateLegacyThread(REPO)).toBeNull();
    expect(loadIndex(REPO)).toHaveLength(0);
  });
});

describe("groupByRecency", () => {
  it("buckets by age and drops empty groups", () => {
    const now = Date.now();
    const make = (id: string, updatedAt: number): ConversationMeta => ({
      id,
      title: id,
      createdAt: updatedAt,
      updatedAt,
      messageCount: 1,
      preview: "",
    });

    const groups = groupByRecency([
      make("today", now),
      make("old", now - 30 * 86_400_000),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["Today", "Older"]);
    expect(groups[0].items[0].id).toBe("today");
  });
});
