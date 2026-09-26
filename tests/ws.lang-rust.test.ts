import { describe, expect, it } from "vitest";

import { parseRepo } from "@/lib/parser";

const parser = `#[derive(Debug)]
pub struct Token<'a> {
    text: &'a str,
}

pub enum Kind { Word, Space }

pub fn parse<'a>(input: &'a str) -> Vec<Token<'a>> {
    let braces = "{{";
    input.split(' ').map(|t| make(t)).collect()
}

fn make(text: &str) -> Token {
    Token { text }
}

impl Token<'_> {
    pub fn len(&self) -> usize {
        self.text.len()
    }
}
`;

describe("rust extraction", () => {
  const { graph } = parseRepo([
    {
      path: "src/lib.rs",
      source:
        "pub mod parser;\nuse crate::parser::{parse, Token};\n\npub fn run(input: &str) -> usize {\n    let toks = parse(input);\n    toks.len()\n}\n",
    },
    { path: "src/parser.rs", source: parser },
  ]);
  const byName = (name: string) => graph.nodes.find((n) => n.name === name)!;

  it("extracts fns, structs, enums and impl methods", () => {
    expect(byName("Token").kind).toBe("class");
    expect(byName("Token").endLine).toBe(4);
    expect(byName("Kind").endLine).toBe(6);
    expect(byName("parse").startLine).toBe(8);
    expect(byName("parse").endLine).toBe(11);
    expect(byName("len").endLine).toBe(20);
  });

  it("resolves crate paths and calls", () => {
    const has = (from: string, to: string, kind: string) =>
      graph.edges.some(
        (e) => e.source === byName(from).id && e.target === byName(to).id && e.kind === kind,
      );
    expect(has("run", "parse", "call")).toBe(true);
    expect(has("parse", "make", "call")).toBe(true);
    expect(has("run", "Token", "import")).toBe(true);
  });
});
