# Task 1.2: LSP Integration - Implementation Plan

**Task:** Integrate Language Server Protocol for real-time compiler diagnostics  
**Status:** 🟡 IN PROGRESS  
**Started:** 2026-09-27  
**Priority:** HIGH  
**Effort:** 4-5 days → 2-3 days (LSP already implemented!)

---

## Discovery: LSP Already Implemented! 🎉

### Existing Implementation

**`lib/lsp/index.ts`** - Complete LSP client (511 lines):
- ✅ `LspManager` class fully implemented
- ✅ Supports TypeScript, Python, Go, Rust
- ✅ `detectAvailableServers()` - Auto-detect installed LSP servers
- ✅ `getDiagnosticsAfterEdit()` - Get diagnostics after file change
- ✅ `getAllDiagnostics()` - Get all diagnostics across files
- ✅ Server lifecycle management (start, shutdown)
- ✅ JSON-RPC 2.0 over stdio communication
- ✅ Diagnostic parsing and formatting
- ✅ File synchronization (didOpen, didChange, didSave)

**`tests/lsp.test.ts`** - Tests already exist (119 lines):
- ✅ Server detection tests
- ✅ Manager initialization tests
- ✅ Diagnostic formatting tests
- ✅ Mock connection tests

### What's Missing

❌ **Integration with agent tools** - LSP diagnostics not sent to agents
❌ **Workspace-level LSP manager** - Need to create manager per workspace
❌ **Editor tool integration** - `write_file` doesn't call LSP
❌ **UI display** - Diagnostics not shown in editor
❌ **Configuration** - No way to enable/disable LSP

---

## Revised Implementation Plan

Since LSP is 80% done, we can complete this task much faster!

### Task 1.2.1: Research & Design ✅ (30 minutes)

**Status:** COMPLETE

**Findings:**
- LSP client is production-ready
- Just needs integration with workspace and tools
- No major architectural changes required

---

### Task 1.2.2: Workspace Integration (2-3 hours)

**Objective:** Create LSP manager instance per workspace

**Changes Required:**

**1. Add LSP manager to WorkspaceHandle**
```typescript
// lib/workspace/index.ts

import { LspManager } from "@/lib/lsp";

export interface WorkspaceHandle {
  // ... existing fields
  lsp?: LspManager;  // NEW: LSP manager for this workspace
}

// In createWorkspace() or openFolder():
const lsp = rootPath ? new LspManager(rootPath) : undefined;
```

**2. Cleanup on workspace close**
```typescript
// In closeWorkspace() or similar:
if (handle.lsp) {
  await handle.lsp.shutdown();
}
```

**Deliverable:** LSP manager lifecycle tied to workspace

---

### Task 1.2.3: Tool Integration (2-3 hours)

**Objective:** Send LSP diagnostics to agents after file edits

**Changes Required:**

**1. Update `write_file` tool** (lib/tools/registry.ts)
```typescript
// After successful file write:
if (ctx.handle.lsp) {
  const diagnostics = await ctx.handle.lsp.getDiagnosticsAfterEdit(
    relativePath,
    content
  );
  
  if (diagnostics) {
    result += "\n" + diagnostics;
  }
}
```

**2. Update `search_and_replace` tool** (same file)
```typescript
// After successful replace:
if (ctx.handle.lsp) {
  const diagnostics = await ctx.handle.lsp.getDiagnosticsAfterEdit(
    filePath,
    newContent
  );
  
  if (diagnostics) {
    result += "\n" + diagnostics;
  }
}
```

**3. Update agent prompts** (lib/agents/prompts.ts or similar)
```
When you edit a file, LSP diagnostics (type errors, lint warnings) will appear
in the tool result. Fix any errors before proceeding.
```

**Deliverable:** Agents receive LSP diagnostics after every edit

---

### Task 1.2.4: Validation (1-2 hours)

**Manual Testing:**

1. **TypeScript Diagnostics**
   ```typescript
   // Create file with error
   const x: number = "string";  // Type error
   
   // Agent should see:
   [LSP] 1 error(s) detected:
     test.ts:1:7: error: Type 'string' is not assignable to type 'number'.
   ```

2. **Python Diagnostics**
   ```python
   # Create file with error
   def foo(x: int) -> str:
       return x  # Type error
   
   # Agent should see:
   [LSP] 1 error(s) detected:
     test.py:2:12: error: Expression of type "int" cannot be assigned to return type "str"
   ```

3. **Multi-file Diagnostics**
   - Edit file A that imports file B
   - Break the import
   - Verify diagnostics show in A

4. **Server Unavailable**
   - Try with language that has no LSP server
   - Verify graceful handling (empty diagnostics)

**Pass Criteria:**
- ✅ Diagnostics appear after file edits
- ✅ Errors shown before warnings
- ✅ Truncated to reasonable length (not overwhelming)
- ✅ Works for TypeScript, Python (others optional)
- ✅ Graceful when server unavailable

---

### Task 1.2.5: Automated Testing (1-2 hours)

**New Test Cases:**

```typescript
// tests/lsp.integration.test.ts

describe("LSP Integration", () => {
  it("provides diagnostics to write_file tool", async () => {
    const workspace = await createTestWorkspace();
    const lsp = new LspManager(workspace.rootPath);
    workspace.lsp = lsp;
    
    // Write file with TypeScript error
    const result = await writeFileTool.run({
      path: "test.ts",
      content: "const x: number = 'string';"
    }, { handle: workspace, ... });
    
    expect(result).toContain("[LSP]");
    expect(result).toContain("error");
  });
  
  it("handles missing LSP server gracefully", async () => {
    const workspace = await createTestWorkspace();
    // Don't create LSP manager
    
    const result = await writeFileTool.run({
      path: "test.ts",
      content: "const x = 1;"
    }, { handle: workspace, ... });
    
    // Should succeed without errors
    expect(result).not.toContain("error");
  });
});
```

**Pass Criteria:** All tests pass

---

### Task 1.2.6: Polish & Documentation (1-2 hours)

**Code Polish:**
- [ ] Add JSDoc comments
- [ ] Error handling improvements
- [ ] Configuration option to enable/disable LSP
- [ ] Logging for debugging

**Documentation Updates:**
- [ ] Update README with LSP feature
- [ ] Add LSP section to ARCHITECTURE.md
- [ ] Document required LSP servers
- [ ] Add troubleshooting guide

**README Addition:**
```markdown
### Real-time Compiler Diagnostics

Viberon integrates with Language Server Protocol (LSP) to provide real-time
compiler feedback as agents edit code. Type errors, lint warnings, and import
issues appear immediately in the agent's tool output, dramatically improving
code quality.

**Supported Languages:**
- TypeScript/JavaScript (`typescript-language-server`)
- Python (`pyright-langserver` or `pylsp`)
- Go (`gopls`)
- Rust (`rust-analyzer`)

**Installation:**
```bash
npm install -g typescript-language-server
pip install 'python-lsp-server[all]'
go install golang.org/x/tools/gopls@latest
rustup component add rust-analyzer
```

**How it works:** After each file edit, LSP diagnostics are automatically
collected and shown to the agent. No configuration needed—if a language server
is installed, Viberon uses it.
```

---

## Implementation Checklist

### Phase 1: Workspace Integration
- [ ] Add `lsp?: LspManager` to `WorkspaceHandle`
- [ ] Create LSP manager in workspace creation
- [ ] Shutdown LSP manager on workspace close
- [ ] Test workspace lifecycle

### Phase 2: Tool Integration
- [ ] Update `write_file` tool to call LSP
- [ ] Update `search_and_replace` tool to call LSP
- [ ] Update agent system prompts
- [ ] Test tool integration

### Phase 3: Validation
- [ ] Manual test: TypeScript errors
- [ ] Manual test: Python errors
- [ ] Manual test: No server available
- [ ] Manual test: Multiple files
- [ ] All manual tests pass

### Phase 4: Automated Testing
- [ ] Write integration tests
- [ ] Test with mock LSP responses
- [ ] Test graceful degradation
- [ ] All tests pass

### Phase 5: Documentation
- [ ] Update README
- [ ] Update ARCHITECTURE.md
- [ ] Add installation guide
- [ ] Add troubleshooting section
- [ ] Create completion report

---

## Success Criteria

### Must Have
- ✅ LSP diagnostics appear in tool results after edits
- ✅ TypeScript support working
- ✅ Python support working
- ✅ Graceful handling when servers unavailable
- ✅ All tests passing
- ✅ Documentation complete

### Should Have
- ✅ Go and Rust support (if servers available)
- ✅ Diagnostic truncation (first 10 errors, 5 warnings)
- ✅ Clear error messages
- ✅ Zero performance impact when disabled

### Nice to Have
- ⏳ UI display of diagnostics
- ⏳ Configuration to enable/disable
- ⏳ Per-language server configuration
- ⏳ Diagnostic caching

---

## Timeline

| Phase | Duration | Status |
|:------|:---------|:-------|
| Research & Design | 30 min | ✅ Complete |
| Workspace Integration | 2-3 hours | ⏳ Pending |
| Tool Integration | 2-3 hours | ⏳ Pending |
| Validation | 1-2 hours | ⏳ Pending |
| Automated Testing | 1-2 hours | ⏳ Pending |
| Polish & Docs | 1-2 hours | ⏳ Pending |
| **Total** | **8-13 hours (~2 days)** | **20% Complete** |

**Revised Estimate:** 2 days (down from 4-5 days)

---

## Risk Assessment

| Risk | Probability | Impact | Mitigation |
|:-----|:------------|:-------|:-----------|
| LSP servers not installed | Medium | Medium | Graceful fallback, clear install docs |
| Performance overhead | Low | Low | Async diagnostics, 2s timeout |
| Breaking changes | Low | High | Comprehensive tests, backward compatible |
| Server crashes | Low | Low | Already handled in LspManager |

**Overall Risk:** LOW - LSP already implemented and tested

---

## Notes

### Why LSP?

From OpenCode research (research.md §3):
> "OpenCode's LSP integration is the single highest-impact feature that Viberon
> was missing. Instead of only catching syntax errors at the verification gate,
> agents get real compiler diagnostics after every edit—type errors, unresolved
> imports, unused variables. This makes agents dramatically more effective."

### Performance Considerations

- LSP diagnostic collection is async with 2s timeout
- Won't block agent execution
- Servers start lazily (only when needed)
- Automatic shutdown on workspace close

### Alternative Approaches Considered

1. **Run tsc/pylint directly** - Slower, doesn't persist state
2. **Parse output of compilers** - Fragile, hard to maintain
3. **Use tree-sitter** - No type checking, only syntax
4. **LSP (chosen)** - Industry standard, persistent, accurate

---

**Status:** Ready to begin Phase 2 (Workspace Integration)  
**Next:** Add LSP manager to WorkspaceHandle
