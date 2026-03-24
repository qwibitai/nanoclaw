---
name: add-log-analyzer
description: Add remote log analysis to NanoClaw. Enables Andy to connect to Linux (SSH) and Windows (WinRM) servers, collect system metrics and log entries, and produce AI-assisted diagnostic reports. After installation, say "analyze logs on <hostname>" to get started.
---

# /add-log-analyzer

This skill adds remote log analysis to your NanoClaw instance. After installation Andy can connect to Linux and Windows servers, collect metrics and recent logs, and produce structured diagnostic reports — all without leaving your chat.

**What you can ask after installing:**
- "Analyze logs on web01"
- "Check what's wrong with 192.168.1.20 (Windows, WinRM)"
- "Run a diagnostic on db-server-01 looking back 4 hours"

Andy will connect via SSH (Linux) or WinRM (Windows), collect CPU/memory/disk/network metrics, find today's log files with WARNING+ entries, and return a structured findings report with root cause reasoning, cross-log associations, and remediation steps.

---

## Phase 1: Pre-flight

### Main-channel check

```bash
test -d /workspace/project && echo "MAIN" || echo "NOT_MAIN"
```

If NOT_MAIN, respond:
> This skill must be run in your main NanoClaw channel. Please send `/add-log-analyzer` there.

Then stop.

### Check if already installed

```bash
grep -q "remote-log-analyzer" /workspace/project/container/agent-runner/src/index.ts 2>/dev/null \
  && echo "ALREADY_APPLIED" || echo "NOT_APPLIED"
```

If ALREADY_APPLIED, skip to Phase 3 (Credentials).

---

## Phase 2: Apply code changes

### Ensure the skill remote is registered

```bash
cd /workspace/project
git remote get-url log-analyzer 2>/dev/null \
  || git remote add log-analyzer https://github.com/vmphibian/nanoclaw.git
```

### Merge the skill branch

```bash
cd /workspace/project
git fetch log-analyzer skill/add-log-analyzer
git merge log-analyzer/skill/add-log-analyzer --no-edit
```

If merge conflicts occur, read the conflicted files and resolve them keeping the intent of both sides, then `git add` the resolved files and `git merge --continue`.

### Validate the build

```bash
cd /workspace/project && npm run build
```

The build must be clean before proceeding.

### Rebuild the agent container

```bash
cd /workspace/project && ./container/build.sh
```

This installs PowerShell Core 7, PSWSMan (Linux WinRM), Posh-SSH, and the remote-log-analyzer MCP server into the container image. Takes 3–5 minutes on first build; subsequent builds use the layer cache.

### Propagate to per-group agent-runner source

Existing groups have a per-group copy of the agent-runner source. Copy the updated `index.ts`:

```bash
for dir in /workspace/project/data/sessions/*/agent-runner-src; do
  [ -d "$dir" ] && cp /workspace/project/container/agent-runner/src/index.ts "$dir/"
done
```

---

## Phase 3: Configure credentials

Use `AskUserQuestion` to collect the following for each target machine:
- Hostname or IP address
- OS type (Linux → `ssh`, Windows → `winrm`)
- Username and password (or SSH key path for Linux)
- For Windows: whether to use HTTPS (port 5986) or HTTP (port 5985, default)

**Compute the host slug:** uppercase the hostname/IP and replace every non-alphanumeric character with `_`.

| Hostname | Slug |
|---|---|
| `192.168.1.20` | `192_168_1_20` |
| `web01.prod.example.com` | `WEB01_PROD_EXAMPLE_COM` |
| `db-server-01` | `DB_SERVER_01` |

Add to `/workspace/project/.env` (append — do not overwrite existing content):

```bash
# remote-log-analyzer — <hostname>
RLA_<SLUG>_USERNAME=<username>
RLA_<SLUG>_PASSWORD=<password>
RLA_<SLUG>_PROTOCOL=<ssh|winrm>
# Only needed for WinRM HTTPS (port 5986):
# RLA_<SLUG>_PORT=5986
```

For multiple targets, repeat the block for each one.

### Restart NanoClaw to apply credential changes

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd user service)
systemctl --user restart nanoclaw
```

---

## Phase 4: Verify

Tell the user:
> Send a test message: **"Analyze logs on \<hostname\>"**
>
> Andy should connect, collect metrics and log entries, and report findings within 30–60 seconds.

---

## Troubleshooting

**"RLA credentials not found"**
Check that the `RLA_*` vars are in `.env` with the correct slug. The slug is case-sensitive and must match exactly (dots, hyphens, colons → `_`).

**SSH: "Permission denied"**
Verify username and password are correct for the target. For key-based auth, set `RLA_<SLUG>_KEY_PATH=/path/to/private/key` in `.env`.

**WinRM: "Connection refused" or "WinRM not available"**
Run the following on the Windows target as Administrator:
```powershell
Enable-PSRemoting -Force
Set-Item WSMan:\localhost\Client\TrustedHosts -Value "*" -Force
Restart-Service WinRM
```

**WinRM: "Basic authentication not supported over HTTP"**
This appears when connecting from a Linux NanoClaw host. It is handled automatically by PSWSMan (included in the skill). If it persists, verify the container was rebuilt after the skill merge (`./container/build.sh`).

**No logs found / zero entries**
- Default lookback is 2 hours. Ask Andy to try: *"Analyze logs on \<hostname\> looking back 24 hours"*
- Verify the target OS matches the protocol (`ssh` for Linux, `winrm` for Windows)
- Add application-specific log paths: *"Analyze logs on \<hostname\> and also check /opt/myapp/logs"*

**Container missing pwsh / module not found**
Run `./container/build.sh` to rebuild. If the build fails, verify the skill branch merged correctly:
```bash
grep -c "remote-log-analyzer" /workspace/project/container/Dockerfile
```
Should return `1` or more. If `0`, re-run the merge step.
