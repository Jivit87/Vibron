"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { truncate } = require("../src/truncate");

test("short text is unchanged", () => {
  assert.strictEqual(truncate("short", 10), "short");
});

test("cuts at a word boundary", () => {
  assert.strictEqual(truncate("hello world foo", 11), "hello...");
});
