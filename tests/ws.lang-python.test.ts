import { describe, expect, it } from "vitest";

import { parseRepo } from "@/lib/parser";

const merge = `"""Merge helpers."""
import copy


def deep_merge(base, override):
    """Merge override into base.

    def not_a_function(): pass
    """
    out = dict(base)
    for key, value in override.items():
        if isinstance(value, dict):
            out[key] = deep_merge(out.get(key, {}), value)
        else:
            out[key] = value
    return out


class Merger:
    def __init__(
        self,
        strategy="deep",
    ):
        self.strategy = strategy

    def merge(self, a, b):
        return self._apply(a, b)

    def _apply(self, a, b):
        return deep_merge(a, b)


async def fetch_layers():
    return []
`;

const loader = `from .merge import deep_merge, Merger
from . import merge as merge_mod


def load_layers(layers):
    result = {}
    for layer in layers:
        result = deep_merge(result, layer)
    merge_mod.fetch_layers()
    return result
`;

describe("python extraction", () => {
  const { graph } = parseRepo([
    { path: "layercfg/__init__.py", source: "from .loader import load_layers\n" },
    { path: "layercfg/merge.py", source: merge },
    { path: "layercfg/loader.py", source: loader },
  ]);
  const byName = (name: string) => graph.nodes.find((n) => n.name === name)!;

  it("finds functions, classes, methods with line ranges; ignores docstring text", () => {
    const names = graph.nodes.filter((n) => n.file === "layercfg/merge.py").map((n) => n.name);
    expect(names).toEqual(["deep_merge", "Merger", "__init__", "merge", "_apply", "fetch_layers"]);
    const deep = byName("deep_merge");
    expect(deep.startLine).toBe(5);
    expect(deep.endLine).toBe(16);
    expect(byName("Merger").kind).toBe("class");
    expect(byName("Merger").endLine).toBe(30);
    expect(byName("__init__").endLine).toBe(24);
    expect(byName("__init__").signature).toContain("strategy");
    expect(byName("fetch_layers").startLine).toBe(33);
  });

  it("links calls within a file and across relative imports", () => {
    const edge = (from: string, to: string, kind: string) =>
      graph.edges.some(
        (e) => e.source === byName(from).id && e.target === byName(to).id && e.kind === kind,
      );
    expect(edge("_apply", "deep_merge", "call")).toBe(true);
    expect(edge("merge", "_apply", "call")).toBe(true);
    expect(edge("load_layers", "deep_merge", "call")).toBe(true);
    expect(edge("load_layers", "fetch_layers", "call")).toBe(true);
    expect(edge("load_layers", "Merger", "import")).toBe(true);
  });
});
