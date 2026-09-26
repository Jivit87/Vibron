import { describe, expect, it } from "vitest";

import { parseTestOutput } from "@/lib/verify";

const UNITTEST = `test_bad (test_a.TestA.test_bad) ... FAIL
test_err (test_a.TestA.test_err) ... ERROR
test_ok (test_a.TestA.test_ok) ... ok
test_skip (test_a.TestA.test_skip) ... skipped 'later'
test_old (tests.test_b.TestB) ... ok
test_doc (tests.test_b.TestB.test_doc)
Docstring line ... ok

======================================================================
FAIL: test_bad (test_a.TestA.test_bad)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "tests/test_a.py", line 8, in test_bad
    self.assertEqual("a", "b")
AssertionError: 'a' != 'b'

----------------------------------------------------------------------
Ran 6 tests in 0.001s

FAILED (failures=1, errors=1, skipped=1)
`;

const PYTEST = `============================= test session starts ==============================
collected 5 items

tests/test_slug.py ..F.                                                  [ 80%]
tests/test_wrap.py E                                                     [100%]

=================================== FAILURES ===================================
________________________________ test_accents _________________________________

    def test_accents():
>       assert slugify("Crème") == "creme"
E       AssertionError: assert 'crème' == 'creme'

tests/test_slug.py:9: AssertionError
=========================== short test summary info ============================
PASSED tests/test_slug.py::test_simple
PASSED tests/test_slug.py::test_custom_sep
FAILED tests/test_slug.py::test_accents - AssertionError: assert 'crème' == 'creme'
PASSED tests/test_slug.py::test_plain
ERROR tests/test_wrap.py::test_truncate - NameError: name 'x' is not defined
==================== 1 failed, 3 passed, 1 error in 0.05s =====================
`;

const TAP = `TAP version 13
# Subtest: math
    # Subtest: adds
    ok 1 - adds
      ---
      duration_ms: 0.25
      ...
    # Subtest: subs
    not ok 2 - subs
      ---
      error: |-
        Expected values to be strictly equal:
      ...
    1..2
not ok 1 - math
  ---
  type: 'suite'
  ...
# Subtest: top
ok 2 - top
# Subtest: skipped
ok 3 - skipped # SKIP
1..3
# tests 4
# pass 2
# fail 1
# skipped 1
`;

const GO_JSON = [
  '{"Action":"run","Package":"example.com/shop/cart","Test":"TestTotal"}',
  '{"Action":"output","Package":"example.com/shop/cart","Test":"TestTotal","Output":"--- FAIL: TestTotal (0.00s)\\n"}',
  '{"Action":"fail","Package":"example.com/shop/cart","Test":"TestTotal","Elapsed":0}',
  '{"Action":"pass","Package":"example.com/shop/cart","Test":"TestNew","Elapsed":0}',
  '{"Action":"skip","Package":"example.com/shop/cart","Test":"TestSlow","Elapsed":0}',
  '{"Action":"fail","Package":"example.com/shop/cart","Elapsed":0.01}',
].join("\n");

const CARGO = `running 3 tests
test parser::tests::parses ... ok
test parser::tests::empty ... FAILED
test slow ... ignored

failures:

---- parser::tests::empty stdout ----
thread 'parser::tests::empty' panicked at src/parser.rs:20:9:
assertion failed: toks.is_empty()

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out
`;

const VITEST = ` ✓ tests/wrap.test.ts (2 tests) 3ms
 ❯ tests/slug.test.ts (3 tests | 1 failed) 6ms
   ✓ slugify > lowercases 1ms
   × slugify > strips accents 3ms
   ✓ slugify > collapses 0ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/slug.test.ts > slugify > strips accents
AssertionError: expected 'crème' to be 'creme'

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
`;

const JEST = `FAIL src/slug.test.js
  slugify
    ✓ lowercases (2 ms)
    ✕ strips accents (4 ms)
    ○ skipped later

  ● slugify › strips accents

    expect(received).toBe(expected)

Tests:       1 failed, 1 skipped, 1 passed, 3 total
`;

describe("test output parsers", () => {
  it("unittest -v (3.11+ and older id formats, docstring variant)", () => {
    const parsed = parseTestOutput("unittest", UNITTEST);
    expect(parsed.tests).toEqual({
      "test_a.TestA.test_bad": "fail",
      "test_a.TestA.test_err": "error",
      "test_a.TestA.test_ok": "pass",
      "test_a.TestA.test_skip": "skip",
      "tests.test_b.TestB.test_old": "pass",
      "tests.test_b.TestB.test_doc": "pass",
    });
    expect(parsed.summary).toEqual({ passed: 3, failed: 1, errors: 1, skipped: 1 });
  });

  it("pytest -rA", () => {
    const parsed = parseTestOutput("pytest", PYTEST);
    expect(parsed.tests["tests/test_slug.py::test_accents"]).toBe("fail");
    expect(parsed.tests["tests/test_slug.py::test_simple"]).toBe("pass");
    expect(parsed.tests["tests/test_wrap.py::test_truncate"]).toBe("error");
    expect(Object.keys(parsed.tests)).toHaveLength(5);
    expect(parsed.summary).toEqual({ passed: 3, failed: 1, errors: 1 });
  });

  it("node --test TAP with nested suites", () => {
    const parsed = parseTestOutput("node-test", TAP);
    expect(parsed.tests).toEqual({
      "math > adds": "pass",
      "math > subs": "fail",
      top: "pass",
      skipped: "skip",
    });
    expect(parsed.summary).toEqual({ passed: 2, failed: 1, skipped: 1 });
  });

  it("go test -json", () => {
    const parsed = parseTestOutput("go", GO_JSON);
    expect(parsed.tests).toEqual({
      "example.com/shop/cart/TestTotal": "fail",
      "example.com/shop/cart/TestNew": "pass",
      "example.com/shop/cart/TestSlow": "skip",
    });
  });

  it("cargo test", () => {
    const parsed = parseTestOutput("cargo", CARGO);
    expect(parsed.tests).toEqual({ "parser::tests::parses": "pass", "parser::tests::empty": "fail", slow: "skip" });
    expect(parsed.summary).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });

  it("vitest and jest", () => {
    const vitest = parseTestOutput("vitest", VITEST);
    expect(vitest.tests["slugify > strips accents"]).toBe("fail");
    expect(vitest.tests["slugify > lowercases"]).toBe("pass");
    expect(vitest.summary).toEqual({ passed: 4, failed: 1 });
    const jest = parseTestOutput("jest", JEST);
    expect(jest.tests["src/slug.test.js > strips accents"]).toBe("fail");
    expect(jest.tests["src/slug.test.js > lowercases"]).toBe("pass");
    expect(jest.tests["src/slug.test.js > skipped later"]).toBe("skip");
    expect(jest.summary).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });

  it("ambiguous npm-script output falls back to the best parser", () => {
    expect(parseTestOutput("npm-script", TAP).tests["math > subs"]).toBe("fail");
    expect(parseTestOutput("npm-script", "nothing useful").tests).toEqual({});
  });
});
