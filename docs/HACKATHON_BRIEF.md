# AI Harness Hackathon: requirements brief

Sources: the organizer problem statement (`Engineering_the_AI_Coding_Harness`), the opening talk, and the "Mini Claude Code" research report.

## What will be judged

> Build an autonomous coding-agent harness around the standardized foundation model that can understand software-engineering tasks, navigate an existing repository, intelligently use tools, manage context, orchestrate model interactions, recover from failures, and produce correct, verified changes with efficient use of resources.

- **Same conditions for every team:** the same foundation model, repository, issues, tests and evaluation conditions. The quality of the harness is the only difference.
- **Judging priorities, in order:**
  1. Correctness first.
  2. Evidence over claims.
  3. Efficiency (tokens, calls, time).
- **Round 1, automatic:** the harness is given coding tasks (issues) against repos and scored by tests, which are likely hidden. This is a SWE-bench-style setup.
- **Round 2, faculty panel:** reviewers question the architecture and the decisions behind it. The team must be able to explain and defend every part.
- **Architecture:** none is mandatory. A simple loop, a planner/executor, multiple agents, custom tools, memory, compression and recovery are all allowed. "Build what works reliably."
- **Deliverables:** the harness itself, a technical report or architecture explanation, and a README.

## What that means for Viberon

Viberon already has a strong interactive harness. The gaps against the brief:

1. **No headless entry point.** Evaluation needs `task + repo → verified change` without the UI, e.g. `viberon run --repo <path> --task "<issue>"`. It must:
   - edit the files in place, with an optional `--worktree` mode;
   - write a JSONL trajectory and a final JSON result (status, diff, tests run, tokens, cost, time);
   - exit non-zero on failure.
2. **The model is unknown.** We need an OpenAI-compatible provider adapter, configured by env (base URL, model, key). One adapter covers OpenAI, Gemini's compatibility endpoint, OpenRouter, vLLM and Ollama. Anthropic and Groq already exist.
3. **The model can declare itself finished.** We need a verification gate outside the model:
   - Detect the test command: package.json scripts, pytest, go test, cargo test, make test.
   - Record a baseline before any edit.
   - Reject `finish` unless verification ran after the last edit and there are no new failures compared with the baseline (a test that passed before must still pass).
   - If the repo has no tests, fall back to typecheck, lint or compile checks.
4. **Recovery:**
   - Take a git checkpoint before an edit batch.
   - Classify failures: patch conflict, missing file, command not found, test failure, regression, timeout, schema error.
   - Detect stuck loops (the same tool and args repeated, or the same failure twice) and force a replan.
   - Roll back on regression.
   - When the budget runs out, restore the best checkpoint seen so far and report the run as incomplete.
5. **Language coverage.** The graph parser handles JS/TS only, and the evaluation repos may be Python or another language. The repo map, symbol index and outline need at least Python, and ideally Go, Rust and Java, using lightweight extractors with no native dependencies.
6. **Tool output hygiene.**
   - Truncate test and command output to head and tail.
   - Extract the failing sections (tracebacks, assertion diffs, `FAIL` lines) instead of passing 20k characters through.
7. **Prompt-injection guardrail.** Repository content is untrusted data. State this in the prompts, and frame tool results so it holds.
8. **Evaluation suite (evidence).**
   - 10–12 fixture tasks across 2–3 small repos: at least one Python and one TS. Each has visible and hidden tests.
   - Include tasks that force iteration: a regression trap, a recovery task where the first plausible patch fails, and a stacktrace bug.
   - A runner and scorer produce a metrics table: pass rate, regressions, tokens, calls and time.
9. **Efficiency is already a strength; measure it.** Graph retrieval, dedupe, prompt caching and compaction exist. Report them per run in the result JSON. Default the headless mode to a single strong agent loop; team mode is optional.
10. **Documentation.** `ARCHITECTURE.md` as the technical report (components, loop, context, memory, tools, verification, recovery, efficiency, and the decisions with reasons) and an updated README.

## Principles to keep

- The model proposes, the harness decides, and tests judge.
- A strong single-agent loop beats a broken multi-agent system.
- Keep the design simple enough to explain to a faculty panel.
