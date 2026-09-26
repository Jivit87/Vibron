# MCP Marketplace (Task 3.2)

## Problem

Viberon already speaks MCP (`lib/mcp/`): it reads `.mcp.json`-style configs, pools
connections, bridges tools into the agent loop as `mcp__<server>__<tool>`, and
gates untrusted calls through the approval prompt. Adding a server still meant
knowing its package name, its launch command and its environment variables, then
hand-writing a config that held API keys in plain text. The marketplace makes
the common servers one form away, without weakening any of those guarantees.

## Design

```
catalog.json (bundled, reviewed) ─┐
remote registry (optional, https) ─┴─> loadCatalog ──> planInstall ──> installServer
                                                        (preview)      (confirmed)
                                                                           │
             credentials store  <── secret values ─────────────────────────┤
             global MCP config  <── entry with ${secret:NAME} references ──┘
                                                                           │
             MCP manager: at launch, resolve ${secret:NAME} for global servers only
```

| Piece | File |
|---|---|
| Catalog (20 servers) | `lib/mcp/catalog.json` |
| Schema validation, registry fetch, merge | `lib/mcp/catalog.ts` |
| Types and search (browser-safe) | `lib/mcp/catalog-search.ts` |
| Plan, install, uninstall, toggle, test | `lib/mcp/marketplace.ts` |
| Secret storage | `lib/ai/credentials.ts` (`getMcpSecret`, `setMcpSecret`, `mcpSecretStatus`) |
| Secret references | `lib/mcp/config.ts` (`secretRefs`, `expandSecretRefs`), `lib/mcp/manager.ts` |
| API routes | `app/api/mcp/marketplace/**` |
| UI | `components/vibe/McpMarketplace.tsx`, Settings > MCP Marketplace |
| CLI | `cli/mcp.ts`, `bin/viberon mcp …` |

**An install is an ordinary MCP config entry.** It goes into the same user-global
server list the GitHub integration and the MCP settings write, tagged with
`catalogId`. Pooling, the approval prompt, role filtering (read-only roles see
only read-only tools) and tool naming all come from the existing layer unchanged.
A project `.mcp.json` can still shadow it by name.

**Catalog entries are templates.** Each entry declares `fields` (env var name,
label, `secret`, `required`, optional `default`, and `inject: "env" | "template"`).
`{{NAME}}` placeholders in `args` and `headers` are filled at install time.
Non-secret values are written in literally. Secret values become
`${secret:NAME}`. A template that names an optional field left empty is dropped
whole, so an optional `--flag={{X}}` or header disappears instead of going out
empty.

**Secrets live in the credentials store**, under `credential:mcp:<server>:<NAME>`,
next to the provider keys. The config only ever holds the reference. At launch,
the manager expands `${VAR}` against the environment first and resolves
`${secret:NAME}` second, so a secret value that happens to contain `${…}` is never
itself expanded. References are scoped to the server that contains them, and only
servers from the user's global list may resolve them.

**Installing is two-step.** `planInstall` (`dryRun: true` over HTTP) returns
exactly what will run: the command line, args, env (secrets masked), which
variables are inherited, and warnings. Warnings cover npx/uvx/docker download on
each launch, unpinned versions, secrets passed as argv (visible in `ps`),
community trust, and registry origin. The plan carries `planHash`, a hash of the
config entry it would write. `installServer` refuses unless `confirm: true` and
the hash match what it computes now. The user therefore installs exactly what they
reviewed: change a value, or have the registry change the entry, and the install
is refused with `plan-changed`.

**Test connection** starts the installed server under a throwaway pool scope,
lists its tools and tears it down. It works even while the server is disabled.
The whole call is bounded by a timeout (default 30s, max 120s over HTTP). If the
timeout fires first, the result says so, and the probe is disconnected when the
stalled connect settles, so no child process is left behind. Stored secret values
are scrubbed from the returned log lines and error.

**Remote registry (optional).** The URL comes from Settings (stored as
`mcp:marketplace:registry-url`), then `VIBERON_MCP_REGISTRY_URL`, and is off by
default. The fetch is https-only with `redirect: "error"` (a redirect could
leave https), a 5s timeout and a 512 KB cap. The cap is checked against
`content-length` and enforced while streaming. Validation is per entry, so one
bad entry drops only itself. Registry entries cannot shadow bundled ids, and are
always shown as `community`. Successful fetches are cached for 10 minutes;
failures are not cached. Any failure falls back to the bundled catalog and
reports why.

## Catalog

filesystem, fetch, git, memory, sequential-thinking, time, everything, postgres,
sqlite, playwright, brave-search, slack, sentry, linear, notion, context7
(HTTP), aws-documentation, supabase, firecrawl, exa.

Trust tiers: `official` means the entry is published by the MCP project or the
service's own vendor. `community` means a third party, such as the `mcp-remote`
bridge used for Linear's OAuth-only endpoint, and every registry entry.

Catalog entries may only launch `npx`, `uvx` or `docker`, or connect to a
literal https URL. Placeholders are forbidden in URLs, so secrets stay out of
logs and proxies. Anything else needs a hand-written config.

## Usage

**UI:** Settings > MCP Marketplace.
1. Search or filter by category, then open a server.
2. Fill in its fields. Stored secrets show as a masked placeholder; leaving one
   empty keeps it.
3. Click **Review install** to see the plan, tick the confirmation, then click
   **Install**.
4. Once installed, the same view offers Enable, Test connection and Remove.
   Remove also deletes the server's stored secrets.

Set the remote registry URL at the bottom of the section.

**API:**

| Route | Body | Result |
|---|---|---|
| `GET /api/mcp/marketplace[?refresh=1]` | | `{ entries, categories, installed, registry }` |
| `PUT /api/mcp/marketplace` | `{ registryUrl }` (`""` clears) | registry status |
| `POST /api/mcp/marketplace/install` | `{ id, values, dryRun: true }` | `{ plan }` |
| `POST /api/mcp/marketplace/install` | `{ id, values, confirm: true, planHash }` | `{ server }`; 409 `plan-changed` / `conflict` |
| `POST /api/mcp/marketplace/uninstall` | `{ name }` | `{ ok }` |
| `POST /api/mcp/marketplace/toggle` | `{ name, enabled }` | `{ server }` |
| `POST /api/mcp/marketplace/test` | `{ name, repoKey?, timeoutMs? }` | `{ ok, tools, error?, timedOut?, logs }` |

**CLI:**

```bash
viberon mcp list [--installed] [--category databases] [--json]
viberon mcp search "web search"
BRAVE_API_KEY=… viberon mcp install brave-search      # prints the plan, asks to confirm
viberon mcp install sqlite --set DB_PATH=./app.db --yes
viberon mcp test brave-search --timeout 60
viberon mcp disable brave-search
viberon mcp remove brave-search
```

Install values come from `--set NAME=value`, then an environment variable with
the field's name, then an interactive prompt (hidden input for secrets). Prefer
the environment or the prompt for secrets, because `--set` lands in shell
history. Without `--yes`, install asks for confirmation. When stdin is not a
terminal, it refuses rather than assume consent.

`viberon mcp` uses the persistent store rather than the in-memory store the
other headless commands use. That store is the repo root's
`.viberon-dev-store.json`, or `VIBERON_STORE_DIR`. Point `VIBERON_STORE_DIR` at
the Electron user-data folder to manage the desktop app's servers.

## Security considerations

- **No secret leaves the server.** Secret values are write-only from the
  browser's point of view. Plans, installed summaries, test results and the
  generic `/api/mcp` listing contain only `${secret:NAME}` references or masked
  fingerprints (`••••1234`, only for values of 16+ characters). Tests assert this
  for every route.
- **No secret sits in config.** The global config holds references. Uninstalling
  deletes the stored secrets. So does removing a marketplace server through the
  generic MCP settings.
- **Repo files cannot read secrets.** A workspace `.mcp.json` that names
  `${secret:…}` resolves to nothing, and the server log says why.
- **Explicit, hash-bound consent.** Nothing is written without `confirm: true`
  and a matching `planHash`. The CLI never installs non-interactively without
  `--yes`.
- **Least environment.** stdio servers get the MCP SDK's minimal inherited
  environment (`HOME`, `PATH`, `SHELL`, …) plus their own fields, never provider
  API keys. The plan shows this.
- **New servers are untrusted.** Every tool call goes through the approval
  prompt under the "Ask" policy until the user marks the server trusted.
  Reinstalling keeps an existing trust decision.
- **Supply chain.** `npx`/`uvx` fetch the package at launch, and most entries
  float to the latest release. The plan warns about both. Pin a version by
  editing the config if you need reproducibility.
- **Argv exposure.** The PostgreSQL server only accepts its connection string
  as an argument, so it is visible in the process list. The plan says so; use a
  read-only role.
- **Plain values are sanitized.** Values with control characters or `${` are
  rejected, so a field cannot smuggle an environment expansion into the config.

## Trade-offs and limits

- The credentials store is the app's local store (a JSON file or Firestore), the
  same as for provider keys. It is not an OS keychain.
- OAuth-only hosted servers (Linear, Sentry's hosted endpoint) are not supported
  natively. Linear goes through `mcp-remote`, which runs its own browser sign-in.
- The catalog pins no versions. Freshness was preferred, and the plan warns
  about it.
- A stored optional secret can be replaced but not cleared on its own. Remove
  and reinstall the server to drop it.
- Installs are user-global. Per-workspace installs still go through
  `.viberon/mcp.json` by hand or through the existing MCP settings.
