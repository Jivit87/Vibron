# Network Egress Control

Task 4.2. One policy decides where Viberon, and everything it starts, can
reach on the network.

## Problem

Network access used to be decided in five places, each with its own idea of
"allowed":

| Subsystem | Before |
|---|---|
| `lib/browse` | an optional `allowedDomains` list that the tool never actually passed; redirects followed blindly; no SSRF guard |
| `lib/sandbox` | `network: "restricted"` became a plain bridge network, and the registry list it carried was never enforced |
| `lib/terminal` | the classifier blocked `curl … \| sh` but had no notion of *where* a command connects |
| `lib/mcp` | remote servers connected to any URL |
| `lib/ai` | provider calls, which must keep working whatever else is locked down |

An enterprise needs to be able to say "only our registries and GitHub",
"nothing at all", or "anything except these hosts", see the effect in one
place, and have a record of what was allowed and refused.

## Design

Everything lives in `lib/egress/`:

| File | Role |
|---|---|
| `policy.ts` | data model, validation, global/workspace merge, `evaluateHost`, `checkAddress` (SSRF) |
| `rules.ts`, `host.ts`, `ip.ts` | pattern syntax, host normalization, IPv4/IPv6/CIDR parsing and classification |
| `presets.ts` | named host bundles (pure data, shared with the UI) |
| `fetch.ts` | `egressFetch`: a policy-checked fetch that re-checks every redirect hop |
| `command.ts` | best-effort network intent in shell commands |
| `sandbox.ts` | Docker network settings derived from the policy |
| `proxy.ts` | a policy-enforcing HTTP/CONNECT proxy for processes Viberon spawns |
| `audit.ts` | the append-only JSONL audit log |
| `settings.ts` | storage in the settings store, `VIBERON_EGRESS_MODE` |
| `index.ts` | `checkCommandEgress`, `prepareProcessEgress`, `checkServiceUrl` |

### Modes

| Mode | Meaning |
|---|---|
| `open` (default) | everything is reachable except hosts matched by a deny rule |
| `allowlist` | only enabled presets and allow rules; everything else is refused |
| `deny` | nothing is reachable (allow rules and presets are ignored; a kill switch) |

The default is `open` so installing Viberon does not silently break
`npm install`. The presets are pre-selected, so switching to allowlist is
one click.

### Rules

Each rule is `allow` or `deny` plus a pattern:

```
example.com            that host, any port
example.com:8443       that host, port 8443 only
*.example.com          subdomains at any depth, NOT example.com itself
203.0.113.7[:port]     an IPv4 literal
[2001:db8::1][:port]   an IPv6 literal (bare 2001:db8::1 without a port)
10.0.0.0/8, fd00::/8   a CIDR range
*                      every host
https://example.com    a pasted URL: its host, and its port only if written
```

Hosts in rules and in requests go through the same normalization: lowercase,
IDN → punycode (`münchen.de` = `xn--mnchen-3ya.de`), trailing dots
stripped, IPv4 number forms folded (`0x7f.1`, `2130706433` = `127.0.0.1`),
IPv6 compressed, and IPv4-mapped IPv6 (`::ffff:10.0.0.1`) matched by IPv4
rules. Spelling a host differently does not get around a rule.

### Presets

`packageRegistries` (npm, PyPI, crates.io, Go proxy, Maven, RubyGems,
Packagist, NuGet), `docs` (MDN, language docs, Stack Overflow, the web
search endpoint), `gitHosts` (GitHub, GitLab, Bitbucket), `aiProviders`
(all known model APIs). Presets apply in allowlist mode only.

### Decision order

For one destination and one source subsystem:

1. the harness's own model-provider call to a configured provider host → **allow** (`implicit:provider`)
2. a deny rule from any scope matches → **deny**
3. mode `deny` → **deny**
4. a user allow rule matches → **allow**
5. mode `allowlist`: an enabled preset matches → **allow**, else **deny**
6. mode `open` → **allow**

### Scope and precedence

The global policy is stored under `egress:global` and a per-workspace
override under `egress:workspace:<repoKey>`, in the same settings store as
provider keys and MCP servers. A workspace override may set `mode`,
`presets` and `offPolicyCommands` (unset = inherit) and adds its own rules.

- **The workspace wins** on mode, presets and the off-policy command setting.
- **Rules from both scopes apply together, and deny beats allow.** A
  workspace can narrow what the global policy allows, but it cannot re-open a
  host the global policy denies. This is deliberate: an administrator's
  global deny is not something a project can undo.
- `VIBERON_EGRESS_MODE` (set by the CLI's `--egress`) pins the mode for the
  whole process, over both scopes.

### Implicit provider hosts

The hosts of the model providers in use (a saved or environment credential,
or `AI_BASE_URL`) are always allowed for the harness's own model calls, in
every mode, so a strict policy cannot cut the agent off from its model. The
Settings page lists them under "Always allowed for model calls". This
exemption is only for source `provider`: a sandboxed script or the browse
tool gets no implicit access to `api.anthropic.com`. Model calls are not
routed through the policy or logged (it would be one line per turn); the
exemption is what makes that safe to state.

## Enforcement

### Web browsing (`lib/browse`)

`browseUrl` and `searchWeb` fetch through `egressFetch`:

- The host is decided before the request.
- Redirects are followed by hand (`redirect: "manual"`, at most 5). Every
  `Location` is resolved against the current URL and goes through the same
  check; a redirect to a disallowed host is refused and never requested. 303
  (and 301/302 after a POST) becomes a GET without a body.
- **SSRF guard.** The hostname is resolved and every address is checked.
  Loopback, private (RFC 1918, CGNAT, ULA), link-local and reserved addresses
  are refused unless a user rule names the host (exact or wildcard) or covers
  the address (IP or CIDR). Cloud metadata endpoints (169.254.169.254,
  169.254.170.2, fd00:ec2::254, 100.100.100.200, 168.63.129.16, and names
  like `metadata.google.internal`) need an allow rule for that exact IP (or
  exact hostname); a range or wildcard is not enough. A name with one public
  and one private address counts as private. DNS failure refuses.
- Only `http` and `https`.

The refusal the agent sees names the rule and, after redirects, the hop
chain.

### Shell commands (`lib/terminal`, the `run_command` and `compare` tools)

**This is best effort, and the docs say so on purpose.** `command.ts` reads
the command *text* and recognises the common ways it reaches the network:
`curl`/`wget`/`httpie` URLs (and `-x` proxies); `git clone/fetch/pull/push/ls-remote`
(named remotes are resolved from `.git/config`); package installs for npm,
pnpm, yarn, bun, npx, pip (`-i`/`--index-url` respected), uv, poetry, cargo,
go, gem, bundler, composer; `docker pull/push/login`; `ssh`, `scp`, `rsync`,
`sftp`, `nc`, `telnet`, `socat`. It looks through `env`/`timeout`/`nice`
wrappers, `&&`/`;`/`|` chains and `bash -c "…"`.

It cannot see what a Makefile, a `postinstall` script, `python -c` or a
compiled binary does once it runs. **The sandbox and the egress proxy are the
boundary for arbitrary processes; the command check exists so the obvious
cases get a clear refusal or an approval prompt before anything runs, and
land in the audit log.**

Outcome per command:

| Mode | Known host allowed | Known host off-list | Denied by rule | Host unknown (`curl $URL`, `git fetch --all`) |
|---|---|---|---|---|
| open | run | run | **block** | run |
| allowlist | run | **ask** (or block) | **block** | **ask** (or block) |
| deny | **block** | **block** | **block** | **block** |

"Ask" forces a human approval **even under the Auto command policy**; with
no one to approve (headless runs, repo bootstrap) it refuses. The
`offPolicyCommands: "block"` setting turns every "ask" into a refusal.
Commands to this machine (`localhost`, `127.0.0.0/8`, `::1`) are not egress.
An approval also opens exactly those hosts in the egress proxy for that one
command. Commands a person types into the terminal panel are treated as
approved (they typed them) but still refused on "block", and logged.

### Processes: the egress proxy and the sandbox

When the policy restricts anything (mode not `open`, or any deny rule),
`prepareProcessEgress` starts a local forward proxy (`proxy.ts`) once per
server process and hands spawned commands `HTTP_PROXY`/`HTTPS_PROXY`/
`ALL_PROXY` (and the lowercase and npm spellings) pointing at it, with
`NO_PROXY` for localhost. The proxy:

- authenticates each client with a random per-(workspace, source) token in
  the proxy URL, so it knows whose policy to apply and other local processes
  cannot use it;
- decides every CONNECT / request with the same rules and SSRF guard, and
  logs it;
- connects upstream to the **address it checked**, so DNS rebinding cannot
  swap the destination;
- tunnels TLS without intercepting it (it sees host and port only);
- listens on `127.0.0.1` unless `VIBERON_EGRESS_PROXY_HOST` says otherwise.

The Docker sandbox derives its network from the policy (`sandbox.ts`):

| Mode | Container network | Proxy |
|---|---|---|
| deny | `--network none` (hard boundary) | – |
| allowlist | bridge | `HTTP(S)_PROXY=http://viberon:<token>@host.docker.internal:<port>` |
| open | bridge | only if there are deny rules |

An explicit `sandbox.network` can only make this stricter. On Linux the
container gets `--add-host host.docker.internal:host-gateway`, and the proxy
must listen where the container can reach it: set
`VIBERON_EGRESS_PROXY_HOST` to the docker0 gateway (usually `172.17.0.1`).
Docker Desktop (macOS/Windows) forwards `host.docker.internal` to the host's
loopback, so the default works there.

Honest limits: proxy variables are a convention. npm, pip, cargo, go, git,
curl and wget honour them; a program that opens raw sockets does not. In
`deny` mode the sandbox is a hard boundary (no network interface). In
`allowlist` mode a sandboxed process that ignores the proxy can still reach
the internet over the bridge; closing that needs an internal Docker network
with the proxy as the only gateway, which is a follow-up. Without the
sandbox, commands run on the host with only the proxy variables and the
command check between them and the network.

### MCP servers (`lib/mcp`)

Before connecting to a remote (HTTP/SSE) server, the expanded URL is checked
with source `mcp`; a refused server shows the policy reason as its error.
Servers on this machine are always allowed. A stdio server is a local process
the user enabled; its own network traffic is outside what Viberon can see.

### Model providers (`lib/ai`)

Unchanged: see "Implicit provider hosts".

## Audit log

Append-only JSON Lines at `<workspace>/.viberon/egress.log` (without a
workspace folder: `$VIBERON_STORE_DIR` or the server's cwd). One line per
decision:

```json
{"ts":"2026-09-27T10:12:03.114Z","host":"evil.test","port":443,"decision":"deny",
 "source":"browse","rule":"deny *.evil.test (global)","reason":"…",
 "url":"https://x.evil.test/a","repoKey":"…"}
```

`decision` is `allow`, `deny` or `ask`; `source` is `browse`, `terminal`,
`sandbox` or `mcp`; `rule` names what decided (`mode:allowlist`,
`preset:docs (…)`, `ssrf:metadata`, `… → approved by user`, a `[proxy]`
suffix for proxy decisions). URLs are logged without query string and
fragment (where tokens live) and commands are truncated to 300 characters.
Writes use `O_APPEND` and are serialized per file; past 5 MB the file is
rotated to `egress.log.1`. Nothing edits or deletes lines, and no API route
can. `VIBERON_EGRESS_AUDIT=off` disables logging.

## Using it

**Settings → Network** shows the mode in force and where it came from, the
sandbox network it implies, the implicitly allowed provider hosts, and any
stored rule that failed to parse. Edit the policy for all workspaces or for
this workspace (mode, presets, off-allowlist commands, allow/deny rules),
dry-run a URL or a command against the saved policy, and browse the recent
decisions (filterable to blocked only).

API:

| Route | |
|---|---|
| `GET /api/settings/egress?repoKey=…` | global and workspace policy, effective merge, provider hosts, presets, sandbox plan |
| `PUT /api/settings/egress` | `{scope:"global", policy}` or `{scope:"workspace", repoKey, policy \| null}` (null clears the override) |
| `POST /api/settings/egress` | `{action:"test", repoKey, url \| command}`: dry run, not logged |
| `GET /api/settings/egress/log?repoKey=…&limit=&decision=&source=` | recent audit entries, newest first |

CLI: `viberon run|issues|clone|eval --egress <open|allowlist|deny>`
(equivalent to `VIBERON_EGRESS_MODE`). With the stored presets, `--egress
allowlist` lets a headless run install packages and clone from git hosts but
nothing else, and refuses (rather than asks about) anything off the list.

## Key decisions and trade-offs

- **Deny beats allow across scopes.** Simple to reason about and safe for
  administrators; the cost is that a workspace cannot carve an exception out
  of a global deny (edit the global rule instead).
- **Wildcards exclude the apex.** `*.example.com` does not match
  `example.com`; add both when you want both. Matching the apex implicitly is
  a common source of surprise in firewall rules.
- **SSRF guard is on in every mode for agent-driven fetches.** Open mode
  still refuses `169.254.169.254`; opening private addresses takes a rule
  that names them.
- **Fail closed.** DNS failure refuses a fetch; if the proxy is needed and
  cannot start, the command is refused rather than run unguarded; invalid
  stored rules are skipped and shown, never treated as "allow".
- **Command analysis only escalates.** It can block or force an approval; it
  never auto-approves anything the ordinary safety classifier would not.
- **No dependencies.** IP parsing, the proxy and DNS checks use Node
  built-ins only.

## Security considerations and known gaps

- Command-string analysis is best effort (see above). Treat it as a
  tripwire, not a wall.
- The browse fetch resolves DNS for its check and `fetch` resolves again; a
  rebinding DNS server could answer differently the second time. The proxy
  path is not affected (it connects to the checked address); pinning the
  address for Node's built-in `fetch` needs an undici dispatcher, which is not
  exposed without adding a dependency.
- In `allowlist` mode the sandbox relies on processes honouring proxy
  variables; only `deny` mode is a hard network boundary. An internal Docker
  network with the proxy as sole gateway would close this.
- `git` over SSH does not use HTTP proxies, so in allowlist mode an SSH push
  from the sandbox bypasses the proxy (the command check still sees it).
- Model-provider traffic is exempt and not logged, by design.
- Typed input to a running interactive session (`POST /api/terminal/input`)
  is checked against the hard-block list only; its process already carries
  the proxy variables.
- The audit log is append-only by convention (no code path rewrites it), not
  tamper-proof against a local user with write access to the workspace.
