/**
 * Named host bundles a policy can switch on in one click.
 *
 * Pure data (no Node imports) so the settings UI can render the same list
 * the server enforces. Patterns use the rule syntax from `rules.ts`.
 */

export type EgressPresetId = "packageRegistries" | "docs" | "gitHosts" | "aiProviders";

export interface EgressPreset {
  id: EgressPresetId;
  label: string;
  description: string;
  hosts: string[];
}

/** Hosts package managers talk to when they install or resolve. */
export const PACKAGE_REGISTRY_HOSTS = [
  // npm / yarn / pnpm / bun
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  // pip / uv / poetry
  "pypi.org",
  "files.pythonhosted.org",
  // cargo
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  // go modules
  "proxy.golang.org",
  "sum.golang.org",
  // jvm
  "repo1.maven.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  "services.gradle.org",
  // ruby, php, .NET
  "rubygems.org",
  "index.rubygems.org",
  "repo.packagist.org",
  "api.nuget.org",
  // Release tarballs referenced by lockfiles and installers.
  "objects.githubusercontent.com",
  "codeload.github.com",
];

export const DOCS_HOSTS = [
  "developer.mozilla.org",
  "docs.python.org",
  "docs.rs",
  "pkg.go.dev",
  "*.typescriptlang.org",
  "typescriptlang.org",
  "nodejs.org",
  "react.dev",
  "nextjs.org",
  "vuejs.org",
  "angular.dev",
  "svelte.dev",
  "www.npmjs.com",
  "stackoverflow.com",
  "learn.microsoft.com",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "en.wikipedia.org",
  "web.dev",
  "html.duckduckgo.com",
];

export const GIT_HOSTS = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gist.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "api.bitbucket.org",
];

/**
 * Model APIs. The providers actually configured are allowed implicitly for
 * the harness itself; this preset is for letting *other* subsystems (a
 * sandboxed script, the browse tool) reach them too.
 */
export const AI_PROVIDER_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "api.groq.com",
  "generativelanguage.googleapis.com",
  "integrate.api.nvidia.com",
  "openrouter.ai",
  "api.x.ai",
  "api.deepseek.com",
  "api.mistral.ai",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.cerebras.ai",
  "router.huggingface.co",
];

export const EGRESS_PRESETS: EgressPreset[] = [
  {
    id: "packageRegistries",
    label: "Package registries",
    description: "npm, PyPI, crates.io, Go proxy, Maven, RubyGems, Packagist, NuGet.",
    hosts: PACKAGE_REGISTRY_HOSTS,
  },
  {
    id: "docs",
    label: "Documentation sites",
    description: "MDN, language docs, Stack Overflow and the web search endpoint.",
    hosts: DOCS_HOSTS,
  },
  {
    id: "gitHosts",
    label: "Git hosts",
    description: "GitHub, GitLab and Bitbucket, including raw file hosts.",
    hosts: GIT_HOSTS,
  },
  {
    id: "aiProviders",
    label: "AI providers",
    description: "All known model APIs, for tools other than the harness itself.",
    hosts: AI_PROVIDER_HOSTS,
  },
];

export const PRESET_IDS = EGRESS_PRESETS.map((p) => p.id);

export function isPresetId(value: unknown): value is EgressPresetId {
  return typeof value === "string" && (PRESET_IDS as string[]).includes(value);
}

export function presetById(id: EgressPresetId): EgressPreset {
  return EGRESS_PRESETS.find((p) => p.id === id) as EgressPreset;
}
