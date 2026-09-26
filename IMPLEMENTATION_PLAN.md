# Viberon Implementation Plan
## Research-Driven Development Workflow

**Methodology:** Research → Implement → Validate → Test → Fix → Next Task

**Source:** Based on comprehensive competitive analysis in `research.md`

---

## Phase 1: Security & Stability (Weeks 1-3)

### Priority: CRITICAL - Foundation hardening before feature expansion

---

### Task 1.1: Docker Sandbox Execution

**Status:** 🔴 NOT STARTED  
**Priority:** CRITICAL  
**Effort:** HIGH (5-7 days)  
**Impact:** HIGH - Security for untrusted repos

#### Research Phase
- ✅ **Gap Identified:** Viberon lacks execution isolation (research.md §3)
- ✅ **Competitors:** OpenHands (Docker), E2B (Firecracker microVMs), Codex (system sandboxing)
- ✅ **Decision:** Implement Docker-based sandboxing first, then explore Firecracker
- ✅ **Existing Code:** Basic structure in `lib/sandbox/` (needs completion)

#### Implementation Sub-tasks

**1.1.1 Research & Design (Day 1)**
- [ ] Review `lib/sandbox/index.ts` - currently incomplete
- [ ] Study OpenHands sandboxing implementation
- [ ] Design Dockerfile for Viberon agent runtime
- [ ] Define sandbox lifecycle: create → exec → snapshot → destroy
- [ ] Plan network egress controls
- [ ] Document security model

**Deliverable:** `docs/SANDBOX_DESIGN.md`

**1.1.2 Implement Sandbox Manager (Days 2-3)**
- [ ] Complete `lib/sandbox/index.ts`:
  - [ ] `startSandbox(config)` - Create container
  - [ ] `execInSandbox(sandboxId, command)` - Run command
  - [ ] `stopSandbox(sandboxId)` - Clean termination
  - [ ] `snapshotSandbox(sandboxId)` - Save state
  - [ ] `getActiveSandboxes()` - List running
- [ ] Implement Dockerfile with:
  - [ ] Node.js runtime
  - [ ] Python + venv support
  - [ ] Common build tools
  - [ ] Git
  - [ ] Security hardening
- [ ] Add environment variable injection
- [ ] Implement workspace volume mounting
- [ ] Add timeout and resource limits

**Deliverable:** Working `lib/sandbox/` module

**1.1.3 Integrate with Terminal (Day 4)**
- [ ] Modify `lib/terminal/index.ts`:
  - [ ] Add `sandbox?: SandboxConfig` option to `runCommand()`
  - [ ] Route sandboxed commands to Docker container
  - [ ] Stream output from container
  - [ ] Handle container failures gracefully
- [ ] Update `lib/harness/solve.ts` to use sandbox mode
- [ ] Add UI toggle for sandbox mode in settings

**Deliverable:** Sandboxed command execution

**1.1.4 Validation (Day 5)**
- [ ] Manual testing:
  - [ ] Start sandbox container
  - [ ] Execute simple command (`echo hello`)
  - [ ] Execute Python code
  - [ ] Verify file isolation
  - [ ] Test malicious command blocking
  - [ ] Verify cleanup after stop
- [ ] Security validation:
  - [ ] Confirm network isolation
  - [ ] Verify filesystem boundaries
  - [ ] Test resource limits
  - [ ] Confirm no privilege escalation

**Pass Criteria:** All manual tests pass, no security holes

**1.1.5 Automated Testing (Day 6)**
- [ ] Write `tests/sandbox.test.ts`:
  - [ ] Test container lifecycle
  - [ ] Test command execution
  - [ ] Test isolation boundaries
  - [ ] Test error handling
  - [ ] Test cleanup
  - [ ] Test resource limits
- [ ] Run existing test suite - confirm no breaks

**Pass Criteria:** All tests green, no regressions

**1.1.6 Fix & Polish (Day 7)**
- [ ] Fix any test failures
- [ ] Add error messages and logging
- [ ] Update documentation
- [ ] Add configuration examples
- [ ] Performance optimization

**Deliverable:** Production-ready sandbox feature

**Success Criteria:**
- ✅ Sandboxed execution working
- ✅ All tests passing
- ✅ Security validated
- ✅ Documentation complete
- ✅ Zero regressions

**Rollback Plan:** If critical issues, revert and use non-sandbox mode with warnings

---

### Task 1.2: LSP Integration

**Status:** 🔴 NOT STARTED  
**Priority:** HIGH  
**Effort:** MEDIUM (4-5 days)  
**Impact:** HIGH - Real compiler feedback

#### Research Phase
- ✅ **Gap Identified:** No real-time compiler diagnostics (research.md §3)
- ✅ **Competitor:** OpenCode has LSP integration
- ✅ **Existing Code:** Basic structure in `lib/lsp/` (needs completion)
- ✅ **Decision:** Integrate TypeScript, Python, Go, Rust LSP servers

#### Implementation Sub-tasks

**1.2.1 Research & Design (Day 1)**
- [ ] Review `lib/lsp/index.ts` - currently incomplete
- [ ] Study Language Server Protocol spec
- [ ] Research LSP servers for each language:
  - [ ] TypeScript: `typescript-language-server`
  - [ ] Python: `pylsp` or `pyright`
  - [ ] Go: `gopls`
  - [ ] Rust: `rust-analyzer`
- [ ] Design LSP manager lifecycle
- [ ] Plan diagnostic → agent feedback flow

**Deliverable:** `docs/LSP_INTEGRATION.md`

**1.2.2 Implement LSP Manager (Days 2-3)**
- [ ] Complete `lib/lsp/index.ts`:
  - [ ] `startLspServer(language, rootPath)` - Start server
  - [ ] `stopLspServer(serverId)` - Stop server
  - [ ] `getDiagnostics(fileUri)` - Get errors/warnings
  - [ ] `notifyFileChange(fileUri, content)` - Sync edits
  - [ ] `handleMessage()` - Process LSP responses
- [ ] Implement server lifecycle management
- [ ] Add automatic language detection
- [ ] Handle server crashes gracefully

**Deliverable:** Working LSP manager

**1.2.3 Integrate with Editor & Agent (Day 4)**
- [ ] Modify `lib/tools/editor.ts`:
  - [ ] After each edit, get LSP diagnostics
  - [ ] Include diagnostics in tool result
  - [ ] Format errors for model consumption
- [ ] Update agent prompts to mention LSP feedback
- [ ] Add diagnostic display in UI

**Deliverable:** LSP feedback in agent loop

**1.2.4 Validation (Day 4)**
- [ ] Manual testing:
  - [ ] Edit TypeScript file with error
  - [ ] Verify LSP diagnostic appears
  - [ ] Confirm agent receives diagnostic
  - [ ] Test Python, Go, Rust diagnostics
- [ ] Test server restart on crash
- [ ] Verify memory cleanup

**Pass Criteria:** LSP diagnostics flow to agent correctly

**1.2.5 Automated Testing (Day 5)**
- [ ] Write tests in `tests/lsp.test.ts`:
  - [ ] Test server lifecycle
  - [ ] Test diagnostic extraction
  - [ ] Test file synchronization
  - [ ] Test error handling
  - [ ] Test multiple languages
- [ ] Run full test suite

**Pass Criteria:** All tests green

**1.2.6 Fix & Polish (Day 5)**
- [ ] Fix any issues
- [ ] Add configuration for LSP servers
- [ ] Update documentation
- [ ] Performance optimization

**Success Criteria:**
- ✅ LSP servers start automatically
- ✅ Diagnostics appear in agent feedback
- ✅ All tests passing
- ✅ Multi-language support working

---

### Task 1.3: GitHub Action for CI/CD

**Status:** 🔴 NOT STARTED  
**Priority:** HIGH  
**Effort:** LOW-MEDIUM (2-3 days)  
**Impact:** MEDIUM - Enables CI pipelines

#### Research Phase
- ✅ **Gap Identified:** No CI/CD integration (research.md §3)
- ✅ **Competitors:** PR-Agent, Codex have GitHub Actions
- ✅ **Decision:** Create `viberon-action` for automated fixes in CI

#### Implementation Sub-tasks

**1.3.1 Research & Design (Day 1 morning)**
- [ ] Study GitHub Actions API
- [ ] Review PR-Agent's action implementation
- [ ] Design action inputs/outputs
- [ ] Plan authentication flow
- [ ] Document use cases

**Deliverable:** `docs/GITHUB_ACTION.md`

**1.3.2 Implement Action (Day 1-2)**
- [ ] Create `.github/actions/viberon-action/`:
  - [ ] `action.yml` - Action definition
  - [ ] `index.js` - Entry point
- [ ] Implement:
  - [ ] Input parsing (issue, repo, model, etc.)
  - [ ] Viberon CLI invocation
  - [ ] Result parsing
  - [ ] PR creation
  - [ ] Comment posting
- [ ] Add authentication handling
- [ ] Error handling and logging

**Deliverable:** Working GitHub Action

**1.3.3 Validation (Day 2)**
- [ ] Create test repository
- [ ] Configure workflow
- [ ] Trigger action manually
- [ ] Verify:
  - [ ] Action runs successfully
  - [ ] Fix is applied
  - [ ] PR is created
  - [ ] Comments posted
- [ ] Test failure scenarios

**Pass Criteria:** Action works end-to-end

**1.3.4 Testing & Documentation (Day 3)**
- [ ] Write example workflows
- [ ] Document configuration options
- [ ] Add troubleshooting guide
- [ ] Create README for action
- [ ] Add security notes

**Success Criteria:**
- ✅ Action published
- ✅ Example workflows working
- ✅ Documentation complete

---

## Phase 2: Expand Reach (Weeks 4-6)

### Priority: HIGH - Market expansion features

---

### Task 2.1: Multi-Platform Git Support

**Status:** 🔴 NOT STARTED  
**Priority:** HIGH  
**Effort:** MEDIUM (4-5 days)  
**Impact:** HIGH - GitLab, Bitbucket support

#### Research Phase
- ✅ **Gap Identified:** GitHub-only support (research.md §3)
- ✅ **Competitors:** PR-Agent supports multiple platforms
- ✅ **Decision:** Add GitLab and Bitbucket APIs

#### Implementation Sub-tasks

**2.1.1 Research & Design (Day 1)**
- [ ] Study GitLab API
- [ ] Study Bitbucket API
- [ ] Compare with GitHub API
- [ ] Design unified git provider interface
- [ ] Plan authentication for each platform

**Deliverable:** `docs/MULTI_GIT_DESIGN.md`

**2.1.2 Implement Provider Abstraction (Days 2-3)**
- [ ] Create `lib/git-providers/`:
  - [ ] `interface.ts` - Common interface
  - [ ] `github.ts` - GitHub impl (refactor existing)
  - [ ] `gitlab.ts` - GitLab impl
  - [ ] `bitbucket.ts` - Bitbucket impl
  - [ ] `factory.ts` - Provider factory
- [ ] Implement common operations:
  - [ ] Create PR/MR
  - [ ] List issues
  - [ ] Post comments
  - [ ] Get file content
  - [ ] Create/update branch

**Deliverable:** Unified git provider interface

**2.1.3 Integration (Day 4)**
- [ ] Update `lib/deliver/` to use provider abstraction
- [ ] Update `lib/issues/` to use provider abstraction
- [ ] Add provider detection from remote URL
- [ ] Update UI for provider selection
- [ ] Add authentication for each provider

**Deliverable:** Multi-platform support integrated

**2.1.4 Validation & Testing (Day 5)**
- [ ] Manual testing:
  - [ ] Test GitHub (ensure no regression)
  - [ ] Test GitLab MR creation
  - [ ] Test Bitbucket PR creation
- [ ] Write tests for each provider
- [ ] Integration tests
- [ ] Fix any issues

**Success Criteria:**
- ✅ GitLab support working
- ✅ Bitbucket support working
- ✅ No GitHub regressions
- ✅ All tests passing

---

### Task 2.2: Web Browsing Capability

**Status:** 🔴 NOT STARTED  
**Priority:** HIGH  
**Effort:** MEDIUM (3-4 days)  
**Impact:** HIGH - Agents can research docs

#### Research Phase
- ✅ **Gap Identified:** Agents can't browse web (research.md §3)
- ✅ **Competitors:** OpenHands, Cline have browsing
- ✅ **Existing Code:** Basic structure in `lib/browse/` (needs completion)

#### Implementation Sub-tasks

**2.2.1 Research & Design (Day 1 morning)**
- [ ] Review `lib/browse/index.ts` - currently incomplete
- [ ] Study OpenHands browsing implementation
- [ ] Design URL fetching + HTML→Markdown conversion
- [ ] Plan rate limiting and safety
- [ ] Document allowed domains policy

**Deliverable:** Browse tool design

**2.2.2 Implement Browse Tool (Days 1-2)**
- [ ] Complete `lib/browse/index.ts`:
  - [ ] `browseUrl(url)` - Fetch and convert
  - [ ] `searchWeb(query)` - Search engine integration
  - [ ] HTML → Markdown conversion
  - [ ] Extract main content (remove nav/ads)
  - [ ] Handle pagination
  - [ ] Rate limiting
- [ ] Add to tool registry
- [ ] Implement safety checks:
  - [ ] Domain whitelist/blacklist
  - [ ] Size limits
  - [ ] Timeout
  - [ ] User consent for browsing

**Deliverable:** Working browse tool

**2.2.3 Integration (Day 3)**
- [ ] Add browse tool to agent tool sets
- [ ] Update agent prompts
- [ ] Add UI display for browsed pages
- [ ] Add settings for browse permissions

**Deliverable:** Browse integrated into agent

**2.2.4 Validation & Testing (Day 4)**
- [ ] Manual testing:
  - [ ] Browse documentation page
  - [ ] Verify markdown conversion
  - [ ] Test search functionality
  - [ ] Verify rate limiting
  - [ ] Test error handling
- [ ] Write tests in `tests/browse.test.ts`
- [ ] Fix any issues

**Success Criteria:**
- ✅ Agents can browse URLs
- ✅ Content properly converted
- ✅ Safety measures working
- ✅ All tests passing

---

### Task 2.3: Multi-Session Support

**Status:** 🔴 NOT STARTED  
**Priority:** MEDIUM  
**Effort:** MEDIUM (3-4 days)  
**Impact:** MEDIUM - Power user feature

#### Research Phase
- ✅ **Gap Identified:** Single session per workspace (research.md §3)
- ✅ **Competitor:** OpenCode has multi-session
- ✅ **Decision:** Allow multiple concurrent agent sessions

#### Implementation Sub-tasks

**2.3.1 Research & Design (Day 1)**
- [ ] Analyze current session management
- [ ] Design session isolation
- [ ] Plan UI for session switching
- [ ] Design session storage structure

**Deliverable:** Multi-session design doc

**2.3.2 Implement Session Manager (Days 2-3)**
- [ ] Create session management:
  - [ ] Session ID generation
  - [ ] Session state storage
  - [ ] Session isolation (no conflict)
  - [ ] Session switching
  - [ ] Session cleanup
- [ ] Update store to handle multiple sessions
- [ ] Ensure graph/memory isolation

**Deliverable:** Session manager implementation

**2.3.3 UI Integration (Day 3)**
- [ ] Add session switcher to UI
- [ ] Display active sessions
- [ ] Allow session creation/deletion
- [ ] Show session status

**Deliverable:** Multi-session UI

**2.3.4 Validation & Testing (Day 4)**
- [ ] Test multiple concurrent sessions
- [ ] Verify isolation
- [ ] Test session switching
- [ ] Write automated tests

**Success Criteria:**
- ✅ Multiple sessions work
- ✅ Isolation verified
- ✅ UI intuitive
- ✅ Tests passing

---

## Phase 3: Ecosystem & Polish (Weeks 7-10)

### Priority: MEDIUM - User experience enhancements

---

### Task 3.1: Shareable Recipes (YAML Workflows)

**Status:** 🔴 NOT STARTED  
**Priority:** MEDIUM  
**Effort:** MEDIUM (4-5 days)  
**Impact:** MEDIUM - Reusable automation

[Detailed breakdown similar to above tasks...]

---

### Task 3.2: MCP Marketplace

**Status:** 🔴 NOT STARTED  
**Priority:** MEDIUM  
**Effort:** HIGH (5-7 days)  
**Impact:** MEDIUM - Extension ecosystem

[Detailed breakdown similar to above tasks...]

---

### Task 3.3: Embeddable SDK

**Status:** 🔴 NOT STARTED  
**Priority:** MEDIUM  
**Effort:** HIGH (7-10 days)  
**Impact:** HIGH - Third-party ecosystem

[Detailed breakdown similar to above tasks...]

---

### Task 3.4: Plan Versioning & Experiment Branching

**Status:** 🔴 NOT STARTED  
**Priority:** LOW-MEDIUM  
**Effort:** MEDIUM (4-5 days)  
**Impact:** MEDIUM - Better experimentation

[Detailed breakdown similar to above tasks...]

---

## Phase 4: Enterprise & Scale (Weeks 11+)

### Priority: LOW - Future features

---

### Task 4.1: Session Pause/Resume

**Status:** 🔴 NOT STARTED  
**Priority:** LOW  
**Effort:** MEDIUM (3-4 days)  
**Impact:** MEDIUM - Long-running tasks

[Detailed breakdown similar to above tasks...]

---

### Task 4.2: Network Egress Control

**Status:** 🔴 NOT STARTED  
**Priority:** LOW (HIGH for enterprise)  
**Effort:** MEDIUM (3-4 days)  
**Impact:** HIGH - Enterprise security

[Detailed breakdown similar to above tasks...]

---

### Task 4.3: SQLite Persistence

**Status:** 🔴 NOT STARTED  
**Priority:** LOW  
**Effort:** MEDIUM (4-5 days)  
**Impact:** MEDIUM - Data reliability

[Detailed breakdown similar to above tasks...]

---

### Task 4.4: Pre/Post-Tool Hooks

**Status:** 🔴 NOT STARTED  
**Priority:** LOW  
**Effort:** LOW-MEDIUM (2-3 days)  
**Impact:** MEDIUM - Extensibility

[Detailed breakdown similar to above tasks...]

---

### Task 4.5: Browser-Based Trial Mode

**Status:** 🔴 NOT STARTED  
**Priority:** LOW  
**Effort:** HIGH (7-10 days)  
**Impact:** HIGH - User acquisition

[Detailed breakdown similar to above tasks...]

---

## Workflow Template for Each Task

### 📋 Standard Process

#### 1. RESEARCH (10-15% of time)
- [ ] Read existing code
- [ ] Study competitor implementations
- [ ] Make design decisions
- [ ] Document approach
- **Output:** Design document

#### 2. IMPLEMENT (50-60% of time)
- [ ] Write code following design
- [ ] Follow existing patterns
- [ ] Add error handling
- [ ] Add logging
- **Output:** Working code

#### 3. VALIDATE (10-15% of time)
- [ ] Manual testing
- [ ] Verify functionality
- [ ] Check edge cases
- [ ] Security validation
- **Output:** Confidence in implementation

#### 4. TEST (15-20% of time)
- [ ] Write automated tests
- [ ] Run existing test suite
- [ ] Verify no regressions
- [ ] Check coverage
- **Output:** Test suite passing

#### 5. FIX (If errors found)
- [ ] Debug failures
- [ ] Fix bugs
- [ ] Re-validate
- [ ] Re-test
- **Output:** All tests green

#### 6. MOVE TO NEXT
- [ ] Commit changes
- [ ] Update documentation
- [ ] Mark task complete
- [ ] Start next task

---

## Success Metrics

### Per Task
- ✅ All acceptance criteria met
- ✅ All tests passing (no regressions)
- ✅ Documentation updated
- ✅ Code reviewed
- ✅ Performance acceptable

### Per Phase
- ✅ All phase tasks complete
- ✅ Integration testing passed
- ✅ User acceptance testing done
- ✅ Performance benchmarks met

### Overall Project
- ✅ All critical gaps closed
- ✅ Competitive positioning improved
- ✅ User feedback positive
- ✅ No major bugs in production

---

## Risk Management

### High-Risk Tasks
1. **Docker Sandbox** - Complex, security-critical
   - Mitigation: Extensive testing, security review
2. **LSP Integration** - Many edge cases
   - Mitigation: Start with TypeScript only, expand gradually
3. **Multi-Platform Git** - API variations
   - Mitigation: Abstract early, test thoroughly

### Rollback Strategy
- Each task is independently revertible
- Feature flags for new capabilities
- Maintain backward compatibility
- Document rollback procedures

---

## Current Status: Phase 1 Ready to Start

**Next Action:** Begin Task 1.1 (Docker Sandbox) → Research Phase

---

**Document Version:** 1.0  
**Last Updated:** 2026-09-27  
**Owner:** Development Team
