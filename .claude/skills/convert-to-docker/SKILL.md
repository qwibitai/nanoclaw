---
name: convert-to-docker
description: Convert NanoClaw from Apple Container to Docker for cross-platform support. Use when user wants to run on Linux, switch to Docker, enable cross-platform deployment, or migrate away from Apple Container. Triggers on "docker", "linux support", "convert to docker", "cross-platform", or "replace apple container".
disable-model-invocation: true
---

# Convert to Docker

This skill migrates NanoClaw from Apple Container (macOS-only) to Docker for cross-platform support (macOS and Linux).

**What this changes:**
- Container runtime: Apple Container → Docker
- Mount syntax: `--mount type=bind,...,readonly` → `-v path:path:ro`
- Startup check: `container system status` → `docker info`
- Build commands: `container build/run` → `docker build/run`

**What stays the same:**
- Dockerfile (already Docker-compatible)
- Agent runner code
- Mount security/allowlist validation
- All other functionality

## Prerequisites

Verify Docker is installed before starting:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Install Docker first"
```

If Docker is not installed:
- **macOS**: Download from https://docker.com/products/docker-desktop
- **Linux**: `curl -fsSL https://get.docker.com | sh && sudo systemctl start docker`

## 1. Update Container Runner

Edit `src/container-runner.ts`:

### 1a. Update module comment (around line 3)

```typescript
// Before:
 * Spawns agent execution in Apple Container and handles IPC

// After:
 * Spawns agent execution in Docker container and handles IPC
```

### 1b. Update directory mount comment (around line 88)

```typescript
// Before:
    // Apple Container only supports directory mounts, not file mounts

// After:
    // Docker bind mounts work with both files and directories
```

### 1c. Update env workaround comment (around line 120)

```typescript
// Before:
  // Environment file directory (workaround for Apple Container -i env var bug)

// After:
  // Environment file directory (keeps credentials out of process listings)
```

### 1d. Update buildContainerArgs function

Replace the entire function with Docker mount syntax:

```typescript
function buildContainerArgs(mounts: VolumeMount[]): string[] {
  const args: string[] = ['run', '-i', '--rm'];

  // Docker: -v with :ro suffix for readonly
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}:ro`);
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}
```

### 1e. Update spawn command (around line 204)

```typescript
// Before:
    const container = spawn('container', containerArgs, {

// After:
    const container = spawn('docker', containerArgs, {
```

## 2. Update Startup Check

Edit `src/index.ts`:

### 2a. Replace the container system check function

Find `ensureContainerSystemRunning()` and replace entirely with:

```typescript
function ensureDockerRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    logger.error('Docker daemon is not running');
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Docker is not running                                  ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without Docker. To fix:                     ║');
    console.error('║  macOS: Start Docker Desktop                                   ║');
    console.error('║  Linux: sudo systemctl start docker                            ║');
    console.error('║                                                                ║');
    console.error('║  Install from: https://docker.com/products/docker-desktop      ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Docker is required but not running');
  }
}
```

### 2b. Update the function call in main()

```typescript
// Before:
  ensureContainerSystemRunning();

// After:
  ensureDockerRunning();
```

## 3. Update Build Script

Edit `container/build.sh`:

### 3a. Update build command (around line 15-16)

```bash
# Before:
# Build with Apple Container
container build -t "${IMAGE_NAME}:${TAG}" .

# After:
# Build with Docker
docker build -t "${IMAGE_NAME}:${TAG}" .
```

### 3b. Update test command (around line 23)

```bash
# Before:
echo "  echo '{...}' | container run -i ${IMAGE_NAME}:${TAG}"

# After:
echo "  echo '{...}' | docker run -i ${IMAGE_NAME}:${TAG}"
```

## 4. Update Documentation

Update references in documentation files:

| File | Find | Replace |
|------|------|---------|
| `CLAUDE.md` | "Apple Container (Linux VMs)" | "Docker containers" |
| `README.md` | "Apple containers" | "Docker containers" |
| `README.md` | "Apple Container" | "Docker" |
| `README.md` | Requirements section | Update to show Docker instead |
| `docs/REQUIREMENTS.md` | "Apple Container" | "Docker" |
| `docs/SPEC.md` | "APPLE CONTAINER" | "DOCKER CONTAINER" |
| `docs/SPEC.md` | All Apple Container references | Docker equivalents |

### Key README.md updates:

**Requirements section:**
```markdown
## Requirements

- macOS or Linux
- Node.js 20+
- [Claude Code](https://claude.ai/download)
- [Docker](https://docker.com/products/docker-desktop)
```

**FAQ - "Why Docker?":**
```markdown
**Why Docker?**

Docker provides cross-platform support (macOS and Linux), a large ecosystem, and mature tooling. Docker Desktop on macOS uses a lightweight Linux VM similar to other container solutions.
```

**FAQ - "Can I run this on Linux?":**
```markdown
**Can I run this on Linux?**

Yes. NanoClaw uses Docker, which works on both macOS and Linux. Just install Docker and run `/setup`.
```

## 5. Update Skills

### 5a. Update `.claude/skills/setup/SKILL.md`

Replace Section 2 "Install Apple Container" with Docker installation:

```markdown
## 2. Install Docker

Check if Docker is installed and running:

\`\`\`bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker is running" || echo "Docker not running or not installed"
\`\`\`

If not installed or not running, tell the user:
> Docker is required for running agents in isolated environments.
>
> **macOS:**
> 1. Download Docker Desktop from https://docker.com/products/docker-desktop
> 2. Install and start Docker Desktop
> 3. Wait for the whale icon in the menu bar to stop animating
>
> **Linux:**
> \`\`\`bash
> curl -fsSL https://get.docker.com | sh
> sudo systemctl start docker
> sudo usermod -aG docker $USER  # Then log out and back in
> \`\`\`
>
> Let me know when you've completed these steps.

Wait for user confirmation, then verify:

\`\`\`bash
docker run --rm hello-world
\`\`\`
```

Update build verification:
```markdown
Verify the build succeeded:

\`\`\`bash
docker images | grep nanoclaw-agent
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK" || echo "Container build failed"
\`\`\`
```

Update troubleshooting section to reference Docker commands.

### 5b. Update `.claude/skills/debug/SKILL.md`

Replace all `container` commands with `docker` equivalents:

| Before | After |
|--------|-------|
| `container run` | `docker run` |
| `container system status` | `docker info` |
| `container builder prune` | `docker builder prune` |
| `container images` | `docker images` |
| `--mount type=bind,source=...,readonly` | `-v ...:ro` |

Update the architecture diagram header:
```
Host (macOS/Linux)                    Container (Docker)
```

## 6. Build and Verify

After making all changes:

```bash
# Compile TypeScript
npm run build

# Build Docker image
./container/build.sh

# Verify image exists
docker images | grep nanoclaw-agent
```

## 7. Test the Migration

### 7a. Test basic container execution

```bash
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

### 7b. Test readonly mounts

```bash
mkdir -p /tmp/test-ro && echo "test" > /tmp/test-ro/file.txt
docker run --rm --entrypoint /bin/bash -v /tmp/test-ro:/test:ro nanoclaw-agent:latest \
  -c "cat /test/file.txt && touch /test/new.txt 2>&1 || echo 'Write blocked (expected)'"
rm -rf /tmp/test-ro
```

Expected: Read succeeds, write fails with "Read-only file system".

### 7c. Test read-write mounts

```bash
mkdir -p /tmp/test-rw
docker run --rm --entrypoint /bin/bash -v /tmp/test-rw:/test nanoclaw-agent:latest \
  -c "echo 'test write' > /test/new.txt && cat /test/new.txt"
cat /tmp/test-rw/new.txt && rm -rf /tmp/test-rw
```

Expected: Both operations succeed.

### 7d. Full integration test

```bash
npm run dev
# Send @AssistantName hello via WhatsApp
# Verify response received
```

## Troubleshooting

**Docker not running:**
- macOS: Start Docker Desktop from Applications
- Linux: `sudo systemctl start docker`
- Verify: `docker info`

**Permission denied on Docker socket (Linux):**
```bash
sudo usermod -aG docker $USER
# Log out and back in
```

**Image build fails:**
```bash
# Clean rebuild
docker builder prune -af
./container/build.sh
```

**Container can't write to mounted directories:**
Check directory permissions on the host. The container runs as uid 1000.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `src/container-runner.ts` | Mount syntax, spawn command, comments |
| `src/index.ts` | Startup check function |
| `container/build.sh` | Build and run commands |
| `CLAUDE.md` | Quick context |
| `README.md` | Requirements, FAQ |
| `docs/REQUIREMENTS.md` | Architecture references |
| `docs/SPEC.md` | Architecture diagram, tech stack |
| `.claude/skills/setup/SKILL.md` | Installation instructions |
| `.claude/skills/debug/SKILL.md` | Debug commands |
