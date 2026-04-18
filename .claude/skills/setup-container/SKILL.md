# NanoClaw Container-First Setup

**Goal:** Complete NanoClaw setup with zero Node.js execution on the host machine.
Everything — `npm install`, `tsc`, setup scripts, the orchestrator itself — runs inside Podman or Docker containers only.

**Prerequisite:** `Containerfile.host` and `run-in-podman.sh` must exist in the project root. If they don't, run `/setup` first and choose the Podman path, or ensure the files are present from a recent git pull.

**Principle:** Never run `node`, `npx`, `npm`, or `tsx` directly on the host. Use the setup runner container for all Node.js execution. Ask for user action only when human interaction is genuinely required (QR code scanning, pasting tokens).

---

## Setup Runner Pattern

The builder stage of `Containerfile.host` includes all deps (including devDeps like `tsx`) and the `setup/` scripts. Build it once as `nanoclaw-setup`, then use it for all setup steps.

**Build the setup runner** (do this once at the start):
```bash
podman build --target builder -f Containerfile.host -t nanoclaw-setup .
```

**Run a setup step** (template — replace `<step>` and args as needed):

On Windows with Git Bash, two things are required:
1. `MSYS_NO_PATHCONV=1` — prevents Git Bash from translating container-internal paths (e.g. `/app/store`) to Windows paths
2. WSL2-format host paths — Podman bind mounts need `/mnt/d/...` format, not Git Bash `/d/...` format

```bash
# Compute WSL2 path once (run this first in your shell session)
WSL_DIR=$(pwd | sed 's|^/\([a-zA-Z]\)/|/mnt/\1/|')

# Template for running a setup step
MSYS_NO_PATHCONV=1 podman run --rm \
    -v "${WSL_DIR}/store:/app/store" \
    -v "${WSL_DIR}/logs:/app/logs" \
    -v "${WSL_DIR}/.env:/app/.env" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step <step> [args...]
```

For steps that write to `~/.config/nanoclaw/` on the host:
```bash
WSL_HOME=$(echo "$HOME" | sed 's|^/\([a-zA-Z]\)/|/mnt/\1/|')
# Add to the run command:
# -v "${WSL_HOME}/.config/nanoclaw:/root/.config/nanoclaw"
```

---

## 0. Git & Fork Setup

Same as standard setup. Run:
```bash
git remote -v
```

- **No `upstream` remote** → `git remote add upstream https://github.com/qwibitai/nanoclaw.git`
- **`origin` points to qwibitai** → user cloned directly; walk them through forking (see `/setup` step 0)
- **Both remotes present** → continue

---

## 1. Build Container Images

Both images must be built before the orchestrator can run.

### 1a. Setup runner (builder stage)
```bash
podman build --target builder -f Containerfile.host -t nanoclaw-setup .
```

Parse output for errors. If it fails:
- Missing `Containerfile.host` → run `/setup` first or check git pull
- `npm ci` failure → check `package-lock.json` is committed; retry

### 1b. Agent container
```bash
CONTAINER_RUNTIME=podman bash container/build.sh
```

If it fails, read the Dockerfile error. Common cause: stale builder cache.
Fix: `podman builder prune -f` then retry.

### 1c. Orchestrator image (runtime stage)
```bash
podman build -f Containerfile.host -t nanoclaw-host .
```

---

## 2. Check Environment

Run:
```bash
podman run --rm \
    -v "$(pwd)/store:/app/store" \
    -v "$(pwd)/logs:/app/logs" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step environment
```

Parse the status block:
- `HAS_AUTH=true` → WhatsApp already configured, note for channel step
- `HAS_REGISTERED_GROUPS=true` → existing config, offer to skip or reconfigure

### OpenClaw Migration Detection

```bash
ls -d ~/.openclaw 2>/dev/null || ls -d ~/.clawdbot 2>/dev/null
```

If found, AskUserQuestion:
1. **Migrate now** — invoke `/migrate-from-openclaw`, then return here
2. **Fresh start** — skip
3. **Migrate later** — continue, run `/migrate-from-openclaw` anytime

---

## 2a. Timezone

```bash
podman run --rm \
    -v "$(pwd)/store:/app/store" \
    -v "$(pwd)/logs:/app/logs" \
    -v "$(pwd)/.env:/app/.env" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step timezone
```

- `STATUS=success` → timezone set, note `RESOLVED_TZ`
- `RESOLVED_TZ=UTC` and user is not actually in UTC → the container defaulted to UTC because it can't see the Windows timezone. Detect it with `powershell.exe -NoProfile -Command "Get-TimeZone | Select-Object -ExpandProperty Id"` then map the Windows timezone name to an IANA name and re-run with `-- --tz <iana-name>` (e.g. "Mountain Standard Time" → `America/Denver`).
- `NEEDS_USER_INPUT=true` → system TZ couldn't be autodetected. AskUserQuestion with common options (America/New_York, Europe/London, Asia/Jerusalem, Asia/Tokyo, Other). Then re-run with `-- --tz <answer>`.

---

## 3. Credential System (OneCLI)

OneCLI runs as a separate service on the host — it's not Node.js, it's a Go binary. Install it natively:

```bash
curl -fsSL onecli.sh/install | sh
curl -fsSL onecli.sh/cli/install | sh
```

If `onecli` is not found after install, add `~/.local/bin` to PATH:
```bash
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' ~/.bashrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
grep -q '.local/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

Point CLI at the local OneCLI instance:
```bash
onecli config set api-host http://127.0.0.1:10254
```

Add `ONECLI_URL` to `.env`:
```bash
grep -q 'ONECLI_URL' .env 2>/dev/null || echo 'ONECLI_URL=http://127.0.0.1:10254' >> .env
```

Check for existing secrets:
```bash
onecli secrets list
```

If an Anthropic secret already exists, confirm with user: keep or reconfigure?

AskUserQuestion: **Claude subscription (Pro/Max)** or **Anthropic API key**?

1. **Claude subscription** — tell user: "Run `claude setup-token` in another terminal and copy the token." Stop and wait for confirmation they have it.

2. **API key** — direct user to their API console for a key.

Then AskUserQuestion — register it via:
1. **Dashboard** — "Open http://127.0.0.1:10254, add secret: type `anthropic`, value = your token/key."
2. **CLI** — `onecli secrets create --name Anthropic --type anthropic --value YOUR_VALUE --host-pattern api.anthropic.com`

**If user's reply contains a token/key** (starts with `sk-ant-`): run the `onecli secrets create` command on their behalf.

After confirmation: verify with `onecli secrets list`. If missing, ask again.

---

## 4. Set Up Channels

AskUserQuestion (multiSelect): Which messaging channels do you want to enable?
- WhatsApp
- Telegram
- Slack
- Discord

For each selected channel, invoke its skill:
- **WhatsApp:** `/add-whatsapp`
- **Telegram:** `/add-telegram`
- **Slack:** `/add-slack`
- **Discord:** `/add-discord`

Each skill handles its own code installation, credentials, auth, and group registration.

**After all channels:** rebuild the orchestrator image to include channel code:
```bash
podman build --target builder -f Containerfile.host -t nanoclaw-setup .
podman build -f Containerfile.host -t nanoclaw-host .
```

---

## 5. Mount Allowlist

AskUserQuestion: Should agents have access to directories outside the project?

**No:**
```bash
mkdir -p "$HOME/.config/nanoclaw"
podman run --rm \
    -v "$(pwd)/store:/app/store" \
    -v "$(pwd)/logs:/app/logs" \
    -v "$HOME/.config/nanoclaw:/root/.config/nanoclaw" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step mounts -- --empty
```

**Yes:** Collect paths and permissions, then:
```bash
podman run --rm \
    -v "$(pwd)/store:/app/store" \
    -v "$(pwd)/logs:/app/logs" \
    -v "$HOME/.config/nanoclaw:/root/.config/nanoclaw" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step mounts -- --json '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}'
```

---

## 6. Start the Orchestrator

```bash
./run-in-podman.sh
```

This builds both images if needed (or uses cached) and starts `nanoclaw-host` as a Podman container with `--restart unless-stopped`.

Check it started:
```bash
podman ps --filter name=nanoclaw-host
```

If the container exited immediately:
```bash
podman logs nanoclaw-host
```

Common causes:
- **Missing `.env`** → create it with at least `ONECLI_URL=http://127.0.0.1:10254`
- **OneCLI not reachable** → verify `curl http://127.0.0.1:10254/api/health` returns OK
- **Podman socket not found** → check `ls /run/podman/podman.sock`; rootless Podman uses `/run/user/$(id -u)/podman/podman.sock` — update the socket path in `run-in-podman.sh`

---

## 7. Verify

```bash
WSL_PROJECT=$(./run-in-podman.sh 2>&1 | grep "Project root" | awk '{print $NF}')
# Or compute manually:
# WSL_PROJECT=/mnt/d/sc/git/nanoclaw

podman run --rm \
    -v "$(pwd)/store:/app/store" \
    -v "$(pwd)/logs:/app/logs" \
    nanoclaw-setup \
    npx tsx setup/index.ts --step verify
```

Fix each failure:
- `SERVICE=stopped` → `./run-in-podman.sh restart`
- `SERVICE=not_found` → re-run step 6
- `CREDENTIALS=missing` → `onecli secrets list`; re-run step 3
- `CHANNEL_AUTH` shows `not_found` → re-invoke that channel's skill
- `REGISTERED_GROUPS=0` → re-invoke channel skills from step 4
- `MOUNT_ALLOWLIST=missing` → re-run step 5

Tell user to test by sending a message in their registered chat, and monitor:
```bash
./run-in-podman.sh logs
```

---

## Troubleshooting

**Orchestrator exits immediately:** `podman logs nanoclaw-host`. Most common: credentials missing, Podman socket path wrong, or .env not found.

**Agent containers don't spawn:** Check `podman logs nanoclaw-host` for "Container spawn error". Ensure Podman socket is mounted correctly in `run-in-podman.sh` and the agent image exists (`podman image ls nanoclaw-agent`).

**Path mismatch errors in agent containers:** The `HOST_PROJECT_ROOT` env var must match the actual WSL2 path of the project. Run `./run-in-podman.sh logs` and look for mount errors.

**Channel not connecting:** Verify credentials are in `.env`. Restart after `.env` changes: `./run-in-podman.sh restart`.

**Rootless Podman socket:** If using rootless Podman, the socket is at `/run/user/$(id -u)/podman/podman.sock`. Update the `PODMAN_SOCK` variable in `run-in-podman.sh`.

**Rebuild everything cleanly:**
```bash
podman builder prune -f
./run-in-podman.sh restart
```

---

## Management Commands

| Task | Command |
|------|---------|
| Start | `./run-in-podman.sh` |
| Stop | `./run-in-podman.sh stop` |
| Restart + rebuild | `./run-in-podman.sh restart` |
| Tail logs | `./run-in-podman.sh logs` |
| Rebuild images only | `./run-in-podman.sh build` |
| Shell into orchestrator | `podman exec -it nanoclaw-host bash` |
| Shell into setup runner | `podman run --rm -it nanoclaw-setup bash` |

---

## 9. Diagnostics

Read `.claude/skills/setup-container/diagnostics.md` and follow every step before completing setup.
