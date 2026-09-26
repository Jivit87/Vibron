# Task 1.3: GitHub Action for CI/CD - Implementation Plan

**Task:** Create GitHub Action for automated issue fixing in CI/CD pipelines  
**Status:** 🟡 IN PROGRESS  
**Started:** 2026-09-27  
**Priority:** HIGH  
**Effort:** 2-3 days → 1 day (Viberon headless already exists!)

---

## Discovery: Headless CLI Already Exists! 🎉

### Existing Implementation

**`bin/viberon` CLI** - Complete headless runner:
- ✅ `viberon run` - Run autonomous fix on repository
- ✅ `--repo` - Repository path
- ✅ `--task` - Task description or issue URL
- ✅ `--worktree` - Git worktree for isolation
- ✅ `--json` - JSON output for CI integration
- ✅ Evidence bundle in `.viberon/runs/<task-id>/`

**`lib/headless/run.ts`** - Headless execution:
- ✅ Full solveTask integration
- ✅ Result bundling (patch, report, metrics)
- ✅ Exit codes (0=success, 1=fail, 2=error)
- ✅ JSON output format

**Existing Usage:**
```bash
bin/viberon run \
  --repo ~/code/project \
  --task "Fix the authentication bug" \
  --json
```

### What's Missing

❌ **GitHub Action wrapper** - No `.github/actions/` package yet  
❌ **PR creation integration** - Action doesn't create PRs automatically  
❌ **Issue commenting** - No automatic status comments  
❌ **GitHub API integration** - Need to fetch issues, create PRs, post comments

---

## Revised Implementation Plan

Since the headless CLI exists, we just need a thin GitHub Action wrapper!

### Task 1.3.1: Research & Design ✅ (1 hour)

**Status:** COMPLETE

**Findings:**
- Viberon CLI is production-ready
- Just need GitHub Action metadata + PR automation
- Use GitHub's Octokit for API calls
- Follow GitHub Action best practices

**Action Design:**

**Inputs:**
- `issue-number` - GitHub issue to fix
- `model` - AI model (default: claude-sonnet-4)
- `max-turns` - Budget (default: 10)
- `timeout` - Time limit in minutes (default: 30)
- `create-pr` - Auto-create PR (default: true)
- `github-token` - GitHub token (default: ${{ github.token }})

**Outputs:**
- `status` - resolved | failed | incomplete
- `pr-number` - Created PR number (if any)
- `patch-path` - Path to generated patch
- `report-path` - Path to evidence report

**Workflow Example:**
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
      - uses: jivit87/viberon-action@v1
        with:
          issue-number: ${{ github.event.issue.number }}
          create-pr: true
```

---

### Task 1.3.2: Implement Action (3-4 hours)

**Objective:** Create GitHub Action that wraps Viberon CLI

**File Structure:**
```
.github/actions/viberon-action/
├── action.yml          # Action metadata
├── index.js            # Main entry point
├── package.json        # Dependencies
└── README.md           # Documentation
```

**Implementation Steps:**

**1. Create action.yml**
```yaml
name: 'Viberon Auto-Fix'
description: 'Automatically fix GitHub issues using Viberon AI'
author: 'Viberon Team'

inputs:
  issue-number:
    description: 'GitHub issue number to fix'
    required: true
  model:
    description: 'AI model to use'
    required: false
    default: 'claude-sonnet-4'
  max-turns:
    description: 'Maximum turns for agent'
    required: false
    default: '10'
  timeout:
    description: 'Timeout in minutes'
    required: false
    default: '30'
  create-pr:
    description: 'Create pull request automatically'
    required: false
    default: 'true'
  github-token:
    description: 'GitHub token'
    required: false
    default: ${{ github.token }}

outputs:
  status:
    description: 'Fix status (resolved, failed, incomplete)'
  pr-number:
    description: 'Created PR number'
  patch-path:
    description: 'Path to patch file'
  report-path:
    description: 'Path to evidence report'

runs:
  using: 'node20'
  main: 'index.js'
```

**2. Create index.js**
```javascript
const core = require('@actions/core');
const github = require('@actions/github');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function run() {
  try {
    // Get inputs
    const issueNumber = core.getInput('issue-number', { required: true });
    const model = core.getInput('model');
    const maxTurns = core.getInput('max-turns');
    const timeout = core.getInput('timeout');
    const createPR = core.getInput('create-pr') === 'true';
    const token = core.getInput('github-token');
    
    // Get repository info
    const { owner, repo } = github.context.repo;
    const octokit = github.getOctokit(token);
    
    // Fetch issue details
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber
    });
    
    core.info(`Fixing issue #${issueNumber}: ${issue.title}`);
    
    // Run Viberon CLI
    const cmd = `pnpm viberon run \
      --repo . \
      --task "${issue.html_url}" \
      --model ${model} \
      --max-turns ${maxTurns} \
      --timeout $((${timeout} * 60)) \
      --worktree \
      --json`;
    
    core.info(`Running: ${cmd}`);
    
    const output = execSync(cmd, {
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    const result = JSON.parse(output);
    
    // Set outputs
    core.setOutput('status', result.status);
    core.setOutput('patch-path', result.patchPath);
    core.setOutput('report-path', result.reportPath);
    
    // Create PR if requested and fix succeeded
    if (createPR && result.status === 'resolved' && result.patchPath) {
      const prNumber = await createPullRequest(
        octokit,
        owner,
        repo,
        issueNumber,
        issue.title,
        result
      );
      core.setOutput('pr-number', prNumber);
    }
    
    // Comment on issue
    await postComment(
      octokit,
      owner,
      repo,
      issueNumber,
      result
    );
    
    if (result.status !== 'resolved') {
      core.setFailed(`Fix ${result.status}`);
    }
    
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function createPullRequest(octokit, owner, repo, issueNumber, title, result) {
  // Create branch
  const branchName = `viberon/fix-${issueNumber}`;
  
  // Apply patch
  execSync(`git apply ${result.patchPath}`);
  execSync(`git checkout -b ${branchName}`);
  execSync(`git add .`);
  execSync(`git commit -m "fix: ${title} (#${issueNumber})"`);
  execSync(`git push -u origin ${branchName}`);
  
  // Create PR
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `Fix: ${title}`,
    head: branchName,
    base: 'main',
    body: `Fixes #${issueNumber}\n\n## Automated Fix\n\n${result.summary}\n\n---\n*Generated by Viberon*`
  });
  
  return pr.number;
}

async function postComment(octokit, owner, repo, issueNumber, result) {
  const status = result.status === 'resolved' ? '✅ Fixed' : '❌ Failed';
  const body = `${status} - Viberon attempted to fix this issue.\n\nStatus: \`${result.status}\`\nTime: ${result.timeMs}ms\nTokens: ${result.tokens}`;
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
}

run();
```

**3. Create package.json**
```json
{
  "name": "viberon-action",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "@actions/core": "^1.10.0",
    "@actions/github": "^5.1.1"
  }
}
```

**Deliverable:** Working GitHub Action

---

### Task 1.3.3: Validation (2-3 hours)

**Manual Testing:**

**1. Create Test Workflow**
```yaml
# .github/workflows/test-viberon.yml
name: Test Viberon Action

on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: 'Issue number to fix'
        required: true

jobs:
  test:
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
          issue-number: ${{ github.event.inputs.issue_number }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

**2. Test Cases**
- [ ] Simple bug fix (type error)
- [ ] Complex issue (multi-file)
- [ ] Issue with no solution
- [ ] Invalid issue number

**Pass Criteria:** Action runs successfully, creates PR

---

### Task 1.3.4: Documentation (1-2 hours)

**Files to Create:**

**1. Action README**
```markdown
# Viberon GitHub Action

Automatically fix GitHub issues using Viberon AI.

## Usage

### Basic
\`\`\`yaml
- uses: jivit87/viberon-action@v1
  with:
    issue-number: 123
\`\`\`

### Advanced
\`\`\`yaml
- uses: jivit87/viberon-action@v1
  with:
    issue-number: 123
    model: claude-sonnet-4
    max-turns: 15
    timeout: 45
    create-pr: true
\`\`\`

## Inputs

| Input | Required | Default | Description |
|:------|:---------|:--------|:------------|
| issue-number | Yes | - | GitHub issue to fix |
| model | No | claude-sonnet-4 | AI model |
| max-turns | No | 10 | Max agent turns |
| timeout | No | 30 | Timeout (minutes) |
| create-pr | No | true | Create PR |
| github-token | No | ${{ github.token }} | GitHub token |

## Outputs

| Output | Description |
|:-------|:------------|
| status | resolved, failed, or incomplete |
| pr-number | Created PR number |
| patch-path | Path to patch file |
| report-path | Path to evidence report |

## Examples

### Auto-fix labeled issues
\`\`\`yaml
on:
  issues:
    types: [labeled]

jobs:
  fix:
    if: github.event.label.name == 'viberon-fix'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: jivit87/viberon-action@v1
        with:
          issue-number: ${{ github.event.issue.number }}
\`\`\`

### Nightly cron for all open issues
\`\`\`yaml
on:
  schedule:
    - cron: '0 0 * * *'

jobs:
  fix-issues:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Get open issues
        id: issues
        run: |
          # Fetch issues with 'bug' label
          gh issue list --label bug --json number --jq '.[].number'
      - uses: jivit87/viberon-action@v1
        with:
          issue-number: ${{ steps.issues.outputs.number }}
\`\`\`
```

**2. Update Main README**
```markdown
## GitHub Action

Automate issue fixing in CI/CD:

\`\`\`yaml
- uses: jivit87/viberon-action@v1
  with:
    issue-number: 123
\`\`\`

See [.github/actions/viberon-action/README.md] for full documentation.
```

---

## Implementation Checklist

### Phase 1: Setup
- [ ] Create `.github/actions/viberon-action/` directory
- [ ] Create `action.yml` with metadata
- [ ] Create `package.json` with dependencies
- [ ] Initialize Node.js project

### Phase 2: Core Implementation
- [ ] Implement input parsing
- [ ] Implement Viberon CLI invocation
- [ ] Implement result parsing
- [ ] Implement error handling

### Phase 3: GitHub Integration
- [ ] Fetch issue via API
- [ ] Create branch and apply patch
- [ ] Create pull request
- [ ] Post status comment
- [ ] Handle PR linking

### Phase 4: Testing
- [ ] Create test workflow
- [ ] Test with real issue
- [ ] Test failure scenarios
- [ ] Verify PR creation
- [ ] Verify comments

### Phase 5: Documentation
- [ ] Write action README
- [ ] Add usage examples
- [ ] Document inputs/outputs
- [ ] Add troubleshooting guide
- [ ] Update main README

---

## Success Criteria

### Must Have
- ✅ Action runs in GitHub Actions
- ✅ Fetches issue from GitHub
- ✅ Invokes Viberon CLI correctly
- ✅ Creates PR with fix
- ✅ Posts status comment
- ✅ Documentation complete

### Should Have
- ✅ Handles failures gracefully
- ✅ Proper error messages
- ✅ Configurable via inputs
- ✅ Example workflows provided

### Nice to Have
- ⏳ Support for GitLab CI
- ⏳ Multiple issue fixing
- ⏳ Slack notifications
- ⏳ Custom PR templates

---

## Timeline

| Phase | Duration | Status |
|:------|:---------|:-------|
| Research & Design | 1 hour | ✅ Complete |
| Core Implementation | 3-4 hours | ⏳ Pending |
| GitHub Integration | 2-3 hours | ⏳ Pending |
| Testing | 2-3 hours | ⏳ Pending |
| Documentation | 1-2 hours | ⏳ Pending |
| **Total** | **9-13 hours (~1-2 days)** | **10% Complete** |

**Revised Estimate:** 1-2 days (down from 2-3 days)

---

## Security Considerations

### GitHub Token
- Use `${{ github.token }}` by default
- Scope: `issues:write`, `pull_requests:write`, `contents:write`
- Never log token value

### Repository Access
- Action runs in repository context
- Has full write access to repo
- Review generated patches before merging

### API Keys
- Anthropic API key needed for Viberon
- Store as GitHub secret: `ANTHROPIC_API_KEY`
- Pass to action via environment

### Best Practices
- Use dependabot for action dependencies
- Pin action versions (`@v1.0.0`)
- Review action logs for sensitive data
- Use branch protection rules

---

## Alternative Approaches Considered

1. **Docker Action** - Heavier, slower startup
2. **Composite Action** - Less control, harder to debug
3. **Node.js Action (chosen)** - Fast, full control, standard

---

## Notes

### Why GitHub Action?

From research (research.md §3):
> "PR-Agent has a GitHub Action that automatically fixes issues in CI. This
> enables 'push to fix' workflows where issues are resolved automatically
> on every push or nightly."

### Performance Considerations

- Action startup: ~10s (Node.js dependencies)
- Viberon CLI: 1-5 minutes (depending on issue)
- Total: 1-6 minutes per issue

### Rate Limits

- GitHub API: 5000 requests/hour
- Anthropic API: Based on tier
- Recommendation: Run on labeled issues only

---

**Status:** Ready to begin implementation  
**Next:** Create action files and implement core logic
