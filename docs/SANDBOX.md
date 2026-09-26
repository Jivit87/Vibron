# Docker Sandbox Execution

**Status:** ✅ Implemented (v1.0)  
**Since:** 2026-09-27

---

## Overview

Viberon can execute commands in isolated Docker containers for enhanced security when working with untrusted repositories. The sandbox provides:

- **Filesystem Isolation** - Read-only root, writable workspace only
- **Network Isolation** - No internet access by default (configurable)
- **Resource Limits** - CPU, memory, and process limits prevent abuse
- **Automatic Cleanup** - Containers removed after execution

---

## When to Use Sandboxing

**✅ Recommended for:**
- Cloned external/untrusted repositories
- Running unknown build scripts or tests
- Executing code from GitHub issues
- CI/CD pipelines
- Headless evaluation runs

**❌ Not necessary for:**
- Your own trusted local projects
- Verified internal repositories
- Desktop IDE development (unless paranoid)

---

## System Requirements

### Docker Installation

**macOS:**
```bash
# Install Docker Desktop
brew install --cask docker

# Or download from: https://docker.com/products/docker-desktop
```

**Linux:**
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install docker.io

# Start Docker daemon
sudo systemctl start docker
sudo systemctl enable docker

# Add your user to docker group (optional, for non-root)
sudo usermod -aG docker $USER
```

**Verification:**
```bash
docker --version
# Should show: Docker version 24.0+ or higher

docker ps
# Should not error (indicates Docker daemon running)
```

---

## Usage

### Programmatic API

#### Basic Command Execution

```typescript
import { startCommand, waitFor } from "@/lib/terminal";

const session = startCommand({
  repoKey: "my-repo",
  command: "npm test",
  cwd: "/path/to/workspace",
  sandbox: { 
    enabled: true 
  }
});

const result = await waitFor(session);
console.log("Exit code:", result.exitCode);
console.log("Output:", result.buffer.toString());
```

#### With Resource Limits

```typescript
const session = startCommand({
  repoKey: "my-repo",
  command: "npm install && npm run build",
  cwd: "/path/to/workspace",
  sandbox: {
    enabled: true,
    memoryMb: 2048,    // 2GB RAM limit
    cpus: 2,           // 2 CPU cores
    pidsLimit: 256,    // Max 256 processes
    network: "restricted"  // Allow package registries
  }
});
```

#### Harness Integration (Solve Task)

```typescript
import { solveTask } from "@/lib/harness/solve";

const result = await solveTask({
  handle: workspace,
  task: "Fix the authentication bug",
  model: "claude-sonnet-4",
  emit: eventSink,
  runId: "run-123",
  budget: { maxTurns: 10 },
  verify: { enabled: true, /* ... */ },
  
  // Enable sandbox for entire solve run
  sandbox: {
    enabled: true,
    memoryMb: 4096,
    cpus: 2,
    network: "restricted"
  }
});
```

---

## Configuration Options

### SandboxConfig

```typescript
interface SandboxConfig {
  // Enable/disable sandboxing
  enabled: boolean;
  
  // Docker image (default: "viberon/sandbox:latest")
  image?: string;
  
  // Memory limit in MB (default: 4096)
  memoryMb?: number;
  
  // CPU cores (default: 2)
  cpus?: number;
  
  // Max processes to prevent fork bombs (default: 256)
  pidsLimit?: number;
  
  // Network mode (default: "none")
  network?: "none" | "host" | "bridge" | "restricted";
  
  // Allowed domains for "restricted" mode
  allowedDomains?: string[];
  
  // Container startup timeout in ms (default: 30000)
  startupTimeoutMs?: number;
  
  // Extra docker run arguments
  extraArgs?: string[];
}
```

### Network Modes

| Mode | Description | Use Case |
|:-----|:------------|:---------|
| `none` | No network access (default) | Maximum security, no external deps |
| `restricted` | Only package registries allowed | Normal development (npm, pip, cargo) |
| `bridge` | Full internet access | When external APIs needed |
| `host` | Host network (no isolation) | Advanced use only |

**Package registries allowed in `restricted` mode:**
- npm: `registry.npmjs.org`, `registry.yarnpkg.com`
- Python: `pypi.org`, `files.pythonhosted.org`
- Rust: `crates.io`, `static.crates.io`
- Go: `proxy.golang.org`, `sum.golang.org`
- Maven: `repo1.maven.org`
- Ruby: `rubygems.org`
- GitHub: `github.com`, `objects.githubusercontent.com`

---

## Behavior

### Automatic Fallback

When Docker is not available, Viberon **automatically falls back** to direct execution with a warning:

```
[sandbox requested but Docker is not available; falling back to direct execution]
$ npm test
... (command output) ...
```

**No errors are thrown** - commands still execute normally.

### Container Lifecycle

1. **Start:** Container spins up when first command runs
2. **Execute:** Commands run via `docker exec` in container
3. **Persist:** Container stays alive during session
4. **Cleanup:** Container automatically removed on:
   - Command completion
   - Session kill
   - Process exit

### Filesystem Access

**Read-Only:**
- `/` (root)
- `/etc` (configs)
- `/usr` (binaries)
- `/lib` (libraries)

**Writable:**
- `/workspace` (your project, bind-mounted)
- `/tmp` (temporary files)
- `/home` (if using non-root user)

### Example Output

```
$ npm test

[starting sandbox container...]
[sandbox ready: viberon-sandbox-a1b2c3d4]

> test
> vitest run

✓ tests/feature.test.ts (10 tests)

Test Files  1 passed (1)
Tests       10 passed (10)

[exited with code 0]
[sandbox container stopped]
```

---

## Security Model

### Threat Mitigation

| Attack Vector | Mitigation | Effectiveness |
|:--------------|:-----------|:--------------|
| Malicious Makefile | Container isolation | ✅ High |
| Fork bomb (DoS) | PID limit (256) | ✅ High |
| Memory exhaustion | Memory limit (4GB) | ✅ High |
| Data exfiltration | Network disabled | ✅ High |
| Host filesystem tampering | Read-only root FS | ✅ High |
| Privilege escalation | Dropped capabilities | ✅ High |
| Container escape | Docker security model | ✅ Medium |

### What's NOT Protected

- **Side-channel attacks** - CPU timing, cache timing (out of scope)
- **Docker daemon vulnerabilities** - Keep Docker updated
- **Kernel vulnerabilities** - Use secure kernel, keep updated
- **Host resource exhaustion** - Multiple containers can consume resources

### Best Practices

1. **Keep Docker Updated**
   ```bash
   # Check for updates regularly
   docker version
   brew upgrade docker  # macOS
   ```

2. **Use Resource Limits**
   ```typescript
   sandbox: {
     enabled: true,
     memoryMb: 2048,  // Don't allow unlimited
     cpus: 2,         // Limit CPU usage
     pidsLimit: 256   // Prevent fork bombs
   }
   ```

3. **Use `restricted` Network Mode for Dependencies**
   ```typescript
   sandbox: {
     enabled: true,
     network: "restricted"  // Allows npm/pip but not arbitrary internet
   }
   ```

4. **Monitor Container Usage**
   ```bash
   # Check running containers
   docker ps
   
   # Check resource usage
   docker stats
   ```

---

## Troubleshooting

### Docker Not Available

**Symptom:** Commands fall back to direct execution

**Solutions:**
1. Check Docker is running:
   ```bash
   docker ps
   ```

2. Start Docker Desktop (macOS):
   ```bash
   open -a Docker
   ```

3. Start Docker daemon (Linux):
   ```bash
   sudo systemctl start docker
   ```

4. Check Docker socket permissions:
   ```bash
   ls -la /var/run/docker.sock
   sudo chmod 666 /var/run/docker.sock  # If needed
   ```

### Container Startup Timeout

**Symptom:** `[sandbox startup failed: timeout]`

**Solutions:**
1. Increase timeout:
   ```typescript
   sandbox: {
     enabled: true,
     startupTimeoutMs: 60_000  // 60 seconds
   }
   ```

2. Pull image manually (slow first time):
   ```bash
   docker pull viberon/sandbox:latest
   # Or: docker pull node:20-slim (fallback image)
   ```

3. Check Docker performance:
   ```bash
   docker info  # Check for warnings
   ```

### Commands Fail in Sandbox

**Symptom:** Commands work directly but fail in sandbox

**Common Issues:**

1. **Missing network access for dependencies:**
   ```typescript
   sandbox: {
     enabled: true,
     network: "restricted"  // Or "bridge" if registries insufficient
   }
   ```

2. **Insufficient memory:**
   ```typescript
   sandbox: {
     enabled: true,
     memoryMb: 8192  // Increase to 8GB
   }
   ```

3. **File permissions in workspace:**
   - Sandbox runs as same UID as host user
   - Check file ownership: `ls -la /path/to/workspace`

4. **Path-specific dependencies:**
   - Some tools need to be installed in container
   - Use custom image with pre-installed tools

### Orphaned Containers

**Symptom:** `docker ps` shows old `viberon-sandbox-*` containers

**Solution:**
```bash
# List orphaned containers
docker ps -a | grep viberon-sandbox

# Remove all Viberon containers
docker ps -a | grep viberon-sandbox | awk '{print $1}' | xargs docker rm -f

# Or remove all stopped containers
docker container prune -f
```

### Performance Issues

**Symptom:** Commands slower in sandbox

**Expected Overhead:**
- First run (cold): ~2-5 seconds (image pull)
- Warm start: ~500ms-1s (container start)
- Per-command: ~50ms overhead (docker exec)

**Optimization:**
1. Pre-pull image:
   ```bash
   docker pull viberon/sandbox:latest
   ```

2. Use persistent container for multiple commands (already done automatically)

3. Increase Docker resources (Docker Desktop → Preferences → Resources)

---

## Custom Docker Images

### Building Custom Image

If you need additional tools not in the default image:

1. Create `Dockerfile`:
   ```dockerfile
   FROM viberon/sandbox:latest
   
   # Install additional tools
   RUN apt-get update && apt-get install -y \
       postgresql-client \
       redis-tools \
       && rm -rf /var/lib/apt/lists/*
   
   # Install language-specific tools
   RUN pip3 install --no-cache-dir black ruff
   RUN npm install -g prettier eslint
   ```

2. Build image:
   ```bash
   docker build -t my-viberon-sandbox:latest .
   ```

3. Use in config:
   ```typescript
   sandbox: {
     enabled: true,
     image: "my-viberon-sandbox:latest"
   }
   ```

### Base Image Contents

The default `viberon/sandbox:latest` includes:

**Languages:**
- Node.js 20 (LTS)
- Python 3.11
- System build tools (gcc, make, g++)

**Package Managers:**
- pnpm, yarn, npm
- pip, venv

**Development Tools:**
- git
- curl, wget
- jq (JSON processor)
- ripgrep (fast grep)

**TypeScript Tooling:**
- typescript
- tsx
- vitest
- jest

---

## Performance Characteristics

### Benchmarks

**Simple command (`echo hello`):**
- Direct: ~10ms
- Sandbox (warm): ~60ms
- Sandbox (cold): ~2000ms

**npm install (small project):**
- Direct: ~5s
- Sandbox (network: restricted): ~6s
- Overhead: ~20%

**Test suite (100 tests):**
- Direct: ~10s
- Sandbox: ~11s
- Overhead: ~10%

### Resource Usage

**Typical Sandbox Container:**
- Memory: ~200MB overhead + your app
- Disk: ~1GB for image + your workspace
- CPU: <5% when idle, matched to your limits when active

**Recommended Limits:**
- Small projects: 1GB RAM, 1 CPU
- Medium projects: 2-4GB RAM, 2 CPUs
- Large builds: 4-8GB RAM, 4 CPUs

---

## Environment Variables

Sandbox automatically inherits safe environment variables:

**Passed Through:**
- `HOME`
- `USER`
- `PATH` (container's PATH)
- `SHELL`
- `LANG`, `LC_*`

**Scrubbed (Not Passed):**
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- Any `*_API_KEY`, `*_SECRET`, `*_TOKEN` variables

**Added by Sandbox:**
- `FORCE_COLOR=0` (disable color output)
- `CI=1` (enable CI mode for tools)
- `NO_COLOR=1` (disable color output)

---

## FAQ

### Q: Does sandboxing slow down development?

**A:** Minimal impact (~10-20% overhead). First run is slower (image pull), subsequent runs are fast.

### Q: Can I disable sandboxing?

**A:** Yes, just don't pass `sandbox: { enabled: true }` or set `enabled: false`.

### Q: What if Docker isn't installed?

**A:** Automatic fallback to direct execution with warning. No errors.

### Q: Can I use my existing Dockerfile?

**A:** Yes! Just specify `image: "your-image:tag"` in config.

### Q: Does it work on Windows?

**A:** Yes, with Docker Desktop. WSL2 backend recommended.

### Q: Can I access host services (databases, etc.)?

**A:** Yes, use `network: "host"` mode (loses network isolation).

### Q: What about container cleanup?

**A:** Automatic on command completion, session kill, or process exit.

### Q: Can I SSH into the sandbox?

**A:** No SSH, but you can exec into running container:
```bash
docker exec -it viberon-sandbox-XXXX bash
```

### Q: Is it production-ready?

**A:** Yes! Thoroughly tested, graceful fallback, automatic cleanup.

---

## API Reference

See [SANDBOX_DESIGN.md](./SANDBOX_DESIGN.md) for:
- Architecture details
- Security analysis
- Integration points
- Testing strategy

See [SANDBOX_VALIDATION.md](./SANDBOX_VALIDATION.md) for:
- Validation test cases
- Manual testing procedures
- Performance benchmarks
- Troubleshooting procedures

---

## Version History

**v1.0 (2026-09-27)**
- ✅ Initial implementation
- ✅ Terminal integration
- ✅ Harness integration
- ✅ Automatic fallback
- ✅ Resource limits
- ✅ Network isolation
- ✅ Comprehensive tests

---

## Support

**Issues:** https://github.com/Jivit87/Vibron/issues  
**Docs:** https://github.com/Jivit87/Vibron/tree/main/docs

**Common Issues:**
- Docker not starting → Check Docker Desktop/daemon
- Slow first run → Pre-pull image with `docker pull`
- Network errors → Use `network: "restricted"` for package managers
- Permission errors → Check workspace file ownership

---

**Last Updated:** 2026-09-27  
**Author:** Viberon Development Team  
**Status:** Production Ready ✅
