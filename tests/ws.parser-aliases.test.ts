import { describe, expect, it } from "vitest";

import { aliasCandidates, loadPathAliases, stripJsonComments } from "@/lib/lang/tsconfig";
import { parseRepo, resolveImport } from "@/lib/parser";

function importEdgeFiles(files: { path: string; source: string }[]) {
  const { graph } = parseRepo(files);
  const fileOf = new Map(graph.nodes.map((n) => [n.id, n.file]));
  return [
    ...new Set(
      graph.edges
        .filter((e) => e.kind === "import")
        .map((e) => `${fileOf.get(e.source)}->${fileOf.get(e.target)}`),
    ),
  ].sort();
}

describe("path aliases", () => {
  it("creates import edges for @/ aliases from tsconfig paths (JSONC)", () => {
    const files = [
      {
        path: "tsconfig.json",
        source: `{
          // comment
          "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*"], "#ui": ["components/ui/index.ts"], }, },
        }`,
      },
      { path: "lib/util.ts", source: "export function helper() { return 1; }" },
      { path: "components/ui/index.ts", source: "export function Button() { return null; }" },
      {
        path: "app/page.ts",
        source: `import { helper } from "@/lib/util";\nimport { Button } from "#ui";\nexport function Page() { helper(); return Button(); }`,
      },
    ];
    expect(importEdgeFiles(files)).toEqual([
      "app/page.ts->components/ui/index.ts",
      "app/page.ts->lib/util.ts",
    ]);
  });

  it("follows extends and nearest config in a monorepo", () => {
    const files = [
      { path: "tsconfig.base.json", source: `{"compilerOptions":{"paths":{"@shared/*":["packages/shared/src/*"]}}}` },
      { path: "tsconfig.json", source: `{"extends":"./tsconfig.base.json"}` },
      { path: "packages/web/tsconfig.json", source: `{"compilerOptions":{"baseUrl":"src"}}` },
      { path: "packages/shared/src/math.ts", source: "export function add() {}" },
      { path: "packages/web/src/lib/x.ts", source: "export function x() {}" },
    ];
    const aliases = loadPathAliases(files);
    const known = new Set(files.map((f) => f.path));
    expect(resolveImport("app.ts", "@shared/math", known, aliases)).toBe("packages/shared/src/math.ts");
    expect(resolveImport("packages/web/src/a.ts", "lib/x", known, aliases)).toBe("packages/web/src/lib/x.ts");
    expect(aliasCandidates("app.ts", "react", aliases)).toEqual([]);
  });

  it("falls back to @/ conventions without any config, and maps .js to .ts", () => {
    const known = new Set(["src/lib/a.ts", "lib/b.tsx", "util/c.ts"]);
    expect(resolveImport("src/x.ts", "@/lib/a", known)).toBe("src/lib/a.ts");
    expect(resolveImport("x.ts", "~/lib/b", known)).toBe("lib/b.tsx");
    expect(resolveImport("util/x.ts", "./c.js", known)).toBe("util/c.ts");
    expect(resolveImport("x.ts", "react", known)).toBeNull();
  });

  it("strips comments without touching strings", () => {
    expect(JSON.parse(stripJsonComments(`{"a":"http://x", /* c */ "b":[1,],}`))).toEqual({ a: "http://x", b: [1] });
  });
});
