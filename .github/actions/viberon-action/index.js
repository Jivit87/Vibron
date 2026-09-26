/**
 * Viberon GitHub Action
 * 
 * Automatically fixes GitHub issues using Viberon AI.
 * 
 * Workflow:
 * 1. Fetch issue details from GitHub
 * 2. Run Viberon CLI to generate fix
 * 3. Create branch and apply patch
 * 4. Create pull request
 * 5. Post status comment on issue
 */

const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
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
    const prBase = core.getInput('pr-base');
    const token = core.getInput('github-token');
    const anthropicKey = core.getInput('anthropic-api-key');
    
    core.info(`🚀 Viberon Auto-Fix Action`);
    core.info(`Issue: #${issueNumber}`);
    core.info(`Model: ${model}`);
    core.info(`Max turns: ${maxTurns}`);
    core.info(`Timeout: ${timeout} minutes`);
    
    // Initialize GitHub API client
    const octokit = github.getOctokit(token);
    const { owner, repo } = github.context.repo;
    
    // Fetch issue details
    core.info(`\n📋 Fetching issue #${issueNumber}...`);
    const { data: issue } = await octokit.rest.issues.get({
      owner,
      repo,
      issue_number: parseInt(issueNumber)
    });
    
    core.info(`Issue title: ${issue.title}`);
    core.info(`Issue URL: ${issue.html_url}`);
    
    // Post starting comment
    await postComment(octokit, owner, repo, issueNumber, {
      status: 'starting',
      message: `🤖 Viberon is analyzing this issue and attempting to generate a fix...`
    });
    
    // Run Viberon CLI
    core.info(`\n🔧 Running Viberon CLI...`);
    const result = await runViberon(issue.html_url, model, maxTurns, timeout, anthropicKey);
    
    core.info(`\n✅ Viberon completed`);
    core.info(`Status: ${result.status}`);
    core.info(`Tokens: ${result.tokens || 'N/A'}`);
    core.info(`Time: ${result.timeMs || 'N/A'}ms`);
    
    // Set outputs
    core.setOutput('status', result.status);
    core.setOutput('patch-path', result.patchPath || '');
    core.setOutput('report-path', result.reportPath || '');
    core.setOutput('tokens-used', result.tokens || 0);
    core.setOutput('time-ms', result.timeMs || 0);
    
    // Create PR if requested and fix succeeded
    if (createPR && result.status === 'resolved' && result.patchPath) {
      core.info(`\n📝 Creating pull request...`);
      
      try {
        const pr = await createPullRequest(
          octokit,
          owner,
          repo,
          issueNumber,
          issue.title,
          prBase,
          result
        );
        
        core.setOutput('pr-number', pr.number);
        core.setOutput('pr-url', pr.html_url);
        core.info(`✅ Created PR #${pr.number}: ${pr.html_url}`);
        
        // Post success comment with PR link
        await postComment(octokit, owner, repo, issueNumber, {
          status: 'resolved',
          prNumber: pr.number,
          prUrl: pr.html_url,
          tokens: result.tokens,
          timeMs: result.timeMs
        });
      } catch (prError) {
        core.warning(`Failed to create PR: ${prError.message}`);
        
        // Still post success comment even if PR failed
        await postComment(octokit, owner, repo, issueNumber, {
          status: 'resolved',
          message: `Fix generated but PR creation failed. Patch available at: ${result.patchPath}`,
          tokens: result.tokens,
          timeMs: result.timeMs
        });
      }
    } else {
      // Post status comment (failed or incomplete)
      await postComment(octokit, owner, repo, issueNumber, {
        status: result.status,
        message: result.summary || 'See action logs for details',
        tokens: result.tokens,
        timeMs: result.timeMs
      });
    }
    
    // Fail the action if fix didn't resolve
    if (result.status !== 'resolved') {
      core.setFailed(`Fix status: ${result.status}`);
    }
    
  } catch (error) {
    core.error(`Action failed: ${error.message}`);
    core.error(error.stack);
    core.setFailed(error.message);
  }
}

/**
 * Run Viberon CLI and parse result
 */
async function runViberon(issueUrl, model, maxTurns, timeoutMin, anthropicKey) {
  const timeoutSec = parseInt(timeoutMin) * 60;
  
  // Build command
  const args = [
    'run',
    '--repo', '.',
    '--task', issueUrl,
    '--model', model,
    '--max-turns', maxTurns,
    '--timeout', timeoutSec.toString(),
    '--worktree',
    '--json'
  ];
  
  // Set environment variables
  const env = { ...process.env };
  if (anthropicKey) {
    env.ANTHROPIC_API_KEY = anthropicKey;
  }
  
  // Execute Viberon CLI
  let output = '';
  let errorOutput = '';
  
  const exitCode = await exec.exec('pnpm', ['viberon', ...args], {
    env,
    listeners: {
      stdout: (data) => {
        output += data.toString();
      },
      stderr: (data) => {
        errorOutput += data.toString();
        core.info(data.toString()); // Stream to action logs
      }
    },
    ignoreReturnCode: true
  });
  
  core.info(`\nViberon exit code: ${exitCode}`);
  
  // Parse JSON output
  try {
    // Extract JSON from output (may have other text)
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      return result;
    }
  } catch (parseError) {
    core.warning(`Failed to parse Viberon output as JSON: ${parseError.message}`);
  }
  
  // Fallback: construct result from exit code
  return {
    status: exitCode === 0 ? 'resolved' : exitCode === 1 ? 'failed' : 'error',
    exitCode,
    output,
    error: errorOutput
  };
}

/**
 * Create pull request with fix
 */
async function createPullRequest(octokit, owner, repo, issueNumber, issueTitle, baseBranch, result) {
  const branchName = `viberon/fix-issue-${issueNumber}`;
  
  // Get current commit SHA
  const { data: ref } = await octokit.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });
  const baseSha = ref.object.sha;
  
  // Create new branch
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: baseSha
    });
  } catch (error) {
    // Branch might already exist, try to update it
    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
      sha: baseSha,
      force: true
    });
  }
  
  // Read patch file
  const patchContent = fs.readFileSync(result.patchPath, 'utf8');
  
  // Apply patch by creating commits
  // Note: This is a simplified version. In production, you'd parse the patch
  // and create proper file changes via GitHub API.
  
  // For now, create PR with patch as description
  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title: `Fix: ${issueTitle}`,
    head: branchName,
    base: baseBranch,
    body: `## Automated Fix for #${issueNumber}

${issueTitle}

### Summary
${result.summary || 'Fix generated by Viberon AI'}

### Changes
\`\`\`diff
${patchContent}
\`\`\`

### Evidence
- **Status:** ${result.status}
- **Tokens used:** ${result.tokens || 'N/A'}
- **Time taken:** ${result.timeMs ? Math.round(result.timeMs / 1000) + 's' : 'N/A'}

---
🤖 *This PR was automatically generated by [Viberon](https://github.com/Jivit87/Vibron)*`
  });
  
  // Link PR to issue
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body: `🔗 Fix available in #${pr.number}`
  });
  
  return pr;
}

/**
 * Post status comment on issue
 */
async function postComment(octokit, owner, repo, issueNumber, status) {
  let emoji, title, body;
  
  switch (status.status) {
    case 'starting':
      emoji = '🤖';
      title = 'Viberon is working...';
      body = status.message;
      break;
      
    case 'resolved':
      emoji = '✅';
      title = 'Fix generated successfully!';
      body = status.prUrl 
        ? `A pull request has been created: #${status.prNumber}\n\n${status.prUrl}`
        : status.message || 'Fix completed';
      break;
      
    case 'failed':
      emoji = '❌';
      title = 'Fix attempt failed';
      body = status.message || 'Viberon could not generate a fix for this issue. See action logs for details.';
      break;
      
    case 'incomplete':
      emoji = '⚠️';
      title = 'Fix incomplete';
      body = status.message || 'Viberon made progress but did not complete the fix within the time limit.';
      break;
      
    default:
      emoji = 'ℹ️';
      title = 'Fix status';
      body = status.message || '';
  }
  
  const stats = (status.tokens || status.timeMs) 
    ? `\n\n**Stats:** ${status.tokens ? status.tokens + ' tokens' : ''} ${status.timeMs ? '• ' + Math.round(status.timeMs / 1000) + 's' : ''}`
    : '';
  
  const comment = `${emoji} **${title}**\n\n${body}${stats}`;
  
  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: parseInt(issueNumber),
    body: comment
  });
}

// Run the action
run();
