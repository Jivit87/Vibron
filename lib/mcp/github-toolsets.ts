/**
 * GitHub MCP constants shared by the server route and the settings UI.
 * No Node imports: this module is bundled for the browser.
 */

export type GithubMode = "remote" | "docker" | "binary";
export const GITHUB_MODES: GithubMode[] = ["remote", "docker", "binary"];

/** Toolsets the server accepts, from the upstream README. */
export const GITHUB_TOOLSETS: { id: string; label: string; remoteOnly?: boolean }[] = [
  { id: "context", label: "Context (current user)" },
  { id: "repos", label: "Repositories" },
  { id: "issues", label: "Issues" },
  { id: "pull_requests", label: "Pull requests" },
  { id: "users", label: "Users" },
  { id: "actions", label: "Actions" },
  { id: "code_security", label: "Code scanning" },
  { id: "code_quality", label: "Code quality" },
  { id: "dependabot", label: "Dependabot" },
  { id: "secret_protection", label: "Secret scanning" },
  { id: "security_advisories", label: "Security advisories" },
  { id: "discussions", label: "Discussions" },
  { id: "gists", label: "Gists" },
  { id: "git", label: "Git (low-level)" },
  { id: "labels", label: "Labels" },
  { id: "notifications", label: "Notifications" },
  { id: "orgs", label: "Organizations" },
  { id: "projects", label: "Projects" },
  { id: "stargazers", label: "Stargazers" },
  { id: "governance", label: "Governance" },
  { id: "copilot", label: "Copilot" },
  { id: "copilot_spaces", label: "Copilot Spaces", remoteOnly: true },
  { id: "github_support_docs_search", label: "Support docs search", remoteOnly: true },
];

/**
 * The server's own default set. Kept small on purpose: every enabled tool
 * is a definition in every agent prompt.
 */
export const DEFAULT_GITHUB_TOOLSETS = ["context", "repos", "issues", "pull_requests", "users"];
