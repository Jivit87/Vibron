# Multi-platform git: GitHub, GitLab, Bitbucket

## Problem

Delivery (branch → commit → push → draft PR), issue intake, the auto-fix
watcher, CI watch and clone-to-fix all spoke only GitHub: `lib/github-api.ts`
was called directly, remotes were parsed with a `github.com` regex, and git
push auth was scoped to `https://github.com/`. A repository on GitLab
(gitlab.com or self-hosted) or Bitbucket Cloud was refused with
"not a GitHub repository".

## Design

```
lib/git-providers/
  interface.ts    GitProvider, capabilities, shared types, GitProviderError
  detect.ts       remote / issue / PR / repo-page URL parsing (pure)
  github.ts       adapter over lib/github-api.ts (unchanged client)
  gitlab.ts       GitLab REST v4
  bitbucket.ts    Bitbucket Cloud 2.0
  http.ts         shared JSON/error helper for GitLab and Bitbucket
  credentials.ts  stored GitLab / Bitbucket credentials + env fallbacks
  verify.ts       one live request to check credentials before saving
  factory.ts      provider for a remote or a URL, credentials attached
```

Callers get a `GitProvider` from the factory and never branch on the
platform:

| Operation | GitHub | GitLab | Bitbucket |
|---|---|---|---|
| Draft PR / MR | `draft: true` | `Draft:` title prefix | `draft: true` |
| Find open PR for branch | `head=owner:branch` | `source_branch=` | BBQL `source.branch.name="…"` |
| Issues, comments | issues API (PRs filtered) | issues + notes (system notes dropped) | issue tracker + comments |
| Labels | labels | labels | none: component (and kind) stand in; a label filter matches the component |
| File content | contents API (raw) | `repository/files/:path/raw` | `src/:ref/:path` |
| Branch ref | create + update | create only | create only |
| CI status | check runs | latest pipeline's jobs | commit build statuses |
| CI logs / re-run | Actions jobs | job trace / retry | not in the API |
| Closing line | `Fixes o/r#5` | `Closes g/sub/p#5` | `Fixes #5` |

What a platform lacks is a `false` capability (`updateBranch`, `ciLogs`,
`ciRerun`, `issueLabels`, …) and the method throws `GitProviderError` with
code `"unsupported"`, which the routes return as 400 `not_supported`.

The interface speaks GitHub's vocabulary because the rest of the app already
does: a merge request is a "pull request", its `iid` is its number, and CI
states are mapped onto check-run `status` / `conclusion` values (GitLab
`failed` + `allow_failure` → `neutral`, `manual` → `skipped`; Bitbucket
`STOPPED` → `cancelled`). `ciStatus`, `ciFixTask` and the Fix-CI flow work
unchanged on top.

### Detection

`detectRemote` accepts `https://`, `http://`, `ssh://`, `git+ssh://` and
scp-style `user@host:path` remotes. Hosts: github.com, gitlab.com,
bitbucket.org, the self-hosted GitLab base URL from Settings (which may carry
a path prefix such as `https://corp.example/gitlab`; the prefix is stripped
from https remotes, not ssh ones), and hostnames starting with `gitlab.`.
GitLab paths keep nested groups in `owner` (`g/sub/deeper`); GitHub and
Bitbucket need exactly `owner/repo`.

`parseItemUrl` accepts `…/issues/N` and `…/pull/N` (GitHub),
`…/-/issues/N`, `…/-/merge_requests/N`, `…/-/work_items/N` and the legacy
form without `-/` (GitLab), `…/issues/N[/slug]` and `…/pull-requests/N`
(Bitbucket). A URL with GitLab's `/-/` path on an unknown host is recognized
as GitLab, but credentials are never attached for it (see below).

## Key decisions

- **The GitHub adapter wraps, not rewrites.** Every call goes through the
  existing `lib/github-api.ts` with the same `ApiOptions`, so URLs, headers,
  bodies and error hints are byte-identical. `tests/git-providers.github.test.ts`
  runs each operation both ways and compares the requests; delivery, CI and
  report tests assert the same endpoint sequence as before. Existing GitHub
  entry points (`parseGitHubIssueUrl`, `parsePrUrl` incl. `o/r#N`,
  `fetchGitHubIssue`, `gitAuthEnv`) are still used first for GitHub input.
- **Credentials are resolved once per operation** by the factory (as
  `deliver` already did for the GitHub token) and passed to the adapter.
- **GitLab tokens belong to one instance.** Stored as `{ token, baseUrl }`;
  the factory attaches the token only when the repository's instance equals
  the configured one. A gitlab.com token is never sent to
  `gitlab.other.org`, and changing the URL in Settings requires entering the
  token again.
- **Bitbucket auth has two modes.** Username + app password (HTTP basic;
  git uses the same pair), or a repository/project/workspace access token
  (`Authorization: Bearer`; git uses `x-token-auth:<token>`).
- **No new dependencies.** Plain `fetch`, Node built-ins.
- **Error codes kept** (`not_github`, `no_github_remote`, `no_token`) so the
  UI and existing clients keep working; the messages now name all three hosts.

## Git push / fetch / clone auth

The existing pattern is kept and extended per host: credentials reach git
only as `GIT_CONFIG_COUNT/KEY_0/VALUE_0` env entries
(`http.<prefix>/.extraheader = AUTHORIZATION: basic …`), never in a URL or
argv, and git output is redacted of every secret the provider holds.

| Host | Config key prefix | Basic auth user |
|---|---|---|
| GitHub | `https://github.com/` | `x-access-token` (unchanged) |
| GitLab | the instance root, e.g. `https://gitlab.com/` or `https://corp.example/gitlab/` | `oauth2` |
| Bitbucket | `https://bitbucket.org/` | the username, or `x-token-auth` |

Auth env is produced only when the remote is https, on the provider's own
host (and under its path prefix), and has no embedded password. ssh remotes
use the user's ssh setup (`BatchMode=yes`) as before.

## Using it

**Settings → Integrations** now has GitLab and Bitbucket rows below GitHub:

- GitLab: an optional instance URL (empty = gitlab.com) and a personal,
  group or project access token with the `api` scope.
- Bitbucket: *App password* (username + app password with repository,
  pull request and issue scopes) or *Access token*.

Saving verifies the credentials (`GET /api/v4/user`, `GET /2.0/user`) and
stores them server-side; only masked fingerprints come back.

Environment fallbacks (headless / CI): `GITLAB_TOKEN`, `GITLAB_URL`,
`BITBUCKET_TOKEN`, or `BITBUCKET_USERNAME` + `BITBUCKET_APP_PASSWORD`.

Then everything that worked for GitHub works for a GitLab or Bitbucket
`origin`: Deliver, the Issues panel and auto-fix watcher, Fix-CI and flaky
re-runs (GitLab), `POST /api/clone` with a repo, issue or MR URL,
`GET /api/issue?url=…`, `POST /api/tasks { issueUrl }`, and
`viberon run --task <issue url> --deliver`.

API:

```
GET    /api/settings/git
PUT    /api/settings/git { platform: "gitlab", token?, baseUrl?, skipVerify? }
PUT    /api/settings/git { platform: "bitbucket", mode: "basic", username, appPassword? }
PUT    /api/settings/git { platform: "bitbucket", mode: "bearer", token? }
DELETE /api/settings/git?platform=gitlab|bitbucket
```

Library:

```ts
import { providerForRemote, providerForUrl } from "@/lib/git-providers";
const provider = await providerForRemote("git@gitlab.com:g/sub/p.git");
await provider?.createPullRequest({ title, body, head, base, draft: true });
```

## Security considerations

- Secrets are stored in the server-side settings store next to provider
  keys, never sent to the browser, never logged, never in URLs or argv.
- Host scoping as above: each credential goes only to its own API host and,
  for git, only to its own https prefix. Detection never implies trust.
- Self-hosted GitLab URLs must be https (plain http only for localhost), so
  a token is not sent in clear text.
- Error messages include the API path and the host's message, never request
  headers.
- Issue text from every host is framed as untrusted input for the solver,
  as before.
- The auto-fix watcher's trust gate is the label. On GitLab, applying labels
  needs Reporter access or more. Bitbucket has no labels: the watcher
  matches the issue's *component*; check who can set components on the
  repository before enabling auto mode there.

## Limitations

- Bitbucket Server / Data Center and GitHub Enterprise Server are not
  covered (only Bitbucket Cloud; GitHub keeps its existing github.com client).
- Bitbucket CI: no log excerpts or re-runs (not in the 2.0 API); status comes
  from commit build statuses, so a PR's abbreviated head hash is used.
- Bitbucket issues report no comment count.
- GitLab CI reads the latest pipeline for the MR head commit; external commit
  statuses from other CI systems are not included.
- PR review (`/api/review` with a PR URL) remains GitHub-only.
