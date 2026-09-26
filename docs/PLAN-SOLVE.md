# Round 4 plan: the SWE-bench-grounded solve loop

This supersedes `PLAN-HARNESS.md` and `PLAN-ENGINE.md`. Their contracts still hold (`lib/agents/events.ts`, `lib/verify/types.ts`, `lib/harness/solve-types.ts`, `lib/harness/contracts.ts`); their unfinished work is re-scoped here. The frontend for round 3 is **already merged** (commit 23333b4: clone dialog, Fix mode, FixRun view, eval page, anchored-memory list). The backend must meet the contracts that code already consumes.

## Evidence: what the SWE-bench Verified leaders actually do

Source: `github.com/SWE-bench/experiments`, 182 Verified submissions ranked by resolve rate.

| Rank | System | % | Mechanism that matters |
|---|---|---|---|
| 1 | Live-SWE-agent, Opus 4.5 | 79.2 | A minimal bash-only scaffold; the agent writes its own helper tools at runtime |
| 1 | Sonar Foundation Agent, Opus 4.5 | 79.2 | **Three tools only:** `bash`, `str_replace_editor`, `find_symbols`; one careful system prompt |
| 3 | TRAE + Doubao | 78.8 | 70.6 single attempt → 78.8 with **N candidates + regression-test filtering + a selector** |
| 4 | OpenHands, Opus 4.5 | 77.6 | Phased prompt: explore → **reproduce** → fix → verify → final review |
| 6 | Atlassian Rovo Dev | 76.8 | **A status tool; the run cannot end until the agent marks the task complete** (re-prompted otherwise). Files shown as syntax outlines with **relevant sections expanded** from prior greps. Two candidates → refine (one applied, the other shown in the prompt) |
| 7 | EPAM | 76.8 | A retry **only** when the iteration limit is hit (the wrong path); up to 3 attempts |
| 8 | ACoder | 76.4 | Code-search subagent in its own context; multi-model selection |
| 13 | JoyCode | 74.6 | **Generate a reproduction test first**, validate the diff against it, failure-cause analysis, lessons from past traces |
| 18 | Anthropic tools scaffold | 73.2 | `bash` plus `str_replace` edit, nothing else |

What this means, in order of return per token:
1. **Few tools, well built.** The winners use 2–3 tools. The editor's error messages are where scaffolds differ.
2. **Reproduce first, prove after.** Every top prompt makes the agent reproduce the bug before editing and re-run it after.
3. **The harness decides "done", not the model.** A completion gate plus a re-prompt when the agent stops early.
4. **Regression filtering with the repo's own tests.** Existing tests near the change must still pass.
5. **Retry with a fresh context only when there is no proof.** Keep the attempt with the best evidence.
6. **Structural views over raw reads.** Outlines, with only the relevant sections expanded.
7. **Lessons persist.** Past fixes and root causes are recalled on the same area.

We deliberately do **not** copy 30-candidate sampling or multi-model voting. The hackathon scores efficiency and uses one fixed model. Two attempts with evidence-based selection capture most of that gain.

Our reference port is `/Users/nishant/Developer/Harness Hackathon/pramana` (Python, proven on SWE-bench Verified). Port its **mechanisms** to TypeScript; never shell out to it. Read the named Pramana file before building the matching piece.

## The loop

```
task/issue ─▶ localize (0 tokens) ─▶ baseline (bg) ─▶ solver loop ─────────────▶ gate ─▶ accept ─▶ evidence + memory note
             graph, traceback,       detected test    tools: bash, edit,         │original vs patched:
             BM25, issue snippets    command on the   find_symbols, view,        │ repro fail→pass,
             run on the ORIGINAL     ORIGINAL code    compare, finish            │ related tests pass→pass
                                                      guards: stuck, oscillation └▶ reject → hint back to loop
                                                      budget; finish is the only way out
                                     attempt 2 (fresh context + lessons) only if attempt 1 ends without proof; keep the best
```

## Contracts added this round

### Solver tool set (A)
`run_command` (bash), `edit_file` (tolerant str_replace), `create_file`, `view` (a file or a range; large files show an outline with relevant sections expanded), `find_symbols` (graph-backed, falling back to grep), `compare` (run a command on the original and current code), and `finish` (`{ summary, reproduction?: string }`). The existing tools stay for the interactive roles. The solver sees only these 7.

### `lib/harness/snapshot.ts` (A)
`snapshot(root) → ref`, `restore(root, ref)`, `diff(root, fromRef) → string`, `changedFiles(root, fromRef)`, and `withOriginal(root, baseRef, fn)`, which runs `fn` in a temporary worktree of the original code. Git trees are built through a temporary index, or a shadow git dir for non-git repos. `.viberon/` is always excluded.

### `lib/verify` (B): implement the existing stubs exactly as typed
Also export `runOnOriginalAndPatched(root, baseRef, command, opts) → { original, patched, verdict: "fixes" | "regression" | "pre_existing" | "still_failing" | "passes" }`. It uses A's `withOriginal`; B codes against that signature, and A lands it.

### `lib/localize` (B)
```ts
localize(root: string, task: string, graph: Graph | null, opts?: { runSnippets?: boolean; timeoutMs?: number })
  → Promise<{ files: { path: string; score: number; why: string[] }[]; symbols: string[]; snippetRun?: { code: string; output: string; exitCode: number | null }; testFiles: string[] }>
```

### Memory as an Obsidian vault (B backend, FE graph)
- The store stays canonical. After each write it renders `<root>/.viberon/vault/`:
  - `index.md`;
  - `notes/<slug>.md`, one per entry, with frontmatter `{ id, kind, anchors, stale, created, updated }` and body text plus `[[code/<path>]]` and `[[notes/<slug>]]` wikilinks;
  - `code/<path>.md` stubs, only for anchored files, listing their symbols and linking to the notes.
- **Two-way:** on read, a note whose file mtime is newer than `updated` imports its edited body, and a new `.md` under `notes/` becomes a `note` entry. Opening `.viberon/vault` in Obsidian shows the same graph.
- `.viberon/` is added to `.git/info/exclude` on open and clone.
- `GET /api/memory?repoKey=` also returns `entries: { id, kind, text, anchors, stale }[]` (already consumed by MemoryPanel) and `vault: { path, notes }`.
- `GET /api/memory/graph?repoKey=` returns `{ nodes: { id, kind: "note" | "code", label, stale? }[], links: { source, target }[] }`.
- Solve runs write one `fix` note: issue title, root cause (from the `finish` summary), files, verified or not, anchored to the changed files. Localization reads relevant notes as lessons.

### Routes (B)
Exactly as `lib/client/clone.ts` and `lib/client/eval.ts` consume them:
- `POST /api/clone` streams SSE `CloneEvent`s.
- `GET /api/issue?url=` returns `IssueRef`. It uses the stored GitHub integration token (`readGithubEntry(getGlobalEntries().github)?.token`) when present, so private repos work, and falls back to `GITHUB_TOKEN`, then to anonymous.
- `GET /api/eval`.

## Team and ownership (four agents, no overlap)

| Owner | Files |
|---|---|
| **A: solve loop** | `lib/harness/**`, `lib/tools/**`, `lib/agents/**`, `lib/ai/**`, `lib/context/**`, `app/api/agent/**`, `tests/harness.*` |
| **B: repo intelligence, evidence, memory** | `lib/verify/**`, `lib/localize/**`, `lib/lang/**`, `lib/parser.ts`, `lib/memory/**`, `lib/headless/**`, `cli/**`, `bin/**`, `eval/**`, `app/api/{clone,issue,eval,memory}/**`, `lib/workspace/**`, `lib/local-disk-workspace.ts`, `lib/github.ts`, `package.json`, `README.md`, `ARCHITECTURE.md`, `docs/**`, `tests/{ws,verify,eval,cli,e2e,localize,memory}.*` |
| **FE** | `components/**`, `app/globals.css`, `app/eval/**`, `lib/client/**`, `store/**`, `tests/ui.*` |

**Merge order:** A, then B, then FE. Every branch keeps `tsc`, `vitest` and `next build` green on its own.

## P0 by owner

**A**
1. `snapshot.ts`.
2. The tolerant editor: `lib/tools/editor.ts`, from Pramana `tools/editor.py`. It tolerates pasted line numbers, whitespace and indentation, for a unique match only. On a miss it shows the most similar region. It has a lint gate for py/json/js/ts, oscillation detection, and CRLF/BOM preservation.
3. The `compare` and `finish` tools.
4. `gate.ts`, from Pramana `agent/verify.py`. The agent's repro command plus B's related tests run on the original and patched code. Verdicts are fixes / regression / pre-existing / still_failing. Reject with the failing output. `accept_unverified` only when the repo has no runnable checks.
5. `recovery.ts`, from Pramana `agent/loop.py`: repeated calls, repeated failed edits, oscillation, N turns with no source change, full-suite spam, low-budget nudges, and a forced replan on the second stuck event.
6. The **solver prompt** in the OpenHands/Anthropic phase order: explore → reproduce → fix → verify → edge cases → finish. Include the untrusted-content rule. **Ending without `finish` re-prompts once** (the Rovo pattern).
7. `solveTask`:
   - localize, then a background baseline, then attempt 1;
   - attempt 2 only without proof: fresh context, lessons, and the attempt-1 diff shown as a rejected alternative (the Rovo refine idea);
   - keep the best by evidence, and tidy scratch files out of the diff;
   - emit the round-2 events; write the memory note.
8. Wire `interaction: "fix"` in `/api/agent` to `solveTask`, and attach the gate in interactive solo runs when a test command exists.

**B**
1. `lib/verify`: detection, runners and parsers for pytest, unittest, jest, vitest, node:test, go and cargo; `extractFailures`, `condenseOutput`, `relatedTestFiles` and `runOnOriginalAndPatched`.
2. **Python graph support** (SWE-bench is 100% Python): a lightweight extractor for defs, classes, methods, imports and calls, with no native deps. Go is P1. Extend the extension lists and ignored dirs, and cap scans at 20k files.
3. `lib/localize`, from Pramana `repo/localize.py` and `repo/snippets.py`.
4. The Obsidian vault, two-way, with the memory routes.
5. `/api/clone`, `/api/issue` and `/api/eval`.
6. The headless CLI (`bin/viberon run --repo --task|--issue --test-cmd --json --out`), writing `result.json`, `trajectory.jsonl` and `patch.diff`.
7. The eval harness: copy Pramana's `bench/tasks/*` with their hidden tests into `eval/tasks`, plus `eval/run.ts` and `eval/score.ts`, writing `results.md`.
8. **Cleanup:** delete modules with zero non-test importers after checking (`lib/groq.ts` is superseded by `lib/ai/groq.ts`, plus `lib/colors.ts`, `lib/retrieval.ts`, `lib/graph-helpers.ts` and their tests if they are only exercised by tests). Delete `docs/PLAN-HARNESS.md` and `docs/PLAN-ENGINE.md` (folded in here). Write `ARCHITECTURE.md`, citing the SWE-bench evidence table above for each decision.

**FE**
1. The memory graph in the graph pane: a toggle "Code / Code + Memory"; note nodes are drawn distinctly and linked to code nodes; stale notes are dimmed.
2. A backlinks section in MemoryPanel (notes that link to the selected file or symbol), and "Open vault in Obsidian" (`obsidian://open?path=<abs vault path>`).
3. FixRun: show localization (top files, and whether the issue snippet reproduced), the evidence verdict table per check (original → patched), and the attempt-2 rationale.
4. Settings → Integrations: a one-line "Used for private clones and issues" under GitHub.
5. The UI must not look AI-generated: follow the existing restrained `vb-*` system and add no new visual language.
