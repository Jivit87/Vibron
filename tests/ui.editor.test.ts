import { describe, expect, it } from "vitest";

import {
  closeTabsState,
  cycleTab,
  moveTab,
  openTabState,
  othersOf,
  pinTabState,
  rightOf,
  tabDescriptions,
  type TabLike,
} from "@/lib/editor/tabs";
import { pendingReviews, pathsToRestore, reviewKey, type ChangeLike } from "@/lib/editor/review";

const tab = (path: string, extra: Partial<TabLike> = {}): TabLike => ({ path, label: path.split("/").pop()!, ...extra });
const welcome = tab("__welcome__");

describe("tabs", () => {
  it("opens new tabs to the right of the active one", () => {
    const s = openTabState({ tabs: [tab("a"), tab("b")], activeTabPath: "a" }, tab("c"));
    expect(s.tabs.map((t) => t.path)).toEqual(["a", "c", "b"]);
    expect(s.activeTabPath).toBe("c");
  });

  it("replaces a clean preview tab with the next preview", () => {
    let s = openTabState({ tabs: [tab("a")], activeTabPath: "a" }, tab("p1"), { preview: true });
    s = openTabState(s, tab("p2"), { preview: true });
    expect(s.tabs.map((t) => t.path)).toEqual(["a", "p2"]);
    expect(s.tabs[1].preview).toBe(true);
  });

  it("keeps a dirty preview tab and pins on explicit open", () => {
    let s = { tabs: [tab("a"), tab("p", { preview: true, dirty: true })], activeTabPath: "p" };
    s = openTabState(s, tab("q"), { preview: true });
    expect(s.tabs.map((t) => t.path)).toEqual(["a", "p", "q"]);
    s = openTabState(s, tab("q"));
    expect(s.tabs.find((t) => t.path === "q")!.preview).toBe(false);
    expect(pinTabState(s, "p").tabs.find((t) => t.path === "p")!.preview).toBe(false);
  });

  it("focuses the left neighbour when the active tab closes", () => {
    const s = closeTabsState({ tabs: [tab("a"), tab("b"), tab("c")], activeTabPath: "b" }, ["b"], welcome);
    expect(s.activeTabPath).toBe("a");
    const first = closeTabsState({ tabs: [tab("a"), tab("b")], activeTabPath: "a" }, ["a"], welcome);
    expect(first.activeTabPath).toBe("b");
  });

  it("never leaves the strip empty", () => {
    const s = closeTabsState({ tabs: [tab("a")], activeTabPath: "a" }, ["a"], welcome);
    expect(s.tabs).toEqual([welcome]);
  });

  it("supports close-others, close-right, reorder, cycling, and disambiguation", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(othersOf(tabs, "b")).toEqual(["a", "c"]);
    expect(rightOf(tabs, "a")).toEqual(["b", "c"]);
    expect(moveTab(tabs, 0, 2).map((t) => t.path)).toEqual(["b", "c", "a"]);
    expect(cycleTab(tabs, "c", 1)).toBe("a");
    const d = tabDescriptions([tab("src/x/index.ts"), tab("src/y/index.ts")]);
    expect(d.get("src/x/index.ts")).toBe("x");
  });
});

describe("review", () => {
  const change = (id: string, over: Partial<ChangeLike>): ChangeLike => ({
    id,
    kind: "update",
    path: "a.ts",
    before: "1",
    after: "2",
    adds: 1,
    removes: 1,
    reverted: false,
    ...over,
  });

  it("folds repeated edits into one net review keeping the original base", () => {
    const r = pendingReviews("run", [change("1", {}), change("2", { before: "2", after: "3" })], {});
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ base: "1", current: "3", changeIds: ["1", "2"] });
  });

  it("drops decided, reverted and net no-op files", () => {
    const changes = [
      change("1", {}),
      change("2", { path: "b.ts", reverted: true }),
      change("3", { path: "c.ts", kind: "create", before: null, after: "x" }),
      change("4", { path: "c.ts", kind: "delete", before: "x", after: null }),
    ];
    expect(pendingReviews("run", changes, {}).map((r) => r.path)).toEqual(["a.ts"]);
    expect(pendingReviews("run", [change("1", {})], { [reviewKey("run", "a.ts")]: "accepted" })).toEqual([]);
  });

  it("tracks renames and restores both paths", () => {
    const r = pendingReviews("run", [change("1", { kind: "rename", path: "b.ts", previousPath: "a.ts", before: "1", after: "1" })], {});
    expect(r[0].previousPath).toBe("a.ts");
    expect(pathsToRestore(r[0])).toEqual(["b.ts", "a.ts"]);
  });
});
