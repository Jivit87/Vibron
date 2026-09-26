/**
 * The browser client and the deliver routes were built in parallel against a
 * written contract. These tests feed the client's real payloads into the
 * server's real parsers, so a renamed field fails here instead of silently
 * disabling a safety rule.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { deliverPr, deliveryEvidence, normalizeCi, normalizeRerun } from "@/lib/client/deliver";
import type { Evidence } from "@/lib/client/run-reducer";
import { parseEvidence } from "@/lib/deliver/report";

afterEach(() => vi.unstubAllGlobals());

function capture(): { bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ error: "stop", code: "workflow_changes" }), { status: 409 });
    }),
  );
  return { bodies };
}

describe("client ↔ deliver routes", () => {
  it("deliver sends the fields the server enforces", async () => {
    const { bodies } = capture();
    const base = { repoKey: "k", branch: "viberon/x", title: "t", body: "b", draft: true, files: ["a.py"] };
    const refused = await deliverPr(base);
    expect(refused).toMatchObject({ ok: false, needsConfirm: true });
    await deliverPr({ ...base, confirm: true });

    // app/api/deliver/route.ts reads expectedFiles and allowWorkflowChanges.
    expect(bodies[0]).toMatchObject({ expectedFiles: ["a.py"] });
    expect(bodies[0]).not.toHaveProperty("allowWorkflowChanges");
    expect(bodies[1]).toMatchObject({ expectedFiles: ["a.py"], allowWorkflowChanges: true });
  });

  it("the issue report evidence parses on the server", () => {
    const evidence = {
      outcome: "verified",
      final: { checks: [{ name: "python -m pytest tests/test_x.py", verdict: "fixes", before: "1 failed", after: "1 passed" }] },
    } as unknown as Evidence;
    const sent = deliveryEvidence(evidence, ["pkg/x.py"]);
    expect(parseEvidence(sent)).toEqual({
      status: "resolved",
      filesChanged: ["pkg/x.py"],
      checks: [{ command: "python -m pytest tests/test_x.py", original: "1 failed", patched: "1 passed", verdict: "fixes" }],
    });
  });

  it("CI status keeps the server's extracted fix task", () => {
    const ci = normalizeCi({
      headSha: "abc",
      state: "failure",
      checks: [{ name: "test", status: "completed", conclusion: "failure", url: "u" }],
      fixTask: "CI failed on abc:\n- test: AssertionError",
    });
    expect(ci?.fixTask).toContain("AssertionError");
  });

  it("re-run responses give the UI its count and limit", () => {
    // app/api/ci/rerun returns { ok, attempt, remaining } (MAX_RERUNS_PER_HEAD = 3).
    expect(normalizeRerun({ ok: true, attempt: 1, remaining: 2 }, 200)).toMatchObject({ reruns: 1, limit: 3 });
  });
});
