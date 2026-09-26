import { describe, expect, it } from "vitest";

import { condenseOutput, extractFailures } from "@/lib/verify";

function noise(n: number, prefix = "collecting"): string {
  return Array.from({ length: n }, (_, i) => `${prefix} module_${i} ........ ok`).join("\n");
}

const TRACEBACK = `ERROR: test_load (tests.test_loader.TestLoader.test_load)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "tests/test_loader.py", line 12, in test_load
    result = load_layers([DEFAULTS, override])
  File "layercfg/loader.py", line 7, in load_layers
    merged = deep_merge(merged, layer)
  File "layercfg/merge.py", line 4, in deep_merge
    out = base.copy(
AttributeError: 'list' object has no attribute 'copy'`;

describe("failure extraction", () => {
  it("keeps the whole traceback from the middle of a huge log, plus the summary tail", () => {
    const output = `${noise(3000)}\n${TRACEBACK}\n${noise(3000, "teardown")}\nRan 400 tests in 2.1s\n\nFAILED (errors=1)\n`;
    const excerpt = extractFailures(output, 4000);
    expect(excerpt.length).toBeLessThanOrEqual(4000);
    expect(excerpt).toContain("Traceback (most recent call last)");
    expect(excerpt).toContain("layercfg/merge.py\", line 4");
    expect(excerpt).toContain("AttributeError: 'list' object has no attribute 'copy'");
    expect(excerpt).toContain("FAILED (errors=1)");
    expect(excerpt).not.toContain("module_1500");
  });

  it("captures TAP diagnostics, go FAIL lines, rust panics and jest blocks", () => {
    const tap = `${noise(50)}\nnot ok 2 - subs\n  ---\n  duration_ms: 1\n  location: 'a.test.js:5:8'\n  failureType: 'testCodeFailure'\n  error: |-\n    Expected values to be strictly equal:\n    1 !== 5\n  ...\n${noise(50)}`;
    expect(extractFailures(tap)).toContain("1 !== 5");
    expect(extractFailures(`${noise(40)}\n--- FAIL: TestTotal (0.00s)\n    cart_test.go:12: got 3 want 4\n${noise(40)}`)).toContain(
      "got 3 want 4",
    );
    expect(extractFailures(`${noise(40)}\nthread 'x' panicked at src/a.rs:3:5:\nassertion failed\n${noise(40)}`)).toContain(
      "panicked at src/a.rs:3:5",
    );
    expect(extractFailures(`${noise(40)}\n  ● slug › accents\n\n    expect(received).toBe(expected)\n${noise(40)}`)).toContain(
      "expect(received).toBe(expected)",
    );
  });

  it("with no recognizable failure, returns the tail", () => {
    const excerpt = extractFailures(`${noise(100)}\nmake: *** [test] Error 2`, 500);
    expect(excerpt).toContain("make: *** [test] Error 2");
    expect(excerpt.length).toBeLessThanOrEqual(500);
  });
});

describe("condenseOutput", () => {
  it("returns short output untouched and strips ANSI / progress redraws", () => {
    expect(condenseOutput("\u001b[32mok\u001b[0m\n10%\r50%\r100%\n", 0)).toBe("ok\n100%\n");
  });

  it("passing output: head + tail within budget", () => {
    const out = condenseOutput(`${noise(2000)}\nall 2000 passed`, 0, 3000);
    expect(out.length).toBeLessThanOrEqual(3100);
    expect(out).toContain("module_0");
    expect(out).toContain("all 2000 passed");
    expect(out).toContain("passing output");
  });

  it("failing output: failure blocks + tail instead of a blind cut", () => {
    const out = condenseOutput(`${noise(3000)}\n${TRACEBACK}\n${noise(3000)}\nFAILED (errors=1)`, 1, 3000);
    expect(out.length).toBeLessThanOrEqual(3000);
    expect(out).toContain("AttributeError: 'list' object has no attribute 'copy'");
    expect(out).toContain("FAILED (errors=1)");
  });
});
