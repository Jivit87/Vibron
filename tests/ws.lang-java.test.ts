import { describe, expect, it } from "vitest";

import { parseRepo } from "@/lib/parser";

const strings = `package com.acme.util;

public final class Strings {
    private Strings() {}

    public static String slug(String in) {
        if (in == null) {
            return "";
        }
        return in.trim().toLowerCase();
    }
}
`;

const app = `package com.acme;

import com.acme.util.Strings;
import java.util.List;

public class App {
    @Override
    public String toString() {
        return Strings.slug("x") + helper();
    }

    private int helper() {
        return 1;
    }

    interface Handler {
        void handle(String s);
    }
}
`;

describe("java extraction", () => {
  const { graph } = parseRepo([
    { path: "src/main/java/com/acme/util/Strings.java", source: strings },
    { path: "src/main/java/com/acme/App.java", source: app },
  ]);
  const byName = (name: string) => graph.nodes.find((n) => n.name === name)!;

  it("extracts classes, constructors and methods", () => {
    expect(byName("Strings").kind).toBe("class");
    expect(byName("Strings").endLine).toBe(12);
    expect(byName("slug").startLine).toBe(6);
    expect(byName("slug").endLine).toBe(11);
    expect(byName("Handler").kind).toBe("class");
    expect(graph.nodes.some((n) => n.name === "if" || n.name === "return")).toBe(false);
  });

  it("resolves imports and static calls", () => {
    const has = (from: string, to: string, kind: string) =>
      graph.edges.some(
        (e) => e.source === byName(from).id && e.target === byName(to).id && e.kind === kind,
      );
    expect(has("toString", "slug", "call")).toBe(true);
    expect(has("toString", "helper", "call")).toBe(true);
    expect(has("App", "Strings", "import")).toBe(true);
  });
});
