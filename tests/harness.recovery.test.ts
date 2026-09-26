import { describe, expect, it } from "vitest";

import { classifyFailure, TrajectoryGuards } from "@/lib/harness/recovery";

describe("classifyFailure", () => {
  it.each([
    ["Error: `find` text was not found in a.py", "patch_conflict"],
    ["Error: file not found (x.ts).", "missing_file"],
    ["Command exited 127 (exited).\nbash: pytestx: command not found", "command_not_found"],
    ["Command exited null (killed). timed out", "timeout"],
    ["Error: edit NOT applied: it would make a.py unparseable.", "syntax_error"],
    ["Refused: this command deletes the repo", "refused"],
    ["Error: Tool arguments were not valid JSON", "schema_error"],
    ["Command exited 1\nAssertionError: expected 2", "test_failure"],
    ["all good", null],
  ])("%s -> %s", (text, cls) => {
    expect(classifyFailure(text)).toBe(cls);
  });
});

describe("TrajectoryGuards", () => {
  const call = (name: string, input: Record<string, unknown>, output = "ok", failed = false) => ({
    name,
    input,
    output,
    failed,
  });

  it("nudges on a repeated identical call and escalates to a replan", () => {
    const g = new TrajectoryGuards(40);
    for (let i = 0; i < 3; i += 1) g.track(call("grep", { pattern: "x" }));
    const first = g.guards(3);
    expect(first.map((n) => n.text).join()).toMatch(/exact same `grep` call 3 times/);
    expect(g.stuckEvents).toBe(1);
    for (let i = 0; i < 3; i += 1) g.track(call("grep", { pattern: "y" }));
    const second = g.guards(4);
    expect(second.some((n) => n.action === "replan")).toBe(true);
  });

  it("hints once per failure class and nudges after repeated failed edits", () => {
    const g = new TrajectoryGuards(40);
    const miss = "Error: `find` text was not found in a.py";
    expect(g.track(call("edit_file", { path: "a.py", find: "1" }, miss, true))?.failureClass).toBe("patch_conflict");
    expect(g.track(call("edit_file", { path: "a.py", find: "2" }, miss, true))).toBeNull();
    g.track(call("edit_file", { path: "a.py", find: "3" }, miss, true));
    expect(g.guards(3).map((n) => n.text).join()).toMatch(/last 3 edits to a.py failed/);
    expect(g.failureClasses.patch_conflict).toBe(3);
  });

  it("asks for a reproduction file after inline probes, and for an edit at half budget", () => {
    const g = new TrajectoryGuards(20);
    for (let i = 0; i < 4; i += 1) g.track(call("run_command", { command: `python -c "print(${i})"` }));
    expect(g.guards(4).map((n) => n.text).join()).toMatch(/one-off inline scripts/);
    expect(g.guards(10).map((n) => n.text).join()).toMatch(/without changing any source file/);
    expect(g.guards(17).map((n) => n.text).join()).toMatch(/Budget: 3 steps left/);
  });

  it("counts scratch files separately from source edits", () => {
    const g = new TrajectoryGuards(40);
    g.track(call("write_file", { path: ".viberon/scratch/repro.py" }));
    expect(g.edits).toBe(0);
    expect(g.scratchFiles).toBe(1);
    g.track(call("edit_file", { path: "src/a.py" }));
    expect(g.edits).toBe(1);
  });

  it("nudges on full-suite spam", () => {
    const g = new TrajectoryGuards(40);
    g.track(call("run_command", { command: "python -m pytest -q" }));
    expect(g.guards(1)).toEqual([]);
    g.track(call("run_command", { command: "npm test" }));
    g.track(call("run_command", { command: "python -m pytest tests/test_x.py" }));
    expect(g.fullSuiteRuns).toBe(2);
    expect(g.guards(2).map((n) => n.text).join()).toMatch(/entire test suite 2 times/);
  });

  it("flags oscillating edits as stuck and nudges", () => {
    const g = new TrajectoryGuards(40);
    g.track(call("edit_file", { path: "a.py" }, "Edited a.py\nNOTE: ... you are going back and forth."));
    const notes = g.guards(1);
    expect(notes.map((n) => n.text).join()).toMatch(/going back and forth between versions/);
    expect(g.stuckEvents).toBe(1);
  });

  it("nudges after turns without a source change, and the second stuck event forces a replan", () => {
    const g = new TrajectoryGuards(60);
    g.track(call("edit_file", { path: "a.py" }));
    let notes: ReturnType<TrajectoryGuards["guards"]> = [];
    for (let step = 1; step <= 10; step += 1) notes = g.guards(step);
    expect(notes.map((n) => n.text).join()).toMatch(/10 turns have passed since your last source change/);
    expect(g.stuckEvents).toBe(1);
    for (let step = 11; step <= 20; step += 1) notes = g.guards(step);
    expect(notes.some((n) => n.action === "replan")).toBe(true);
  });
});
