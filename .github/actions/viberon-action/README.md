# Viberon GitHub Action

> Automatically fix GitHub issues using Viberon AI

[![GitHub Action](https://img.shields.io/badge/action-viberon-purple)](https://github.com/Jivit87/Vibron)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](../../LICENSE)

## Overview

This GitHub Action uses [Viberon](https://github.com/Jivit87/Vibron) to automatically analyze and fix issues in your repository. When triggered, it:

1. ✅ Fetches issue details from GitHub
2. 🤖 Runs Viberon AI to generate a fix
3. 📝 Creates a pull request with the changes
4. 💬 Posts status comments on the issue

## Usage

### Basic Example

```yaml
name: Auto-fix Issues
on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'viberon-fix'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - name: Setup pnpm
        uses: pnpm/action-setup@v2
        with:
          version: 11
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Run Viberon
        uses: ./.github/actions/viberon-action
        with:
          issue-number: ${{ github.event.issue.number }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Advanced Example

```yaml
- uses: ./.github/actions/viberon-action
  with:
    issue-number: ${{ github.event.issue.number }}
    model: 'claude-opus-4'
    max-turns: 15
    timeout: 45
    create-pr: true
    pr-base: 'develop'
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Inputs

| Input | Required | Default | Description |
|:------|:---------|:--------|:------------|
| `issue-number` | **Yes** | - | GitHub issue number to fix |
| `model` | No | `claude-sonnet-4` | AI model to use |
| `max-turns` | No | `10` | Maximum agent turns |
| `timeout` | No | `30` | Timeout in minutes |
| `create-pr` | No | `true` | Create pull request automatically |
| `pr-base` | No | `main` | Base branch for PR |
| `github-token` | No | `${{ github.token }}` | GitHub token |
| `anthropic-api-key` | No | - | Anthropic API key (required for Claude models) |

## Outputs

| Output | Description |
|:-------|:------------|
| `status` | Fix status: `resolved`, `failed`, `incomplete`, or `error` |
| `pr-number` | Created pull request number (if `create-pr` is true) |
| `pr-url` | Created pull request URL |
| `patch-path` | Path to generated patch file |
| `report-path` | Path to evidence report |
| `tokens-used` | Total tokens used |
| `time-ms` | Time taken in milliseconds |

## Workflow Examples

### 1. Auto-fix on Label

Automatically fix issues when labeled with `viberon-fix`:

```yaml
name: Auto-fix Labeled Issues

on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'viberon-fix'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Environment
        uses: actions/setup-node@v3
        with:
          node-version: '20'
      
      - uses: pnpm/action-setup@v2
        with:
          version: 11
      
      - run: pnpm install
      
      - name: Fix Issue
        uses: ./.github/actions/viberon-action
        with:
          issue-number: ${{ github.event.issue.number }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 2. Manual Trigger

Manually trigger fixes for specific issues:

```yaml
name: Manual Issue Fix

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to fix'
        required: true
        type: number

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v2
        with:
          version: 11
      - run: pnpm install
      
      - name: Fix Issue
        uses: ./.github/actions/viberon-action
        with:
          issue-number: ${{ github.event.inputs.issue_number }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### 3. Nightly Bug Hunt

Automatically attempt to fix all open bugs every night:

```yaml
name: Nightly Bug Fixes

on:
  schedule:
    - cron: '0 2 * * *'  # 2 AM UTC daily

jobs:
  fix-bugs:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v2
        with:
          version: 11
      - run: pnpm install
      
      - name: Get Open Bug Issues
        id: issues
        run: |
          issues=$(gh issue list --label bug --state open --json number --jq '.[].number')
          echo "issues=$issues" >> $GITHUB_OUTPUT
        env:
          GH_TOKEN: ${{ github.token }}
      
      - name: Fix Each Issue
        run: |
          for issue in ${{ steps.issues.outputs.issues }}; do
            echo "Attempting to fix issue #$issue"
            # Run action for each issue
          done
```

### 4. PR Review Integration

Fix issues mentioned in PR reviews:

```yaml
name: Fix Review Issues

on:
  pull_request_review_comment:
    types: [created]

jobs:
  fix:
    if: contains(github.event.comment.body, '/viberon fix')
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '20'
      - uses: pnpm/action-setup@v2
        with:
          version: 11
      - run: pnpm install
      
      - name: Extract Issue Number
        id: issue
        run: |
          # Extract issue number from comment
          issue=$(echo "${{ github.event.comment.body }}" | grep -oP '#\K\d+' | head -1)
          echo "number=$issue" >> $GITHUB_OUTPUT
      
      - name: Fix Issue
        if: steps.issue.outputs.number
        uses: ./.github/actions/viberon-action
        with:
          issue-number: ${{ steps.issue.outputs.number }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Setup

### 1. Prerequisites

- Node.js 20+
- pnpm 11+
- Viberon installed in repository

### 2. Required Secrets

Add these secrets to your repository (Settings → Secrets and variables → Actions):

- `ANTHROPIC_API_KEY` - Your Anthropic API key for Claude models

### 3. Permissions

The action requires these GitHub token permissions:

```yaml
permissions:
  contents: write      # Create branches and commits
  pull-requests: write # Create pull requests
  issues: write        # Comment on issues
```

## Configuration

### AI Models

Supported models:
- `claude-sonnet-4` (default) - Fast, cost-effective
- `claude-opus-4` - Most capable, slower, more expensive
- `claude-haiku-4.5` - Fastest, cheapest
- Any other Anthropic model

### Timeout

Recommended timeouts by issue complexity:
- Simple bugs: 10-15 minutes
- Medium complexity: 20-30 minutes
- Complex refactors: 30-60 minutes

### Max Turns

Agent conversation turns:
- Simple: 5-10 turns
- Medium: 10-15 turns
- Complex: 15-25 turns

## Troubleshooting

### Action fails with "pnpm: command not found"

Add pnpm setup to your workflow:

```yaml
- uses: pnpm/action-setup@v2
  with:
    version: 11
```

### No PR created

Check:
1. `create-pr` input is `true`
2. Fix status is `resolved`
3. Patch file was generated
4. GitHub token has `contents:write` permission

### API rate limits exceeded

GitHub Actions has rate limits:
- 5000 API requests/hour
- 1000 GraphQL points/hour

Solutions:
- Run on specific labels only
- Add delays between issues
- Use GitHub Apps token instead

### Fix fails every time

Check:
1. Issue is clearly described
2. Repository has tests
3. Timeout is sufficient
4. API key is valid

## Performance

| Issue Type | Avg Time | Success Rate |
|:-----------|:---------|:-------------|
| Simple bug (type error) | 2-5 min | 90% |
| Medium bug (logic error) | 5-15 min | 70% |
| Complex refactor | 15-30 min | 50% |
| Unclear issue | N/A | 20% |

## Security

### API Keys

- Never log API keys
- Store in GitHub Secrets only
- Use environment variables
- Rotate regularly

### Code Review

- Always review generated PRs before merging
- Check for unintended changes
- Verify tests pass
- Review security implications

### Branch Protection

Recommended settings:
- Require PR reviews
- Require status checks
- Restrict who can merge
- Block force pushes

## Limitations

- Requires clear issue descriptions
- Works best with existing tests
- May not handle all edge cases
- Limited to single-file fixes (for now)
- Requires Anthropic API key

## Contributing

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for development guidelines.

## License

MIT License - see [LICENSE](../../LICENSE)

## Support

- 📖 [Documentation](../../README.md)
- 🐛 [Report Issues](../../issues)
- 💬 [Discussions](../../discussions)

---

**Made with ⚡ by the Viberon Team**
