"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { truncate } = require("../src/truncate");

test("never longer than max, ellipsis included", () => {
  for (const [text, max] of [
    ["abcdefghij", 5],
    ["hello brave new world", 12],
    ["one two three four five", 9],
    ["x".repeat(50), 10],
  ]) {
    assert.ok(truncate(text, max).length <= max, `${text} @ ${max}`);
  }
  assert.strictEqual(truncate("abcdefghij", 5), "ab...");
});

test("still cuts at a word boundary (regression trap)", () => {
  assert.strictEqual(truncate("hello brave new world", 12), "hello...");
  assert.strictEqual(truncate("hello world foo", 11), "hello...");
});

test("custom ellipsis", () => {
  assert.strictEqual(truncate("hello brave world", 10, { ellipsis: "…" }), "hello…");
  assert.strictEqual(truncate("hello", 10, { ellipsis: "…" }), "hello");
});

test("short text unchanged", () => {
  assert.strictEqual(truncate("short", 10), "short");
});
