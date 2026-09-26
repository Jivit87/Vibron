# Viberon: Deep Codebase Analysis & Competitive Landscape Research

> A comprehensive study of what Viberon has built, what the best open-source coding agents offer, and a detailed gap analysis with actionable recommendations.

---

## Part 1 — What Viberon Has Built (Current State)

### 1.1 Project Identity

Viberon is an **autonomous coding harness** wrapped in a desktop IDE. It takes a repository and a task (or GitHub issue), decomposes the work, dispatches it to specialist agents, runs them concurrently, verifies the result with the repo's own test suite, and produces an evidence bundle a reviewer can audit.

**Core design rule:** *"The model proposes, the harness decides, and tests judge."*

**Tech Stack:** Next.js 15 (App Router) + React 19 + TypeScript + Electron + Zustand + Monaco Editor + Radix/Shadcn UI + TailwindCSS

---

### 1.2 Module-by-Module Inventory

#### A. Agent System (`lib/agents/`)

| File | Size | Purpose |
|:--|:--|:--|
| [runner.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/runner.ts) | 33.8 KB | Core agent execution loop — single strong tool-using loop with lean solver tool set |
| [orchestrator.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/orchestrator.ts) | 34.5 KB | Multi-agent orchestration — decomposes requests into task DAGs, assigns to specialists |
| [roles.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/roles.ts) | 29.5 KB | **11 specialist roles**: orchestrator, assistant, architect, frontend, design, backend, database, logic, devops, tester, reviewer, docs — each with tuned prompts, tool subsets, and model tiers |
| [intent.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/intent.ts) | 4.9 KB | Intent classifier — routes between questions (read-only) and build requests |
| [events.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/events.ts) | 11.2 KB | Orchestration event system and TODO tracking |
| [rules.ts](file:///Users/jivitrana/Desktop/Vibron/lib/agents/rules.ts) | 5.4 KB | Workspace rules/conventions loading |

**Key Innovation:** Strict file write-locks per agent step. The plan normalizer enforces disjoint file ownership even if the LLM ignores the instruction — two agents can never clobber the same file. Steps that don't depend on each other run concurrently. After each wave, the graph and memory are re-indexed.

#### B. Tool System (`lib/tools/`)

| File | Size | Purpose |
|:--|:--|:--|
| [registry.ts](file:///Users/jivitrana/Desktop/Vibron/lib/tools/registry.ts) | 58.2 KB | **Complete tool suite**: view, find_symbols, graph_search, symbol_outline, edit_file, create_file, rename_file, delete_file, run_command, compare, finish, list_files, create_dir, memory tools. Tools are ordered so cheap ones look attractive and `read_file` looks like a last resort |
| [editor.ts](file:///Users/jivitrana/Desktop/Vibron/lib/tools/editor.ts) | 17.8 KB | **Tolerant `str_replace` editor**: whitespace/indent tolerance, line-number paste, CRLF/BOM preservation, most-similar-region shown on miss, lint gate (py/json/js/ts/toml must still parse) |
| [navigate.ts](file:///Users/jivitrana/Desktop/Vibron/lib/tools/navigate.ts) | 9.3 KB | Symbol navigation: find definitions, callers, rendering |

**Tool Categories (role-based access control):**
- `SOLVER_TOOLS` — full autonomous solve loop
- `READ_TOOLS` — question-answering (no writes)
- `WRITE_TOOLS` — file mutations
- `EXEC_TOOLS` — command execution
- `PLANNING_TOOLS` — orchestration
- `MEMORY_TOOLS` — memory read/write

#### C. Harness & Verification (`lib/harness/`, `lib/verify/`)

| File | Size | Purpose |
|:--|:--|:--|
| [solve.ts](file:///Users/jivitrana/Desktop/Vibron/lib/harness/solve.ts) | 30.3 KB | Master solve loop: explore → reproduce → fix → verify → edge cases → finish |
| [gate.ts](file:///Users/jivitrana/Desktop/Vibron/lib/harness/gate.ts) | 31.6 KB | **Verification gate**: re-runs detected checks after last edit, compares per-test outcomes with baseline. Original→Patched classification: `fixes`, `passes`, `regression`, `still_failing`, `pre_existing` |
| [recovery.ts](file:///Users/jivitrana/Desktop/Vibron/lib/harness/recovery.ts) | 11.6 KB | **Stuck detection**: same call 3× in last 8, same error twice, 12 turns without edit, oscillating edits. Class-specific hints → forced replan → rollback to best checkpoint |
| [snapshot.ts](file:///Users/jivitrana/Desktop/Vibron/lib/harness/snapshot.ts) | 12.0 KB | Git tree snapshots via temporary index (never touches user's index/branches) |
| [compact.ts](file:///Users/jivitrana/Desktop/Vibron/lib/harness/compact.ts) | 12.9 KB | Context compaction: past 60% window, old tool results elided first; middle summarized only if needed |
| [detect.ts](file:///Users/jivitrana/Desktop/Vibron/lib/verify/detect.ts) | 8.9 KB | Auto-detects test frameworks: pytest, unittest, jest, vitest, node --test, go test, cargo test, maven, gradle, make test + fallbacks (tsc, syntax check, go build, cargo check) |
| [parse.ts](file:///Users/jivitrana/Desktop/Vibron/lib/verify/parse.ts) | 11.4 KB | Per-framework test output parsers: pytest, unittest, go, cargo, TAP, vitest, jest |
| [extract.ts](file:///Users/jivitrana/Desktop/Vibron/lib/verify/extract.ts) | 4.8 KB | **Smart output condensation**: extracts Python tracebacks, pytest E-lines, unittest FAIL blocks, TAP diagnostics, go FAIL, rust panics, jest blocks — never blind head/tail cut |
| [env.ts](file:///Users/jivitrana/Desktop/Vibron/lib/verify/env.ts) | 4.2 KB | Execution environment: venv-first PATH, python→python3 shim, PYTHONPATH, scrubbed secrets, closed stdin |
| [related.ts](file:///Users/jivitrana/Desktop/Vibron/lib/verify/related.ts) | 2.5 KB | Ranks tests for targeted runs using name conventions, graph edges, import mentions |

#### D. Code Graph & Context Engine (`lib/parser.ts`, `lib/lang/`, `lib/context/`)

| File | Size | Purpose |
|:--|:--|:--|
| [parser.ts](file:///Users/jivitrana/Desktop/Vibron/lib/parser.ts) | 20.7 KB | Multi-language symbol extraction + import/call edge linking. JS/TS via Babel; Python, Go, Rust, Java via regex/brace-matchers |
| [lib/lang/extract/index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/lang/extract/index.ts) | 18.6 KB | Language-specific extractors (Python indentation-based, Go/Rust/Java brace-matching) |
| [lib/lang/tsconfig.ts](file:///Users/jivitrana/Desktop/Vibron/lib/lang/tsconfig.ts) | 6.6 KB | TypeScript path alias resolution |
| [context/engine.ts](file:///Users/jivitrana/Desktop/Vibron/lib/context/engine.ts) | 15.2 KB | **Progressive disclosure ladder**: L0 skeleton (~300 tok) → L1 symbol index (1–3k) → L2 graph slice with edges (1–4k) → L2.5 symbol outline (~10% file) → L3 raw file (last resort) |
| [context/ledger.ts](file:///Users/jivitrana/Desktop/Vibron/lib/context/ledger.ts) | 5.1 KB | **Repeat-read deduplication**: every chunk hashed, second request returns pointer, savings measured |
| [retrieval.ts](file:///Users/jivitrana/Desktop/Vibron/lib/retrieval.ts) | 16.8 KB | Graph-based retrieval: BFS from seeds, signatures + bodies |

**Graph persistence & incrementality:**
- Extracts cached per content hash in `.viberon/graph.json`
- On open: only changed files re-parsed
- On write: only that one file re-parsed, graph re-linked from cache
- Tested: write in 41-file workspace parses exactly 1 file

#### E. Memory System (`lib/memory/`)

| File | Size | Purpose |
|:--|:--|:--|
| [graph.ts](file:///Users/jivitrana/Desktop/Vibron/lib/memory/graph.ts) | 17.9 KB | **Graph-anchored memory**: notes/facts/decisions/conventions/fixes anchored to AST node IDs or paths, with content-hash staleness detection |
| [vault.ts](file:///Users/jivitrana/Desktop/Vibron/lib/memory/vault.ts) | 8.7 KB | **Two-way Obsidian vault** sync: `notes/<slug>.md` with frontmatter + `code/<path>.md` stubs. Edits in Obsidian are imported back |
| [index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/memory/index.ts) | 13.2 KB | Legacy store-backed ProjectMemory (UI-editable) |
| [types.ts](file:///Users/jivitrana/Desktop/Vibron/lib/memory/types.ts) | 4.1 KB | Type definitions |

**Key innovation:** Fix notes (`recordFixNote`) anchored to changed files, surfaced by `localize` as `lessons` for future tasks. Wrong lessons can be corrected directly in the Obsidian vault.

#### F. Localization (`lib/localize/`)

| File | Size | Purpose |
|:--|:--|:--|
| [index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/localize/index.ts) | 16.4 KB | **Zero-token fault localization**: traceback frames, paths/symbols in issue, BM25 ranking, test imports, issue's own code run on original tree |
| [snippets.ts](file:///Users/jivitrana/Desktop/Vibron/lib/localize/snippets.ts) | 5.5 KB | Extracts fenced code blocks, doctest sessions, JS from issue text; runs them in `.viberon/scratch/` on untouched tree |

**Key innovation:** Reproduction is free — running the issue's own code on the original tree costs zero model tokens and provides both a failing reproduction and traceback for localization.

#### G. AI Providers (`lib/ai/`)

| File | Purpose |
|:--|:--|
| [anthropic.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/anthropic.ts) | Anthropic client with prompt caching |
| [groq.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/groq.ts) | Groq client |
| [openai-compat.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/openai-compat.ts) | OpenAI-compatible adapter (OpenAI, Gemini, OpenRouter, vLLM, Ollama) |
| [gemini-catalog.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/gemini-catalog.ts) | Google Gemini model catalog |
| [nvidia-catalog.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/nvidia-catalog.ts) | NVIDIA model catalog |
| [textproto.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/textproto.ts) | Text tool protocol fallback (XML/invoke/Hermes/JSON recovery) for models without native tool calls |
| [retry.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/retry.ts) | Retry logic with parameter perturbation |
| [models.ts](file:///Users/jivitrana/Desktop/Vibron/lib/ai/models.ts) | Model tiers and configuration |

#### H. Terminal & Safety (`lib/terminal/`)

| File | Size | Purpose |
|:--|:--|:--|
| [index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/terminal/index.ts) | 15.9 KB | PTY terminal manager |
| [output.ts](file:///Users/jivitrana/Desktop/Vibron/lib/terminal/output.ts) | 8.7 KB | Output processing and truncation |
| [safety.ts](file:///Users/jivitrana/Desktop/Vibron/lib/terminal/safety.ts) | 18.4 KB | **Command safety**: hard-blocked commands (delete outside workspace, format disks, raw devices, piping remote scripts, privilege escalation). Policies: Ask/Auto/Off |

#### I. Review & Delivery Pipeline (`lib/review/`, `lib/deliver/`, `lib/issues/`)

| Module | Purpose |
|:--|:--|
| [review/index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/review/index.ts) | `reviewDiff`, `describeDiff`, `improveDiff` — structured LLM calls with repair retry, self-reflection scoring 0-10 |
| [review/learn.ts](file:///Users/jivitrana/Desktop/Vibron/lib/review/learn.ts) | **Style learning** from past PR comments → convention notes in vault |
| [review/target.ts](file:///Users/jivitrana/Desktop/Vibron/lib/review/target.ts) | Diff target definition including untracked files |
| [deliver/index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/deliver/index.ts) | Branch → commit → push → draft PR. Deduped branch names, refuses changes outside fix files |
| [deliver/ci.ts](file:///Users/jivitrana/Desktop/Vibron/lib/deliver/ci.ts) | CI status watching, Fix CI enqueue, flaky re-run with reason + cap |
| [deliver/report.ts](file:///Users/jivitrana/Desktop/Vibron/lib/deliver/report.ts) | Evidence posting on issues |
| [issues/index.ts](file:///Users/jivitrana/Desktop/Vibron/lib/issues/index.ts) | Issue ingestion → isolated worktree → solve → deliver → report |
| [issues/watch.ts](file:///Users/jivitrana/Desktop/Vibron/lib/issues/watch.ts) | **Auto mode**: polls for trigger-labeled issues, only triage-rights users can label |

#### J. MCP Integration (`lib/mcp/`)

| File | Purpose |
|:--|:--|
| [manager.ts](file:///Users/jivitrana/Desktop/Vibron/lib/mcp/manager.ts) | MCP server lifecycle management |
| [bridge.ts](file:///Users/jivitrana/Desktop/Vibron/lib/mcp/bridge.ts) | MCP↔agent bridge |
| [github.ts](file:///Users/jivitrana/Desktop/Vibron/lib/mcp/github.ts) | GitHub MCP server |
| [config.ts](file:///Users/jivitrana/Desktop/Vibron/lib/mcp/config.ts) | MCP configuration |
| [tools.ts](file:///Users/jivitrana/Desktop/Vibron/lib/mcp/tools.ts) | MCP tool integration |

#### K. Desktop & UI (30 components in `components/vibe/`)

Full IDE experience with:
- `AppShell.tsx` / `IdeShell.tsx` / `ChatShell.tsx` — dual mode with `⌘⇧M` toggle
- `Composer.tsx` — the input area with Fix/Chat modes
- `EditorPane.tsx` — Monaco editor integration
- `FileTree.tsx` — workspace file explorer
- `TerminalPanel.tsx` — integrated terminal
- `MemoryPanel.tsx` — inspectable/editable memory
- `BubbleGraph.tsx` — force-graph AST visualization
- `ChangesPanel.tsx` — per-run change tracking with undo
- `CommandPalette.tsx` — `⌘K` command palette
- `ConversationHistory.tsx` — persistent chat history
- `DeliverBar.tsx` — PR delivery UI
- `DiffView.tsx` — diff viewer
- `IssuesPanel.tsx` — GitHub issues panel
- `ScmPanel.tsx` — source control management
- `SearchPanel.tsx` — workspace search
- `SettingsPage.tsx` — provider configuration
- `EvalView.tsx` — benchmark results viewer
- `CodeReview.tsx` — code review display

#### L. Eval System (`eval/`)

6 benchmark tasks with hidden tests: `config-merge`, `todo-json`, `semver-js`, `slugify`, `inventory-stacktrace`, `truncate-regression`. Results served at `GET /api/eval`.

#### M. Test Suite (`tests/`)

**72 test files** covering: harness (solve, gate, recovery, snapshot, editor, tools, orchestrator, runner, compaction), verify (detect, parse, extract), workspace (clone, graph-persist, write-cost, watcher, search, terminal, command-safety), memory (graph, vault), AI providers (gemini, nvidia, openai), UI components, review, deliver, issues, CLI, MCP, localize, and more.

---

### 1.3 Total Codebase Size

| Category | Files | Estimated LOC |
|:--|:--|:--|
| Core engine (`lib/`) | 63 files across 24 dirs | ~15,000+ |
| UI components | 33 component files | ~8,000+ |
| API routes | 24 route directories | ~5,000+ |
| Tests | 72 test files | ~10,000+ |
| CLI & Eval | 5 files | ~1,500+ |
| **Total** | **~200+ files** | **~40,000+** |

---

## Part 2 — The 12 Best Open-Source Coding Agent Repos

### 2.1 OpenHands (formerly OpenDevin)

> **GitHub:** `All-Hands-AI/OpenHands` · **Stars:** 50k+ · **SWE-bench:** 77.6%

| Feature | Detail |
|:--|:--|
| Architecture | Event-driven Action/Observation loop with EventStream pub/sub hub |
| Execution | **Docker-sandboxed runtime** — each agent runs in its own container |
| Tools | `CmdRunAction`, `FileWriteAction`, `FileReadAction`, `BrowseURLAction` |
| Multi-agent | Supports multi-agent delegation; Agent Canvas for managing backends |
| Model support | LiteLLM — 75+ providers |
| Memory | Session-based; limited cross-session memory |
| Verification | Agent-driven (no harness-controlled gate) |
| Key innovation | Full autonomy with sandboxed safety; web browsing capability |

**What Viberon can learn:**
- ✅ **Docker/container sandboxing** for untrusted code execution
- ✅ **Web browsing capability** for agents to research documentation, APIs
- ✅ **EventStream pub/sub** pattern for better decoupling

---

### 2.2 SWE-agent / mini-swe-agent (Princeton NLP)

> **GitHub:** `SWE-agent/SWE-agent` · **Stars:** 15k+ · **SWE-bench:** ~74%

| Feature | Detail |
|:--|:--|
| Core concept | **Agent-Computer Interface (ACI)** — purpose-built commands replace raw shell |
| Principles | Simplicity, compactness, information density, error prevention |
| Evolution | Original superseded by **mini-swe-agent** (~100 lines of Python, `subprocess.run`) |
| Tools | Custom file viewer with scrolling, `edit` command with syntax validation |
| Key insight | Interface design matters as much as the model — LLMs need structured, compact feedback |

**What Viberon can learn:**
- ✅ Already implements ACI principles (tolerant editor, progressive disclosure)
- 🔍 **Radical minimalism** — mini-swe-agent proves ~100 lines can match complex frameworks. Consider a minimal headless mode
- ✅ Viberon's lint gate on edits matches SWE-agent's syntax validation

---

### 2.3 Aider

> **GitHub:** `paul-gauthier/aider` · **Stars:** 30k+

| Feature | Detail |
|:--|:--|
| Core concept | **Repository map** via tree-sitter — structural awareness without loading all files |
| Architect/Editor mode | Reasoning model plans, faster model implements edits |
| Git integration | Every edit auto-committed; easy review/revert |
| Edit formats | Whole-file, diff, search/replace — adapts to model capability |
| Linting/testing | Auto-runs linters/tests after changes; feeds errors back |
| Voice coding | Supports voice input for pair programming |

**What Viberon can learn:**
- ✅ Viberon's graph engine is more sophisticated than Aider's repo map
- 🔍 **Architect/Editor dual-model mode** — use a powerful reasoning model for planning + cheaper model for mechanical edits (Viberon has model tiers per role but could be more explicit)
- 🔍 **Voice input** for the chat interface
- 🔍 **Multiple edit format strategies** that adapt to which model is being used

---

### 2.4 Cline

> **GitHub:** `cline/cline` · **Stars:** 25k+

| Feature | Detail |
|:--|:--|
| Architecture | **ReAct loop** (Reason-Act-Observe) with structured phases |
| Human-in-the-loop | Every file mutation and command requires explicit approval |
| MCP Marketplace | Discover and install MCP integrations |
| Plan & Act modes | Plan mode for alignment, Act mode for execution |
| Memory Bank | `.clinerules` files + Memory Bank for cross-session persistence |
| Checkpoints | Automatic project state snapshots for safe rollback |
| SDK | `@cline/sdk` for building custom agents |

**What Viberon can learn:**
- 🔍 **MCP Marketplace** — a discovery/install system for tool integrations
- 🔍 **SDK for embedding** — allow third parties to build on Viberon's engine
- ✅ Viberon already has checkpoints, memory, and plan/act separation
- 🔍 **`.clinerules`-style project configuration** — Viberon has rules.ts but could be more developer-facing

---

### 2.5 Claude Code (Anthropic)

> **Proprietary but heavily influential**

| Feature | Detail |
|:--|:--|
| Tools | Bash, file read/create/edit, grep-based search |
| Memory | `CLAUDE.md` project file + session persistence + context compaction (`/compact`) |
| Permissions | Tiered approval model — per-session and global |
| Hooks | Pre/post-tool hooks for custom integrations |
| Projects | Coordinator-worker architecture for multi-task management |
| Key insight | Simple tools (bash + editor) with strong prompting beats complex tool suites |

**What Viberon can learn:**
- 🔍 **Pre/post-tool hooks** — let users inject custom logic before/after tool calls
- 🔍 **`/compact` command** — user-triggered context summarization (Viberon has automatic compaction but no manual trigger)
- ✅ Viberon already matches or exceeds Claude Code on memory, verification, and multi-agent

---

### 2.6 OpenAI Codex CLI

> **GitHub:** `openai/codex` · **License:** Apache 2.0

| Feature | Detail |
|:--|:--|
| Sandboxing | **Native system-level sandboxing** (not Docker) — restricts file/command access |
| Cloud execution | Ephemeral containers/micro-VMs preloaded with repo |
| Integration | GitHub, GitLab, Bitbucket; CI/CD via `openai/codex-action` |
| API | Agents API for building custom cloud agents |

**What Viberon can learn:**
- 🔍 **System-level sandboxing** without Docker — lighter weight for desktop use
- 🔍 **GitHub Action** for CI/CD integration (`viberon-action`)
- 🔍 **Agents API** — expose Viberon's engine as a programmable API

---

### 2.7 OpenCode (Anomaly/SST)

> **GitHub:** `anomalyco/opencode` · **Stars:** 200k+ · **Built with:** TypeScript + Bun

| Feature | Detail |
|:--|:--|
| TUI | Polished terminal UI via Bubble Tea |
| Dual agents | Build agent (writes) + Plan agent (read-only analysis) |
| LSP integration | Loads Language Server Protocol diagnostics for compiler-level feedback |
| Multi-session | Multiple agent sessions simultaneously on one project |
| MCP | Native MCP support |
| Persistence | Local SQLite for session history |
| Git undo | Every change snapshotted; `/undo` command |
| `/init` | Analyzes project → generates `AGENTS.md` file |

**What Viberon can learn:**
- 🔍 **LSP integration** — feed real compiler diagnostics/type errors to the model instead of just lint gates
- 🔍 **Multi-session support** — run multiple agent sessions on one project simultaneously
- 🔍 **`/init` auto-analysis** — automatically generate project understanding docs
- 🔍 **SQLite persistence** — more robust than JSON files for session/run history

---

### 2.8 Goose (Block → Linux Foundation AAIF)

> **GitHub:** `block/goose` · **License:** Apache 2.0

| Feature | Detail |
|:--|:--|
| MCP-first | Built entirely around Model Context Protocol — 70+ extensions |
| Recipes | Shareable YAML-based multi-step automation packages |
| Multi-interface | Desktop app, CLI, API |
| Provider neutral | 15+ LLM providers |
| Governance | Linux Foundation Agentic AI Foundation |

**What Viberon can learn:**
- 🔍 **Shareable recipes** — package repeatable multi-step workflows as YAML
- 🔍 **Extension ecosystem** — MCP-based plugin marketplace with 70+ integrations
- 🔍 **YAML-based automation** — let users define reusable fix/deploy/test workflows

---

### 2.9 PR-Agent (Qodo/CodiumAI)

> **GitHub:** `Codium-ai/pr-agent` · **Stars:** 10k+

| Feature | Detail |
|:--|:--|
| Commands | `/review`, `/describe`, `/improve`, `/ask`, `/changelog` |
| Chunking | Adaptive, token-aware file patch fitting for large PRs |
| Multi-platform | GitHub, GitLab, Bitbucket, Azure DevOps |
| Self-reflection | Scores suggestions 0–10; discards those not in the diff |
| Integration | CLI, GitHub Action, webhook bot |

**What Viberon can learn:**
- ✅ Viberon already borrowed PR-Agent's review + self-reflection pattern
- 🔍 **Multi-platform git support** — GitLab and Bitbucket, not just GitHub
- 🔍 **Adaptive token-aware diff chunking** for very large PRs
- 🔍 **`/changelog` generation** from diffs

---

### 2.10 Plandex

> **GitHub:** `plandex-ai/plandex`

| Feature | Detail |
|:--|:--|
| Sandboxed changes | Diff review sandbox — changes accumulated before applying |
| Version control | Entire plan (context + conversation + settings) is versioned; `plandex rewind` |
| Branching | Git-style branching within sandbox for experiments |
| Large context | 2M token effective window; tree-sitter project maps |
| Full auto | End-to-end execution including auto-debugging |

**What Viberon can learn:**
- 🔍 **Plan versioning** — version the entire plan (context + conversation + model settings), not just file snapshots
- 🔍 **Experiment branching** — try multiple approaches in parallel sandbox branches, compare results
- ✅ Viberon already has checkpoints but could add plan-level versioning

---

### 2.11 Bolt.diy (Community fork of StackBlitz Bolt)

> **GitHub:** `stackblitz-labs/bolt.diy` · **License:** MIT

| Feature | Detail |
|:--|:--|
| In-browser execution | StackBlitz WebContainers — full Node.js in browser |
| Zero setup | No local install needed; browser-based IDE |
| Full-stack | Built-in auth, database, server functions, hosting |
| BYOLLM | Any LLM provider (OpenAI, Anthropic, Ollama, etc.) |

**What Viberon can learn:**
- 🔍 **Browser-based execution** — WebContainers for a zero-install web version
- 🔍 **Built-in hosting/deployment** — one-click deploy after the agent finishes
- 🔍 **Zero-setup onboarding** — no local install for trying Viberon

---

### 2.12 E2B (Code Execution Infrastructure)

> **GitHub:** `e2b-dev/E2B` · **License:** Apache 2.0

| Feature | Detail |
|:--|:--|
| Isolation | **Firecracker microVMs** — hardware-level isolation, not just container namespaces |
| Boot time | ~150ms sandbox startup |
| Lifecycle | Pause, resume, snapshot sessions |
| SDKs | Python & TypeScript |
| Security | Network egress policies, scoped secrets, SOC 2 Type II |
| MCP | Docker MCP catalog integration (200+ tools) |

**What Viberon can learn:**
- 🔍 **Firecracker microVM sandboxing** — strongest isolation for untrusted code
- 🔍 **Session pause/resume/snapshot** — save agent state, resume later
- 🔍 **Network egress control** — fine-grained control over what agents can access
- 🔍 **BYOC (Bring Your Own Cloud)** — enterprise deployment model

---

## Part 3 — Gap Analysis: What Viberon is Missing

### 🟢 Viberon's Unique Strengths (Already Best-in-Class)

| Capability | Status | Who else does it |
|:--|:--|:--|
| Graph-native progressive disclosure (L0→L3) | ✅ Industry-leading | Only Aider (tree-sitter map) comes close; Viberon's is richer |
| Triple token-saving (graph + dedupe + cache) | ✅ Unique combination | No one else measures all three |
| Harness-controlled verification gate | ✅ Best implementation | OpenHands/SWE-agent rely on agent self-report |
| Multi-agent with strict file write-locks | ✅ Unique safety | OpenHands has delegation but no file locks |
| Graph-anchored memory with staleness | ✅ Unique | Cline has Memory Bank but no code-anchoring |
| Zero-token fault localization | ✅ Unique | No other tool runs issue code for free |
| Two-way Obsidian vault sync | ✅ Unique | No equivalent in any competitor |
| Tolerant editor with lint gate | ✅ Best implementation | SWE-agent has syntax check; Viberon's is richer |
| Evidence bundle (result.json + trajectory + patch + report) | ✅ Unique thoroughness | Most tools just produce diffs |
| Smart output condensation (not head/tail) | ✅ Unique | Others do blind truncation |

### 🟡 Gaps — High Priority (would significantly improve Viberon)

| Gap | Who Has It | Implementation Effort | Impact |
|:--|:--|:--|:--|
| **Sandboxed code execution** (Docker/microVM) | OpenHands, E2B, Codex | High | Critical for security with untrusted repos |
| **LSP integration** (real compiler diagnostics) | OpenCode | Medium | Dramatically improves edit accuracy |
| **Multi-session support** | OpenCode | Medium | Power users want parallel agent sessions |
| **Multi-platform git** (GitLab, Bitbucket) | PR-Agent, Codex | Medium | Expands market reach significantly |
| **Web browsing** for agents | OpenHands, Cline | Medium | Agents need to read docs, APIs, Stack Overflow |
| **GitHub Action / CI integration** | Codex, PR-Agent | Low-Medium | Enables headless CI/CD pipelines |
| **Shareable recipes/workflows** | Goose | Low-Medium | Reusable automation packages |

### 🟠 Gaps — Medium Priority (nice to have, competitive advantage)

| Gap | Who Has It | Implementation Effort | Impact |
|:--|:--|:--|:--|
| **SDK / embeddable engine** | Cline (`@cline/sdk`) | Medium | Third-party ecosystem |
| **Plan versioning & experiment branching** | Plandex | Medium | Better experimentation UX |
| **Session pause/resume/snapshot** | E2B | Medium | Long-running task management |
| **Architect/Editor dual-model explicit mode** | Aider | Low | Cost optimization per step |
| **`/init` auto-analysis** | OpenCode | Low | Better onboarding UX |
| **Network egress control** | E2B | Low-Medium | Enterprise security requirement |
| **MCP marketplace / discovery** | Cline, Goose | Medium | Extension ecosystem |
| **SQLite persistence** (vs JSON files) | OpenCode | Low-Medium | More robust data layer |
| **Pre/post-tool hooks** | Claude Code | Low | Custom integration points |
| **Voice input** | Aider | Low | Accessibility and convenience |

### 🔵 Gaps — Low Priority (future vision)

| Gap | Who Has It | Notes |
|:--|:--|:--|
| **Browser-based mode** (WebContainers) | Bolt.diy | Zero-install trial mode |
| **One-click deploy** | Bolt.new | Post-fix deployment |
| **Firecracker microVMs** | E2B | Strongest isolation |
| **BYOC enterprise deployment** | E2B | Enterprise offering |
| **Changelog generation** | PR-Agent | Nice convenience feature |

---

## Part 4 — Recommended Roadmap

### Phase 1: Harden the Core (Weeks 1–3)
1. **Docker sandbox mode** — containerized execution for headless runs on untrusted repos
2. **LSP integration** — feed TypeScript/Python language server diagnostics into the agent loop
3. **GitHub Action** — `viberon-action` for CI/CD integration

### Phase 2: Expand Reach (Weeks 4–6)
4. **Multi-platform git** — GitLab and Bitbucket support in deliver and issues modules
5. **Web browsing tool** — let agents fetch documentation and API references
6. **Multi-session support** — run multiple independent agent sessions per workspace

### Phase 3: Ecosystem & Polish (Weeks 7–10)
7. **Shareable recipes** — YAML-based reusable workflow definitions
8. **MCP marketplace** — browse and install MCP tool integrations from the UI
9. **SDK** — embeddable Viberon engine for third-party tools
10. **Plan versioning** — version control the entire plan state, enable experiment branching

### Phase 4: Enterprise & Scale (Weeks 11+)
11. **Session pause/resume** — save and restore long-running agent state
12. **Network egress control** — restrict agent network access for security
13. **SQLite persistence** — replace JSON files with structured storage
14. **Pre/post-tool hooks** — user-defined custom logic at tool boundaries
15. **Browser-based trial mode** — WebContainer-powered zero-install demo

---

## Part 5 — Summary Scorecard

| Dimension | Viberon | OpenHands | SWE-agent | Aider | Cline | OpenCode | Claude Code |
|:--|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| Code graph / context | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ |
| Token efficiency | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Verification/testing | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Multi-agent | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Persistent memory | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐ |
| Sandboxing/security | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| IDE experience | ⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ |
| Ecosystem/plugins | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Ship loop (PR/CI) | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐⭐ |
| Model support | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| Eval/benchmarking | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | ⭐⭐ | ⭐⭐ | ⭐⭐ |

---

> **Bottom line:** Viberon is already the most sophisticated open-source coding harness in terms of code understanding (graph engine), token efficiency (triple savings), verification rigor (harness-controlled gate), and multi-agent safety (file locks). The biggest gaps are **sandboxed execution**, **LSP integration**, **web browsing**, and **ecosystem/plugin infrastructure**. Closing these gaps would make Viberon not just competitive but category-defining.
