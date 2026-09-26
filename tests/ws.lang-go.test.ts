import { describe, expect, it } from "vitest";

import { parseRepo } from "@/lib/parser";

const cart = `package cart

import (
	"fmt"
	"example.com/shop/money"
)

type Cart struct {
	Items []Item
}

// Total sums the cart; braces in "strings {" and runes '{' are ignored.
func (c *Cart) Total() money.Cents {
	var t money.Cents
	for _, it := range c.Items {
		t = money.Add(t, it.Price)
	}
	fmt.Println("total {", '{')
	return t
}

func New(opts interface{}) *Cart {
	return &Cart{}
}
`;

describe("go extraction", () => {
  const { graph } = parseRepo([
    { path: "go.mod", source: "module example.com/shop\n\ngo 1.21\n" },
    { path: "cart/cart.go", source: cart },
    {
      path: "cart/item.go",
      source: "package cart\n\ntype Item struct {\n\tPrice int\n}\n\nfunc helper() { New(nil) }\n",
    },
    {
      path: "money/money.go",
      source: "package money\n\ntype Cents int\n\nfunc Add(a, b Cents) Cents {\n\treturn a + b\n}\n",
    },
  ]);
  const byName = (name: string) => graph.nodes.find((n) => n.name === name)!;

  it("extracts funcs, methods and types with brace-matched ends", () => {
    expect(byName("Cart").kind).toBe("class");
    expect(byName("Total").startLine).toBe(13);
    expect(byName("Total").endLine).toBe(20);
    expect(byName("New").endLine).toBe(24);
    expect(byName("Add").endLine).toBe(7);
  });

  it("resolves module imports and same-package calls", () => {
    const has = (from: string, to: string, kind: string) =>
      graph.edges.some(
        (e) => e.source === byName(from).id && e.target === byName(to).id && e.kind === kind,
      );
    expect(has("Total", "Add", "call")).toBe(true);
    expect(has("Total", "Add", "import")).toBe(true);
    expect(has("helper", "New", "call")).toBe(true);
  });
});
