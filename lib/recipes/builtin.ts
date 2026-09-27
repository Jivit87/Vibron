/**
 * Built-in example recipes.
 *
 * Kept as YAML source text (not objects) so they go through exactly the
 * parser and schema a user's file does, `recipe show` prints them verbatim,
 * and saving one to `.viberon/recipes/` is how you fork it. A repository or
 * global recipe with the same name takes precedence.
 */

export const BUILTIN_RECIPES: Record<string, string> = {
  "add-tests": `# Write unit tests for one file, run them, and repair them once if they fail.
name: add-tests
description: Add unit tests for a source file, then prove they pass
version: 1.0.0
author: Viberon

params:
  file:
    type: path
    required: true
    description: Source file to cover, relative to the repository root
  focus:
    type: string
    default: the public behaviour, edge cases and error paths
    description: What the tests should concentrate on

steps:
  - id: write
    title: Write tests for {{file}}
    agent:
      role: tester
      prompt: |
        Write focused unit tests for \`{{file}}\`.

        Cover {{focus}}. Follow the repository's existing test framework,
        file naming and directory layout (look at neighbouring tests first).
        Test observable behaviour, not implementation details. Do not change
        \`{{file}}\` itself. Run the new tests before you finish.

  - id: check
    title: Run the test suite
    verify:
      kind: test
    continue_on_error: true

  - id: repair
    title: Repair failing tests
    when: check.failed
    agent:
      role: tester
      prompt: |
        The tests written for \`{{file}}\` do not pass yet. The harness output:

        {{steps.check.output}}

        Fix the tests. Only change \`{{file}}\` if a test exposed a genuine bug
        in it, and say so in your summary.

  - id: recheck
    title: Re-run the test suite
    when: check.failed
    verify:
      kind: test
`,

  "fix-lint": `# Run the linter, let an agent fix what it reports, and lint again.
name: fix-lint
description: Fix the linter errors in a path and confirm the linter is clean
version: 1.0.0
author: Viberon

params:
  linter:
    type: enum
    values: [eslint, ruff]
    default: eslint
    description: Which linter the repository uses
  path:
    type: path
    default: .
    description: File or directory to lint

steps:
  - id: eslint
    title: Lint with ESLint
    when: params.linter == "eslint"
    shell: npx eslint {{path}}
    timeout: 600
    continue_on_error: true

  - id: ruff
    title: Lint with Ruff
    when: params.linter == "ruff"
    shell: python -m ruff check {{path}}
    timeout: 600
    continue_on_error: true

  - id: fix
    title: Fix the reported problems
    when: eslint.failed || ruff.failed
    agent:
      role: generalist
      prompt: |
        The {{linter}} linter reports problems in \`{{path}}\`:

        {{steps.eslint.output}}{{steps.ruff.output}}

        Fix every reported problem at its root. Do not disable rules, add
        ignore comments, or change the linter configuration. Keep behaviour
        unchanged.

  - id: eslint-again
    title: Lint again
    when: eslint.failed
    shell: npx eslint {{path}}
    timeout: 600

  - id: ruff-again
    title: Lint again
    when: ruff.failed
    shell: python -m ruff check {{path}}
    timeout: 600
`,

  "bump-dependency": `# Upgrade one package, then prove nothing broke (and adapt the code once if it did).
name: bump-dependency
description: Upgrade an npm dependency and verify the project still passes its checks
version: 1.0.0
author: Viberon

params:
  package:
    type: string
    required: true
    description: Package name, e.g. zod or @types/node
  version:
    type: string
    default: latest
    description: Version or dist-tag to install
  manager:
    type: enum
    values: [npm, pnpm, yarn]
    default: npm
    description: The repository's package manager

steps:
  - id: install-npm
    title: npm install {{package}}@{{version}}
    when: params.manager == "npm"
    shell: npm install {{package}}@{{version}}
    timeout: 900

  - id: install-pnpm
    title: pnpm add {{package}}@{{version}}
    when: params.manager == "pnpm"
    shell: pnpm add {{package}}@{{version}}
    timeout: 900

  - id: install-yarn
    title: yarn add {{package}}@{{version}}
    when: params.manager == "yarn"
    shell: yarn add {{package}}@{{version}}
    timeout: 900

  - id: check
    title: Run the repository's checks
    when: install-npm.succeeded || install-pnpm.succeeded || install-yarn.succeeded
    verify: auto
    continue_on_error: true

  - id: adapt
    title: Adapt the code to {{package}}@{{version}}
    when: check.failed
    agent:
      role: generalist
      prompt: |
        \`{{package}}\` was upgraded to \`{{version}}\` and the project's checks
        now fail:

        {{steps.check.output}}

        Adapt the code to the new version's API. Do not pin the package back
        to the old version and do not weaken or delete tests.

  - id: recheck
    title: Run the checks again
    when: check.failed
    verify: auto
`,

  "document-module": `# Document a module's public API in place, and prove behaviour did not change.
name: document-module
description: Write doc comments for every exported symbol of a module
version: 1.0.0
author: Viberon

params:
  module:
    type: path
    required: true
    description: The module file to document
  audience:
    type: enum
    values: [users, maintainers]
    default: users
    description: Who the documentation is for

steps:
  - id: document
    title: Document {{module}}
    agent:
      role: docs
      files: ["{{module}}"]
      prompt: |
        Write documentation comments for every exported symbol in
        \`{{module}}\`, in the idiomatic style for its language (JSDoc/TSDoc,
        Python docstrings, Go doc comments, rustdoc, Javadoc).

        Write for {{audience}}: say what each symbol is for, its parameters,
        return value, errors and one short example where it helps. Match the
        comment density of the rest of the repository.

        Change comments and docstrings only. Never change code.

  - id: check
    title: Confirm behaviour is unchanged
    verify: auto
`,
};
