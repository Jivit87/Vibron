import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MAX_YAML_BYTES, parseYaml, YamlError } from "@/lib/recipes/yaml";

const value = (src: string) => parseYaml(src).value;

function errorOf(src: string): YamlError {
  try {
    parseYaml(src);
  } catch (error) {
    if (error instanceof YamlError) return error;
    throw error;
  }
  throw new Error("expected a YamlError");
}

describe("parseYaml: supported subset", () => {
  it("parses nested mappings and sequences, including compact items and same-indent lists", () => {
    const src = [
      "name: demo",
      "nested:",
      "  inner:",
      "    deep: 1",
      "list:",
      "  - a",
      "  - key: v",
      "    other: 2",
      "  -",
      "    - x",
      "  - - y",
      "    - z",
      "flat:",
      "- one",
      "- two",
      "",
    ].join("\n");
    expect(value(src)).toEqual({
      name: "demo",
      nested: { inner: { deep: 1 } },
      list: ["a", { key: "v", other: 2 }, ["x"], ["y", "z"]],
      flat: ["one", "two"],
    });
  });

  it("resolves plain scalars like the YAML 1.2 core schema", () => {
    expect(
      value("a: ~\nb: null\nc:\nd: true\ne: False\nf: 42\ng: -3.5\nh: 1e3\ni: yes\nj: 1.0.0\nk: 007x\nl: .5\n"),
    ).toEqual({ a: null, b: null, c: null, d: true, e: false, f: 42, g: -3.5, h: 1000, i: "yes", j: "1.0.0", k: "007x", l: 0.5 });
  });

  it("handles single and double quotes, escapes, and # inside quotes", () => {
    expect(
      value(
        [
          `a: 'it''s # not a comment'  # a comment`,
          `b: "tab\\tnew\\nline \\"q\\" \\u00e9 \\x41 \\\\"`,
          `c: "true"`,
          `d: '42'`,
          `"quoted key": 1`,
          `'single key': 2`,
          `e: plain with 'quotes' and "more"`,
          `f: http://example.com/a#frag`,
          `g: value # trailing comment`,
        ].join("\n"),
      ),
    ).toEqual({
      a: "it's # not a comment",
      b: 'tab\tnew\nline "q" é A \\',
      c: "true",
      d: "42",
      "quoted key": 1,
      "single key": 2,
      e: `plain with 'quotes' and "more"`,
      f: "http://example.com/a#frag",
      g: "value",
    });
  });

  it("parses one-line flow collections", () => {
    expect(value(`a: [1, "two", three, [4], {k: v, n: [x, y]}, ]\nb: {}\nc: []\nd: {a: , b: 'x'}`)).toEqual({
      a: [1, "two", "three", [4], { k: "v", n: ["x", "y"] }],
      b: {},
      c: [],
      d: { a: null, b: "x" },
    });
  });

  it("parses literal block scalars with clip, strip and keep chomping", () => {
    const src = ["clip: |", "  one", "    two", "", "  three", "", "strip: |-", "  x", "", "keep: |+", "  y", "", "", "after: 1"].join("\n");
    expect(value(src)).toEqual({ clip: "one\n  two\n\nthree\n", strip: "x", keep: "y\n\n\n", after: 1 });
  });

  it("parses folded block scalars and explicit indentation", () => {
    const src = ["f: >", "  a", "  b", "", "  c", "    indented", "  d", "g: |2", "     three spaces", "h: >-", "  x", "  y"].join("\n");
    expect(value(src)).toEqual({ f: "a b\nc\n  indented\nd\n", g: "   three spaces\n", h: "x y" });
  });

  it("keeps comments and quotes inside block scalars verbatim", () => {
    expect(value(`p: |\n  # not a comment\n  it's "fine" {{x}}\nq: 1\n`)).toEqual({ p: `# not a comment\nit's "fine" {{x}}\n`, q: 1 });
  });

  it("ignores comments, blank lines, a BOM, CRLF and one leading ---", () => {
    expect(value("\uFEFF# header\r\n---\r\n\r\n  # indented comment\r\na: 1 # x\r\n")).toEqual({ a: 1 });
    expect(value("")).toBeNull();
    expect(value("# only a comment\n")).toBeNull();
  });

  it("records the source line of every node by path", () => {
    const doc = parseYaml("name: x\nsteps:\n  - id: a\n    agent:\n      role: tester\n  - shell: ls\n");
    expect(doc.lines.get("name")).toBe(1);
    expect(doc.lines.get("steps")).toBe(2);
    expect(doc.lines.get("steps[0]")).toBe(3);
    expect(doc.lines.get("steps[0].agent.role")).toBe(5);
    expect(doc.lines.get("steps[1].shell")).toBe(6);
  });
});

describe("parseYaml: rejected syntax, with line numbers", () => {
  const cases: [string, string, number, RegExp][] = [
    ["tab indentation", "a:\n\tb: 1\n", 2, /tab characters/],
    ["anchor", "a: &x 1\n", 1, /anchors/],
    ["alias", "a: *x\n", 1, /aliases/],
    ["tag", "a: !!str 1\n", 1, /tags/],
    ["directive", "%YAML 1.2\na: 1\n", 1, /directives/],
    ["complex key", "? a\n: b\n", 1, /complex keys/],
    ["merge key", "a: 1\n<<: {b: 2}\n", 2, /key/],
    ["duplicate key", "a: 1\nb: 2\na: 3\n", 3, /duplicate key "a"/],
    ["duplicate flow key", "a: {x: 1, x: 2}\n", 1, /duplicate key "x"/],
    ["second document", "a: 1\n---\nb: 2\n", 2, /multiple documents/],
    ["multi-line plain scalar", "a: one\n  two\n", 2, /multi-line plain values/],
    ["multi-line double quote", 'a: "one\n  two"\n', 1, /unterminated/],
    ["unterminated flow", "a: [1, 2\n", 1, /unterminated flow sequence/],
    ["garbage after flow", "a: [1] x\n", 1, /unexpected text after a flow collection/],
    ["text after quote", 'a: "x" y\n', 1, /unexpected text after a quoted string/],
    ["unexpected indentation", "a: 1\n  b: 2\n", 2, /multi-line plain values|unexpected indentation/],
    ["deeper after mapping", "a:\n  b: 1\n    c: 2\n", 3, /unexpected indentation|multi-line/],
    ["colon in plain value", "a: b: c\n", 1, /quote the value/],
    ["unquoted template", "a: {{x}}\n", 1, /must be quoted/],
    ["seq after key on one line", "a: - x\n", 1, /sequence item cannot follow a key/],
    ["seq inside mapping", "a: 1\n- b\n", 2, /sequence item cannot appear inside a mapping/],
    ["bad escape", 'a: "\\q"\n', 1, /unknown escape/],
    ["bad block header", "a: |x\n  y\n", 1, /invalid block scalar header/],
    ["bad key", "a b c: 1\n", 1, /invalid key/],
    ["indented document", "  a: 1\n", 1, /must start at column 1/],
    ["dedented block scalar line", "a: |\n    one\n  two\n", 3, /less indented/],
  ];
  it.each(cases)("%s", (_name, src, line, message) => {
    const error = errorOf(src);
    expect(error.line).toBe(line);
    expect(error.message).toMatch(message);
    expect(error.message).toMatch(new RegExp(`^line ${line}: `));
  });

  it("refuses inputs over the size cap", () => {
    expect(errorOf(`a: "${"x".repeat(MAX_YAML_BYTES)}"`).message).toMatch(/larger than/);
  });

  it("caps nesting depth", () => {
    expect(errorOf(`a: ${"[".repeat(40)}${"]".repeat(40)}`).message).toMatch(/too deep/);
  });

  it("never throws anything but YamlError on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (src) => {
        try {
          parseYaml(src);
        } catch (error) {
          expect(error).toBeInstanceOf(YamlError);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("round-trips arbitrary string values through double quotes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const escaped = JSON.stringify(s).replace(/\\u([0-9a-f]{4})/g, "\\u$1");
        expect(value(`k: ${escaped}\n`)).toEqual({ k: s });
      }),
      { numRuns: 300 },
    );
  });
});
