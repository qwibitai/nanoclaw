# Cloud Storage Mount Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give agent containers read-write access to cloud storage via rclone FUSE mount — configuration only, no code changes.

**Architecture:** rclone mounts a cloud provider as a local directory (`~/cloud-drive`) on the host. NanoClaw's existing additional mounts system exposes it to containers at `/workspace/extra/cloud-drive`. Agents use standard file tools.

**Tech Stack:** rclone, FUSE, systemd, SQLite (for group config updates)

**Spec:** `docs/superpowers/specs/2026-03-21-cloud-storage-mount-design.md`

**Current state:** rclone is not installed. `user_allow_other` is already set in `/etc/fuse.conf`. Mount allowlist exists at `~/.config/nanoclaw/mount-allowlist.json` with one entry (`~/sim-workdir`).

---

### Task 1: Install rclone and configure cloud provider

This task requires user interaction (OAuth browser flow), so the user must run some commands themselves.

**Files:** None (system-level install + interactive config)

- [ ] **Step 0: Verify FUSE is configured for Docker access**

```bash
grep -q '^user_allow_other' /etc/fuse.conf && echo "OK" || echo "MISSING: add user_allow_other to /etc/fuse.conf"
```

Must show `OK`. If missing, add `user_allow_other` to `/etc/fuse.conf` (requires sudo).

- [ ] **Step 1: Install rclone**

```bash
curl https://rclone.org/install.sh | sudo bash
```

Verify: `rclone version` should show v1.53+. Note the binary path from `which rclone` — if it's not `/usr/bin/rclone`, update the `ExecStart` path in the systemd service file (Task 2).

- [ ] **Step 2: Configure cloud provider (interactive)**

The user must run this themselves — it opens a browser for OAuth:

```bash
rclone config
```

Follow the prompts:
1. `n` for new remote
2. Name it (e.g., `cloud`) — remember this name for later steps
3. Choose provider (Google Drive, OneDrive, Box, etc.)
4. Follow OAuth flow in browser
5. Confirm and quit

Verify: `rclone lsd <remote>:` should list top-level folders

- [ ] **Step 3: Test manual FUSE mount**

```bash
mkdir -p ~/cloud-drive
rclone mount <remote>: ~/cloud-drive --vfs-cache-mode full --allow-other &
```

Wait a few seconds, then verify:

```bash
ls ~/cloud-drive
```

Should show cloud files/folders, not empty.

- [ ] **Step 4: Unmount test**

```bash
fusermount -u ~/cloud-drive
```

Verify: `ls ~/cloud-drive` should show empty directory.

---

### Task 2: Create systemd user service for persistent mount

**Files:**
- Create: `~/.config/systemd/user/nanoclaw-cloud-mount.service`

- [ ] **Step 1: Create the service file**

Replace `<remote>` with the remote name from Task 1 Step 2:

```ini
[Unit]
Description=rclone cloud storage mount for NanoClaw
After=network-online.target
Wants=network-online.target
Before=nanoclaw.service

[Service]
Type=simple
ExecStartPre=-/bin/fusermount -u %h/cloud-drive
ExecStartPre=/usr/bin/mkdir -p %h/cloud-drive
ExecStart=/usr/bin/rclone mount <remote>: %h/cloud-drive \
  --vfs-cache-mode full \
  --vfs-cache-max-age 1h \
  --vfs-cache-max-size 5G \
  --dir-cache-time 30s \
  --allow-other
ExecStop=/bin/fusermount -u %h/cloud-drive
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Write to `~/.config/systemd/user/nanoclaw-cloud-mount.service`.

- [ ] **Step 2: Enable and start the service**

```bash
systemctl --user daemon-reload
systemctl --user enable nanoclaw-cloud-mount.service
systemctl --user start nanoclaw-cloud-mount.service
```

- [ ] **Step 3: Verify the mount is active**

```bash
systemctl --user status nanoclaw-cloud-mount.service
ls ~/cloud-drive
```

Service should be `active (running)`. `ls` should show cloud files.

- [ ] **Step 4: Check logs**

```bash
journalctl --user -u nanoclaw-cloud-mount --no-pager -n 20
```

Should show rclone startup messages, no errors.

---

### Task 3: Update NanoClaw mount allowlist

**Files:**
- Modify: `~/.config/nanoclaw/mount-allowlist.json`

- [ ] **Step 1: Add cloud-drive to allowlist**

Read the current file, then add the `~/cloud-drive` entry to `allowedRoots`:

```json
{
  "allowedRoots": [
    {
      "path": "~/sim-workdir",
      "allowReadWrite": true,
      "description": "Simulation inputs, outputs, and working storage"
    },
    {
      "path": "~/cloud-drive",
      "allowReadWrite": true,
      "description": "Cloud storage (rclone FUSE mount)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

- [ ] **Step 2: Restart NanoClaw to pick up the new allowlist**

The allowlist is cached in memory on startup, so NanoClaw must be restarted:

```bash
systemctl --user restart nanoclaw
```

- [ ] **Step 3: Verify allowlist is loaded**

Check NanoClaw logs for the "Mount allowlist loaded successfully" message:

```bash
journalctl --user -u nanoclaw --no-pager -n 50 | grep -i allowlist
```

Should show `allowedRoots: 2`.

---

### Task 4: Add cloud mount to groups

**Files:**
- Modify: `store/messages.db` (registered_groups table, `container_config` column)

Groups are configured in the `registered_groups` SQLite table. The `container_config` column holds JSON with `additionalMounts`.

- [ ] **Step 1: List current groups and their container configs**

```bash
sqlite3 store/messages.db "SELECT jid, name, folder, container_config FROM registered_groups;"
```

- [ ] **Step 2: Update main group with cloud mount**

For the main group (and any other groups that need access), update `container_config` to include the cloud mount. If `container_config` is NULL, set it fresh. If it already has a value, merge the new mount into existing `additionalMounts`.

Use `json_set` to safely merge — this preserves any existing fields (e.g., `timeout`) in `container_config`:

```bash
sqlite3 store/messages.db "UPDATE registered_groups SET container_config = json_set(
  COALESCE(container_config, '{}'),
  '\$.additionalMounts',
  json('[{\"hostPath\":\"~/cloud-drive\",\"containerPath\":\"cloud-drive\",\"readonly\":false}]')
) WHERE folder = 'main';"
```

This works whether `container_config` is NULL or already has values. Repeat for other groups that need cloud access.

- [ ] **Step 3: Verify the update**

```bash
sqlite3 store/messages.db "SELECT folder, container_config FROM registered_groups WHERE container_config IS NOT NULL;"
```

Should show the `cloud-drive` mount in `additionalMounts`.

**Important:** Restart NanoClaw after this step — group config is cached in memory at startup (not re-read from SQLite per container spawn):

```bash
systemctl --user restart nanoclaw
```

---

### Task 5: Add agent awareness to CLAUDE.md files

**Files:**
- Modify: `groups/main/CLAUDE.md`
- Modify: `groups/global/CLAUDE.md`

Global CLAUDE.md is only mounted for non-main groups, so main needs its own entry.

- [ ] **Step 1: Add cloud storage section to `groups/main/CLAUDE.md`**

Add before the `## Admin Context` section:

```markdown
## Shared Cloud Storage

A shared cloud storage directory is available at `/workspace/extra/cloud-drive/`. Use it to read input files and write output files that the user can access from other devices. Use standard file tools (Read, Write, Edit, Bash) — no special commands needed.
```

- [ ] **Step 2: Add cloud storage section to `groups/global/CLAUDE.md`**

Add the same section to the global CLAUDE.md:

```markdown
## Shared Cloud Storage

A shared cloud storage directory is available at `/workspace/extra/cloud-drive/`. Use it to read input files and write output files that the user can access from other devices. Use standard file tools (Read, Write, Edit, Bash) — no special commands needed.
```

- [ ] **Step 3: Commit the CLAUDE.md changes**

```bash
git add groups/main/CLAUDE.md groups/global/CLAUDE.md
git commit -m "docs: add shared cloud storage note to agent CLAUDE.md files"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Verify mount is active**

```bash
systemctl --user status nanoclaw-cloud-mount.service
ls ~/cloud-drive
```

- [ ] **Step 2: Verify Docker can see the FUSE mount**

```bash
docker run --rm -v ~/cloud-drive:/mnt/test alpine ls /mnt/test
```

Should list cloud files. If empty or errored, the FUSE mount isn't propagating to Docker — check that `user_allow_other` is in `/etc/fuse.conf` and rclone was started with `--allow-other`.

- [ ] **Step 3: Verify NanoClaw is running with updated config**

```bash
systemctl --user status nanoclaw
```

- [ ] **Step 4: Test from the main channel**

Send a message to the main channel asking the agent to:
1. List files in `/workspace/extra/cloud-drive/`
2. Create a test file: `echo "hello from agent" > /workspace/extra/cloud-drive/agent-test.txt`
3. Read it back

- [ ] **Step 5: Verify file appeared in cloud**

Check `~/cloud-drive/agent-test.txt` on the host, and verify it synced to the cloud provider's web interface.

- [ ] **Step 6: Clean up test file**

```bash
rm ~/cloud-drive/agent-test.txt
```
