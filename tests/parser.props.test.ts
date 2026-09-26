import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { nodeId } from "@/lib/ids";
import { parseRepo } from "@/lib/parser";

const identifier = fc.constantFrom("alpha", "beta", "gamma", "delta", "epsilon", "zeta");

describe("parser properties", () => {
  it("Feature: viberon, Property 1: Edge endpoints reference existing nodes", () => {
    fc.assert(
      fc.property(identifier, (name) => {
        const result = parseRepo(
          [
            { path: "src/main.ts", source: `import { ${name} } from "./dep";\nexport function main() {\n  return ${name}();\n}` },
            { path: "src/dep.ts", source: `export function ${name}() {\n  return 1;\n}` },
          ],
          "owner/repo@main",
        );

        const ids = new Set(result.graph.nodes.map((node) => node.id));
        for (const edge of result.graph.edges) {
          expect(ids.has(edge.source)).toBe(true);
          expect(ids.has(edge.target)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("Feature: viberon, Property 2: Node IDs are stable across runs", () => {
    fc.assert(
      fc.property(fc.uniqueArray(identifier, { minLength: 1, maxLength: 5 }), (names) => {
        const source = names.map((name) => `export function ${name}() {\n  return "${name}";\n}`).join("\n\n");
        const files = [{ path: "src/stable.ts", source }];
        const first = parseRepo(files, "owner/repo@main").graph.nodes;
        const second = parseRepo(files, "owner/repo@main").graph.nodes;

        expect(first.map((node) => node.id).sort()).toEqual(second.map((node) => node.id).sort());
        for (const node of first) {
          expect(node.id).toBe(nodeId(node.file, node.name, node.startLine));
        }
      }),
      { numRuns: 100 },
    );
  });
});


describe("parser resilience", () => {
  /**
   * Regression: Babel's `traverse` throws on scope-level errors even when
   * `parse` succeeded with error recovery. That used to propagate out of
   * `parseRepo` and take down workspace registration, file saves, and agent
   * writes — one malformed file made the whole workspace unusable.
   */
  it("Feature: viberon, Property 8: One unparseable file never fails the run", () => {
    const result = parseRepo(
      [
        { path: "broken.ts", source: "const x = 1;\nconst x = 2;\n" },
        { path: "fine.ts", source: "export function ok() {\n  return 1;\n}\n" },
      ],
      "owner/repo@main",
    );

    expect(result.graph.nodes.map((n) => n.name)).toEqual(["ok"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken.ts");
  });

  it("survives a file that is not valid source at all", () => {
    const result = parseRepo(
      [
        { path: "garbage.ts", source: "<<<<<<< HEAD\nnot code at all ][}{\n" },
        { path: "fine.ts", source: "export function ok() { return 1; }\n" },
      ],
      "owner/repo@main",
    );

    expect(result.graph.nodes.map((n) => n.name)).toContain("ok");
  });
});
