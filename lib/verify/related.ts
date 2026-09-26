/**
 * Test files likely to exercise a set of changed files: name conventions
 * (`test_foo.py`, `foo_test.go`, `foo.test.ts`, `FooTest.java`), graph edges
 * from test-file symbols into changed symbols, and test files that mention
 * the changed module by name.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { Graph } from "@/lib/graph";
import { listRepoPaths, TEST_FILE_RE } from "@/lib/verify/detect";

export async function relatedTestFiles(
  root: string,
  changed: string[],
  graph: Graph | null,
  limit = 20,
): Promise<string[]> {
  const testFiles = listRepoPaths(root).filter((f) => TEST_FILE_RE.test(f));
  if (testFiles.length === 0 || changed.length === 0) return [];
  const scores = new Map<string, number>();
  const bump = (file: string, by: number) => scores.set(file, (scores.get(file) ?? 0) + by);

  const stems = new Map<string, string>();
  for (const file of changed) {
    const stem = path.posix.basename(file).replace(/\.[^.]+$/, "");
    if (stem && stem !== "index" && stem !== "__init__") stems.set(stem.toLowerCase(), file);
  }
  for (const test of testFiles) {
    if (changed.includes(test)) bump(test, 10);
    const base = path.posix.basename(test).replace(/\.[^.]+$/, "").toLowerCase();
    const core = base
      .replace(/^test_/, "")
      .replace(/_test$/, "")
      .replace(/\.(test|spec)$/, "")
      .replace(/tests?$/, "");
    if (stems.has(core)) bump(test, 5);
  }

  if (graph) {
    const changedSet = new Set(changed);
    const nodeFile = new Map(graph.nodes.map((n) => [n.id, n.file] as const));
    const testSet = new Set(testFiles);
    for (const edge of graph.edges) {
      const from = nodeFile.get(edge.source);
      const to = nodeFile.get(edge.target);
      if (from && to && testSet.has(from) && changedSet.has(to)) bump(from, 3);
    }
  }

  // Textual mention of the module (import lines), bounded to keep this cheap.
  if (stems.size) {
    const pattern = new RegExp(`\\b(${[...stems.keys()].map((s) => s.replace(/[^\w]/g, "\\$&")).join("|")})\\b`, "i");
    for (const test of testFiles.slice(0, 2000)) {
      try {
        const head = readFileSync(path.join(root, test), "utf8").slice(0, 4000);
        if (pattern.test(head)) bump(test, 1);
      } catch {
        // Unreadable: skip.
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file]) => file);
}
