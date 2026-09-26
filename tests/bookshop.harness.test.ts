/**
 * End-to-end harness test verifying issue resolution on harness-demo-bookshop.
 * Demonstrates the full SWE-bench / Vibron cycle:
 *   1. Repository & runtime detection (Python Flask, pytest)
 *   2. Issue ingestion & untrusted framing
 *   3. Zero-token localization
 *   4. Reproduction test synthesis (Fail on baseline)
 *   5. Surgical edit via tolerant editor
 *   6. Verification gatekeeper (Fail-to-Pass + Zero regressions)
 *   7. Evidence bundle & memory note recording
 */

import { existsSync, cpSync, rmSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { solveTask } from "@/lib/harness/solve";
import type { SolveOptions } from "@/lib/harness/solve-types";
import { registerLocalWorkspace } from "@/lib/local-disk-workspace";
import { resetMemoryStoreForTests } from "@/lib/store";
import { detectVerifyCommands } from "@/lib/verify/detect";
import { openWorkspace } from "@/lib/workspace";
import { installFakeProvider, uninstallFakeProvider } from "./helpers/fake-provider";
import { eventLog } from "./helpers/harness-workspace";

const BOOKSHOP_SOURCE = "/tmp/harness-demo-bookshop";

describe("harness-demo-bookshop issue solving", () => {
  let tempRepo: string;
  let log: ReturnType<typeof eventLog>;

  beforeEach(() => {
    resetMemoryStoreForTests();
    log = eventLog();
    tempRepo = path.join(os.tmpdir(), `bookshop-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tempRepo, { recursive: true });
    // Copy the cloned bookshop repository
    cpSync(BOOKSHOP_SOURCE, tempRepo, { recursive: true });
  });

  afterEach(() => {
    uninstallFakeProvider();
    if (existsSync(tempRepo)) {
      rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it("autonomously solves Issue #8 ('Price: high to low' sorts from low to high)", async () => {
    const issueText = [
      "Fix GitHub issue #8: 'Price: high to low' sorts from low to high",
      "",
      "<issue>",
      "Choosing Sort by: Price: high to low (/?sort=price_desc) lists the cheapest book first.",
      "Expected: the most expensive book first, then descending to the cheapest.",
      "</issue>",
    ].join("\n");

    const reproPath = ".viberon/scratch/repro_issue8.py";
    const reproCode = [
      "from bookshop.catalog import load_books, sort_books",
      "books = load_books()",
      "desc = sort_books(books, 'price_desc')",
      "assert desc[0].price >= desc[-1].price, f'First {desc[0].price} < Last {desc[-1].price}'",
      "assert desc[0].price == max(b.price for b in books)",
      "print('REPRO_PASS')",
    ].join("\n");

    const originalLine = '    "price_desc": (lambda book: book.price, False),';
    const fixedLine = '    "price_desc": (lambda book: book.price, True),';
    const reproCmd = `python ${reproPath}`;

    // Script the agent's actions:
    // Turn 1: create reproduction script, run it (fails on baseline)
    // Turn 2: edit bookshop/catalog.py to sort in reverse order
    // Turn 3: finish with summary and reproduction command
    installFakeProvider([
      {
        text: "I will first reproduce the issue by testing price_desc sorting.",
        calls: [
          { name: "create_file", input: { path: reproPath, content: reproCode } },
          { name: "run_command", input: { command: reproCmd } },
        ],
      },
      {
        text: "The reproduction failed as expected. In catalog.py, price_desc has reverse=False. Fixing it.",
        calls: [
          {
            name: "edit_file",
            input: {
              path: "bookshop/catalog.py",
              find: originalLine,
              replace: fixedLine,
              summary: "Set price_desc reverse flag to True",
            },
          },
          { name: "run_command", input: { command: reproCmd } },
        ],
      },
      {
        text: "The reproduction script now passes. Calling finish.",
        calls: [
          {
            name: "finish",
            input: {
              summary: "Fixed price_desc sorting by setting reverse=True in SORT_OPTIONS",
              reproduction: reproCmd,
            },
          },
        ],
      },
    ]);

    const meta = await registerLocalWorkspace(tempRepo);
    const handle = await openWorkspace(meta.repoKey);
    const commands = await detectVerifyCommands(tempRepo);

    const solveOpts: SolveOptions = {
      handle,
      task: issueText,
      model: "claude-opus-5",
      emit: log.emit,
      runId: "bookshop-run-8",
      budget: { maxTurns: 10 },
      verify: { enabled: true, commands, timeoutMs: 60_000, baseline: true },
    };

    const result = await solveTask(solveOpts);

    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["bookshop/catalog.py"]);
    expect(result.diff).toContain(`+${fixedLine}`);
    expect(result.diff).not.toContain(".viberon");

    // The gate verified that the repro check failed on original and passed on patched
    expect(result.gate.enabled).toBe(true);
    expect(result.gate.fixed).toContain(reproCmd);
    expect(result.gate.newFailures).toHaveLength(0);

    // Verify all 27 existing repo tests still pass
    expect(result.gate.final?.exitCode).toBe(0);

    // Check emitted events
    expect(log.of("agent_start")[0]).toMatchObject({ role: "solver", attempt: 1 });
    expect(log.of("gate").at(-1)?.decision).toBe("accept");
    expect(log.of("run_done").at(-1)).toMatchObject({ status: "done", filesChanged: 1 });
  });

  it("autonomously solves Issue #4 ('SAVE10 takes $10 off instead of 10%')", async () => {
    const issueText = [
      "Fix GitHub issue #4: SAVE10 takes $10 off instead of 10%",
      "",
      "<issue>",
      "Discount codes should take a percentage off the subtotal, not flat dollars.",
      "Total should also never be negative.",
      "</issue>",
    ].join("\n");

    const reproPath = ".viberon/scratch/repro_issue4.py";
    const reproCode = [
      "from bookshop.cart import Cart",
      "from bookshop.catalog import Book",
      "books = {'b1': Book(id='b1', title='Les Mis', author='Victor Hugo', genre='classic', price=21.0, year=1862)}",
      "cart = Cart({'b1': 1})",
      "cart.apply_code('SAVE10')",
      "# 10% of 21.0 should be 2.10, total 18.90",
      "assert cart.discount(books) == 2.1, f'Expected 2.1, got {cart.discount(books)}'",
      "assert cart.total(books) == 18.9, f'Expected 18.9, got {cart.total(books)}'",
      "print('REPRO_PASS')",
    ].join("\n");

    const originalDiscount = [
      "    def discount(self, books_by_id):",
      '        """Amount taken off the subtotal by the applied discount code."""',
      "        if not self.code:",
      "            return 0.0",
      "        return float(DISCOUNT_CODES[self.code])",
    ].join("\n");

    const fixedDiscount = [
      "    def discount(self, books_by_id):",
      '        """Amount taken off the subtotal by the applied discount code."""',
      "        if not self.code:",
      "            return 0.0",
      "        pct = DISCOUNT_CODES.get(self.code, 0)",
      "        return round(self.subtotal(books_by_id) * (pct / 100.0), 2)",
    ].join("\n");

    const reproCmd = `python ${reproPath}`;

    installFakeProvider([
      {
        text: "I will create a reproduction script to check percentage discount calculation.",
        calls: [
          { name: "create_file", input: { path: reproPath, content: reproCode } },
          { name: "run_command", input: { command: reproCmd } },
        ],
      },
      {
        text: "Reproduction failed: discount returned 10.0 instead of 2.10. Fixing cart.py.",
        calls: [
          {
            name: "edit_file",
            input: {
              path: "bookshop/cart.py",
              find: originalDiscount,
              replace: fixedDiscount,
              summary: "Compute discount as percentage of subtotal",
            },
          },
          { name: "run_command", input: { command: reproCmd } },
        ],
      },
      {
        text: "Reproduction passed and tests are green. Calling finish.",
        calls: [
          {
            name: "finish",
            input: {
              summary: "Updated Cart.discount() to calculate percentage off subtotal instead of flat deduction",
              reproduction: reproCmd,
            },
          },
        ],
      },
    ]);

    const meta = await registerLocalWorkspace(tempRepo);
    const handle = await openWorkspace(meta.repoKey);
    const commands = await detectVerifyCommands(tempRepo);

    const solveOpts: SolveOptions = {
      handle,
      task: issueText,
      model: "claude-opus-5",
      emit: log.emit,
      runId: "bookshop-run-4",
      budget: { maxTurns: 10 },
      verify: { enabled: true, commands, timeoutMs: 60_000, baseline: true },
    };

    const result = await solveTask(solveOpts);

    expect(result.status).toBe("resolved");
    expect(result.filesChanged).toEqual(["bookshop/cart.py"]);
    expect(result.diff).toContain("+        pct = DISCOUNT_CODES.get(self.code, 0)");
    expect(result.diff).not.toContain(".viberon");
    expect(result.gate.enabled).toBe(true);
    expect(result.gate.fixed).toContain(reproCmd);
    expect(result.gate.final?.exitCode).toBe(0);
  });
});
