---
name: setup-windows
description: Set up NanoClaw on Windows via WSL2 + Docker (or Podman). Use when the user wants to run NanoClaw on Windows, set up WSL2, configure Docker on Windows, or get NanoClaw working on a Windows machine. Triggers on "windows", "wsl", "wsl2", "setup windows", "windows setup".
disable-model-invocation: true
---

# Setup Windows (WSL2 + Docker/Podman)

This skill sets up NanoClaw on Windows using WSL2 with Docker Desktop or Podman as the container runtime. NanoClaw runs entirely inside WSL2 — Windows is only the host OS.

**What this does:**
- Validates WSL2 environment (not WSL1)
- Installs Node.js 20+ and Claude Code inside WSL2
- Configures Docker Desktop (WSL2 backend) or Podman rootless
- Applies the `/convert-to-docker` skill for Docker compatibility
- Adapts paths and filesystem for WSL2 performance and security
- Configures systemd user service for persistence
- Runs 5 validation batteries

**Important:** All NanoClaw files must live on the WSL2 native filesystem (`~/`), never on `/mnt/c/`. The Windows mounted filesystem has poor I/O performance and unreliable POSIX semantics that break SQLite and file locking.

## 0. Detect Environment

Before anything, verify we're running inside WSL2:

```bash
# Must be run from inside WSL2, not from Windows PowerShell/CMD
if [ ! -f /proc/version ] || ! grep -qi microsoft /proc/version; then
  echo "ERROR: Not running inside WSL2. Open your WSL2 terminal first."
  echo "From Windows: wsl -d Ubuntu-24.04"
  exit 1
fi

# Verify WSL2 (not WSL1) — WSL2 uses a real Linux kernel
WSL_VERSION=$(cat /proc/version)
if echo "$WSL_VERSION" | grep -q "microsoft-standard-WSL2"; then
  echo "WSL2 detected"
else
  echo "WARNING: This may be WSL1. WSL2 is required for container support."
  echo "Upgrade with: wsl --set-version <distro> 2"
  exit 1
fi

# Verify systemd is PID 1
if [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  echo "systemd is not running. Enable it:"
  echo "Add to /etc/wsl.conf:"
  echo "[boot]"
  echo "systemd=true"
  echo "Then: wsl --shutdown (from PowerShell) and restart WSL2."
  exit 1
fi

echo "Environment OK: WSL2 with systemd"
```

If not inside WSL2, tell the user:

> You need to run this from inside WSL2. Open PowerShell and run:
> ```
> wsl --install Ubuntu-24.04
> ```
> Then open the Ubuntu terminal and clone NanoClaw there:
> ```bash
> git clone https://github.com/<your-fork>/nanoclaw.git ~/nanoclaw
> cd ~/nanoclaw
> claude
> ```
> Then run `/setup-windows` again.

## 1. Install Node.js 20+

Check if Node.js 20+ is installed:

```bash
node --version 2>/dev/null
```

If not installed or version < 20, install via nvm (recommended by Microsoft for WSL2):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm install 20
nvm use 20
nvm alias default 20
```

Verify:

```bash
node --version  # Should be v20.x.x or higher
npm --version
```

## 2. Install Build Dependencies

SQLite native bindings (better-sqlite3) require compilation tools:

```bash
sudo apt-get update -y
sudo apt-get install -y build-essential python3 g++
```

## 3. Choose Container Runtime

Ask the user:

> Which container runtime do you want to use?
> 1. **Docker Desktop** (recommended) — Requires Docker Desktop installed on Windows with WSL2 backend enabled
> 2. **Podman** (rootless) — No Windows-side installation needed, runs entirely inside WSL2

### Option A: Docker Desktop

Verify Docker is accessible from WSL2:

```bash
docker --version && docker info >/dev/null 2>&1 && echo "Docker ready" || echo "Docker not available"
```

If Docker is not available, tell the user:

> Docker Desktop must be installed on Windows with WSL2 backend enabled:
> 1. Download Docker Desktop from https://docker.com/products/docker-desktop
> 2. During install, ensure "Use WSL 2 based engine" is checked
> 3. After install, go to Settings → Resources → WSL Integration
> 4. Enable integration for your Ubuntu distro
> 5. Restart Docker Desktop and your WSL2 terminal
>
> Then run this skill again.

Wait for confirmation, then verify:

```bash
docker run --rm hello-world
```

### Option B: Podman (Rootless)

Install Podman inside WSL2:

```bash
sudo apt-get update -y
sudo apt-get install -y podman
```

Configure `docker` alias for compatibility with NanoClaw's container-runner:

```bash
# Only if 'docker' command doesn't already exist
if ! command -v docker &>/dev/null; then
  echo 'alias docker=podman' >> ~/.bashrc
  echo 'export DOCKER_HOST=unix:///run/user/$(id -u)/podman/podman.sock' >> ~/.bashrc
  source ~/.bashrc
fi
```

Start Podman socket for Docker API compatibility:

```bash
systemctl --user enable --now podman.socket
```

Verify:

```bash
podman --version
podman run --rm docker.io/hello-world
docker run --rm hello-world  # Should work via alias
```

**Security note on Podman rootless:** Podman runs without a root daemon. Containers run as your user, which means no Docker socket exposure risk. This is the more secure option. However, some Docker images that require root inside the container may need `--userns=keep-id` adjustments.

## 4. Clone and Set Up NanoClaw

If NanoClaw is not already cloned inside WSL2:

```bash
# MUST be on WSL2 native filesystem, NOT /mnt/c/
cd ~
git clone https://github.com/<user-fork>/nanoclaw.git ~/nanoclaw
cd ~/nanoclaw
```

**Critical:** If the project is on `/mnt/c/` (Windows filesystem), move it:

```bash
if [[ "$(pwd)" == /mnt/* ]]; then
  echo "WARNING: Project is on Windows filesystem. Moving to WSL2 native filesystem..."
  cp -r "$(pwd)" ~/nanoclaw
  cd ~/nanoclaw
  echo "Project moved to ~/nanoclaw"
fi
```

Install dependencies:

```bash
npm install
```

## 5. Apply Docker Conversion

NanoClaw uses Apple Container by default (macOS-only). Run the `/convert-to-docker` skill to switch to Docker:

```bash
# This is handled by the existing /convert-to-docker skill
# The key changes are:
# - container-runner.ts: spawn('container', ...) → spawn('docker', ...)
# - index.ts: ensureContainerSystemRunning() → ensureDockerRunning()
# - container/build.sh: container build → docker build
```

Run `/convert-to-docker` now. If it has already been applied, verify:

```bash
grep -n "spawn('docker'" src/container-runner.ts && echo "Docker conversion already applied" || echo "Run /convert-to-docker first"
```

After conversion, build:

```bash
npm run build
./container/build.sh
```

Verify the image:

```bash
docker images | grep nanoclaw-agent
```

## 6. WSL2-Specific Adaptations

### 6a. Fix HOME_DIR fallback in config.ts

The default `HOME_DIR` fallback in `src/config.ts` references `/Users/user` (macOS path). Update:

```typescript
// Before:
const HOME_DIR = process.env.HOME || '/Users/user';

// After:
const HOME_DIR = process.env.HOME || require('os').homedir();
```

### 6b. Ensure data directories exist

```bash
mkdir -p ~/nanoclaw/data/{sessions,ipc,env}
mkdir -p ~/nanoclaw/groups/main/logs
mkdir -p ~/nanoclaw/store/auth
```

### 6c. Set file permissions for sensitive data

```bash
chmod 700 ~/nanoclaw/store/auth
chmod 600 ~/nanoclaw/.env 2>/dev/null || true
chmod 700 ~/nanoclaw/data
```

## 7. Configure Persistence (systemd user service)

Create a systemd user service so NanoClaw starts automatically when WSL2 boots:

```bash
mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw WhatsApp Assistant
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/nanoclaw
ExecStart=/bin/bash -lc 'exec node dist/index.js'
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
EOF
```

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw.service
systemctl --user start nanoclaw.service
```

Check status:

```bash
systemctl --user status nanoclaw.service
journalctl --user -u nanoclaw.service --no-pager -n 20
```

**WSL2 persistence note:** By default, WSL2 shuts down after all terminals close. To keep services running:

From PowerShell (on Windows), create a scheduled task or add to startup:
```powershell
wsl -d Ubuntu-24.04 -- bash -c "echo keepalive"
```

Or configure `.wslconfig` on Windows (`%USERPROFILE%\.wslconfig`):
```ini
[wsl2]
# Keep WSL2 running even when no terminal is open
# (requires WSL 2.4.4+)
```

Alternative: Use `loginctl enable-linger $USER` inside WSL2 to keep user services running.

```bash
loginctl enable-linger $USER
```

## 8. Validation Batteries

Run all 5 batteries before considering setup complete.

### Battery 1 — Base Environment

```bash
echo "=== Battery 1: Base Environment ==="
echo -n "WSL2: "; grep -q "microsoft-standard-WSL2" /proc/version && echo "PASS" || echo "FAIL"
echo -n "systemd: "; [ "$(ps -p 1 -o comm=)" = "systemd" ] && echo "PASS" || echo "FAIL"
echo -n "Node.js 20+: "; node -e "process.exit(parseInt(process.version.slice(1)) >= 20 ? 0 : 1)" && echo "PASS" || echo "FAIL"
echo -n "npm: "; npm --version >/dev/null 2>&1 && echo "PASS" || echo "FAIL"
echo -n "Docker/Podman: "; docker info >/dev/null 2>&1 && echo "PASS" || echo "FAIL"
echo -n "Claude Code: "; command -v claude >/dev/null 2>&1 && echo "PASS" || echo "SKIP (install separately)"
echo -n "Native filesystem: "; [[ "$(pwd)" != /mnt/* ]] && echo "PASS" || echo "FAIL (move to ~/)"
```

### Battery 2 — Container Isolation

```bash
echo "=== Battery 2: Container Isolation ==="

# Test container can run
echo -n "Container runs: "
docker run --rm --entrypoint /bin/echo nanoclaw-agent:latest "OK" >/dev/null 2>&1 && echo "PASS" || echo "FAIL"

# Test readonly mount
echo -n "Readonly mount: "
mkdir -p /tmp/nc-test-ro && echo "test" > /tmp/nc-test-ro/file.txt
RESULT=$(docker run --rm --entrypoint /bin/bash -v /tmp/nc-test-ro:/test:ro nanoclaw-agent:latest -c "cat /test/file.txt && touch /test/new.txt 2>&1" 2>&1)
echo "$RESULT" | grep -q "Read-only file system" && echo "PASS" || echo "FAIL"
rm -rf /tmp/nc-test-ro

# Test read-write mount
echo -n "Read-write mount: "
mkdir -p /tmp/nc-test-rw
docker run --rm --entrypoint /bin/bash -v /tmp/nc-test-rw:/test nanoclaw-agent:latest -c "echo 'write-test' > /test/out.txt"
[ "$(cat /tmp/nc-test-rw/out.txt 2>/dev/null)" = "write-test" ] && echo "PASS" || echo "FAIL"
rm -rf /tmp/nc-test-rw

# Test IPC directory works
echo -n "IPC filesystem: "
mkdir -p /tmp/nc-test-ipc
docker run --rm --entrypoint /bin/bash -v /tmp/nc-test-ipc:/workspace/ipc nanoclaw-agent:latest -c "echo '{\"test\":true}' > /workspace/ipc/test.json"
[ -f /tmp/nc-test-ipc/test.json ] && echo "PASS" || echo "FAIL"
rm -rf /tmp/nc-test-ipc
```

### Battery 3 — NanoClaw Functional

```bash
echo "=== Battery 3: NanoClaw Functional ==="

# Build check
echo -n "TypeScript compiles: "
cd ~/nanoclaw && npm run build >/dev/null 2>&1 && echo "PASS" || echo "FAIL"

# Dist exists
echo -n "dist/index.js exists: "
[ -f ~/nanoclaw/dist/index.js ] && echo "PASS" || echo "FAIL"

# Container image exists
echo -n "Container image: "
docker images | grep -q nanoclaw-agent && echo "PASS" || echo "FAIL"

# SQLite works
echo -n "SQLite: "
node -e "require('better-sqlite3')(':memory:').exec('CREATE TABLE t(x); INSERT INTO t VALUES(1); SELECT * FROM t;')" 2>/dev/null && echo "PASS" || echo "FAIL"
```

For full functional testing (WhatsApp connection), run the setup skill after this:
```bash
# Run /setup inside Claude Code to authenticate WhatsApp and test messaging
```

### Battery 4 — Security

```bash
echo "=== Battery 4: Security ==="

# File permissions
echo -n "store/auth permissions: "
PERM=$(stat -c %a ~/nanoclaw/store/auth 2>/dev/null || echo "000")
[ "$PERM" = "700" ] && echo "PASS ($PERM)" || echo "WARN ($PERM — should be 700)"

echo -n ".env permissions: "
if [ -f ~/nanoclaw/.env ]; then
  PERM=$(stat -c %a ~/nanoclaw/.env)
  [ "$PERM" = "600" ] && echo "PASS ($PERM)" || echo "WARN ($PERM — should be 600)"
else
  echo "SKIP (no .env yet)"
fi

# Container doesn't have /mnt/c access
echo -n "No /mnt/c in container: "
RESULT=$(docker run --rm --entrypoint /bin/ls nanoclaw-agent:latest /mnt/c 2>&1 || true)
echo "$RESULT" | grep -q "No such file" && echo "PASS" || echo "FAIL (container can see /mnt/c!)"

# Container runs as non-root
echo -n "Non-root container: "
CUSER=$(docker run --rm --entrypoint /bin/whoami nanoclaw-agent:latest 2>/dev/null)
[ "$CUSER" = "node" ] && echo "PASS (user: $CUSER)" || echo "WARN (user: $CUSER — expected node)"

# Project on native filesystem
echo -n "Native filesystem: "
[[ "$(realpath ~/nanoclaw)" != /mnt/* ]] && echo "PASS" || echo "FAIL"
```

### Battery 5 — Persistence

```bash
echo "=== Battery 5: Persistence ==="

echo -n "systemd service exists: "
[ -f ~/.config/systemd/user/nanoclaw.service ] && echo "PASS" || echo "FAIL"

echo -n "Service enabled: "
systemctl --user is-enabled nanoclaw.service >/dev/null 2>&1 && echo "PASS" || echo "FAIL"

echo -n "Service running: "
systemctl --user is-active nanoclaw.service >/dev/null 2>&1 && echo "PASS" || echo "SKIP (start after WhatsApp auth)"

echo -n "Linger enabled: "
[ -f /var/lib/systemd/linger/$USER ] && echo "PASS" || echo "WARN (run: loginctl enable-linger $USER)"
```

## 9. Security Checklist

Run this final checklist to verify the security model is maintained:

- [ ] NanoClaw runs on WSL2 native filesystem (`~/`), not `/mnt/c/`
- [ ] Container runtime is Docker or Podman (not running containers as root if Podman)
- [ ] Containers use the same mount allowlist pattern (only explicit mounts)
- [ ] `store/auth/` directory has 700 permissions
- [ ] `.env` file has 600 permissions (if exists)
- [ ] Containers cannot access `/mnt/c/` or the Windows filesystem
- [ ] Containers run as non-root user (`node`, uid 1000)
- [ ] Each container is ephemeral (`--rm`)
- [ ] Only `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` are exposed to containers
- [ ] WSL2 interop is understood: Windows processes can access WSL2 filesystem via `\\wsl$\`

## Troubleshooting

**Docker not accessible from WSL2:**
- Open Docker Desktop → Settings → Resources → WSL Integration → Enable for your distro
- Restart Docker Desktop and WSL2 terminal

**Podman "permission denied" errors:**
```bash
podman system reset
systemctl --user restart podman.socket
```

**SQLite "module not found" or compilation errors:**
```bash
sudo apt-get install -y build-essential python3 g++
cd ~/nanoclaw && rm -rf node_modules && npm install
```

**Slow filesystem performance:**
- Move ALL project files to `~/` (WSL2 native ext4)
- Never use `/mnt/c/` or `/mnt/d/` for NanoClaw data
- Check with: `df -T .` — should show `ext4`, not `9p`

**WSL2 shuts down and service stops:**
```bash
# Inside WSL2:
loginctl enable-linger $USER

# Or from Windows PowerShell (keep WSL running):
wsl -d Ubuntu-24.04 --exec bash -c "while true; do sleep 3600; done" &
```

**Container build fails with network errors:**
```bash
# WSL2 DNS issues — add Google DNS
echo "nameserver 8.8.8.8" | sudo tee /etc/resolv.conf
# Make it persist:
echo -e "[network]\ngenerateResolvConf = false" | sudo tee /etc/wsl.conf
```

## Summary

After completing this skill, NanoClaw is running on Windows via WSL2 with:
- Docker Desktop or Podman as the container runtime
- All files on WSL2 native filesystem for performance
- systemd user service for persistence
- The same security model as macOS (container isolation, mount allowlist, non-root execution)
- 5 validation batteries passed
