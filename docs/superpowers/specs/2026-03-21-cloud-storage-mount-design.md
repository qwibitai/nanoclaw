# Cloud Storage Mount for Agent Containers

**Date:** 2026-03-21
**Status:** Draft

## Problem

Agent containers need to read and write files in a shared cloud directory (Google Drive, OneDrive, Box, etc.) so that the user can access the same files from other devices.

## Solution

Use rclone to FUSE-mount a cloud storage provider as a local directory on the host. Expose it to agent containers via the existing additional mounts system. No code changes to NanoClaw required — configuration only.

## Design

### Architecture

```
Cloud Provider (Google Drive / OneDrive / Box / etc.)
        ↕  (rclone FUSE)
~/cloud-drive  (host mount point)
        ↕  (Docker bind mount via additional mounts)
/workspace/extra/cloud-drive  (inside container)
        ↕  (standard file tools)
Agent reads/writes files normally
```

### Components

#### 1. rclone FUSE Mount on Host

- Install rclone (v1.53+) on the host
- Run `rclone config` to authenticate with chosen cloud provider (interactive OAuth)
- rclone handles OAuth token refresh automatically (tokens stored in `~/.config/rclone/rclone.conf`). If the refresh token is revoked by the provider (e.g., Google after 6 months of inactivity), the mount will fail with auth errors — re-run `rclone config` to re-authenticate.
- Mount with VFS full cache mode for read-write support:
  ```bash
  rclone mount <remote>: ~/cloud-drive \
    --vfs-cache-mode full \
    --vfs-cache-max-age 1h \
    --vfs-cache-max-size 5G \
    --dir-cache-time 30s \
    --allow-other
  ```
- `--vfs-cache-mode full`: enables full read-write with local caching (suitable for small file workloads)
- `--vfs-cache-max-age 1h`: cache files for 1 hour before re-checking cloud
- `--vfs-cache-max-size 5G`: bounds local cache disk usage to 5 GB
- `--dir-cache-time 30s`: refresh directory listings every 30 seconds
- `--allow-other`: required for Docker containers to access the FUSE mount (needs `user_allow_other` in `/etc/fuse.conf`)

#### 2. Systemd User Service

File: `~/.config/systemd/user/nanoclaw-cloud-mount.service`

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

- Starts before `nanoclaw.service` so the mount is ready when agents spawn
- `ExecStartPre=-/bin/fusermount -u` cleans up stale mounts from a previous crash (the `-` prefix ignores errors if not mounted)
- Uses `Type=simple` for broad compatibility (rclone's `Type=notify` support requires v1.53+ and working FUSE)
- Auto-restarts on failure with 10s delay
- Logs go to journald by default (`journalctl --user -u nanoclaw-cloud-mount`)

#### 3. Mount Allowlist Update

Add the cloud-drive mount point to `~/.config/nanoclaw/mount-allowlist.json`:

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

#### 4. Group Configuration

For groups that need cloud access, add the mount to their `containerConfig.additionalMounts`:

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/cloud-drive",
      "containerPath": "cloud-drive",
      "readonly": false
    }
  ]
}
```

This makes the cloud directory appear at `/workspace/extra/cloud-drive` inside the container.

To give all groups access, add the mount to each group's config via the `register_group` MCP tool or by updating the registered_groups database directly.

#### 5. Agent Awareness

Add a note to both `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md` so all agents know the directory exists. (Global CLAUDE.md is only mounted for non-main groups, so main needs its own entry.)

```markdown
## Shared Cloud Storage

A shared cloud storage directory is available at `/workspace/extra/cloud-drive/`. Use it to read input files and write output files that the user can access from other devices. Use standard file tools (Read, Write, Edit, Bash) — no special commands needed.
```

### What Agents Experience

- Files at `/workspace/extra/cloud-drive/` — standard filesystem semantics
- Use existing tools: Read, Write, Edit, Glob, Grep, Bash
- Writes appear locally immediately, sync to cloud asynchronously
- First read of an uncached file has slight latency (cloud fetch)
- Subsequent reads are instant (local VFS cache)

### Docker + FUSE Mount Compatibility

NanoClaw spawns containers on-demand using `docker run -v` bind mounts. Docker's default `rprivate` propagation does not propagate FUSE mounts created after the bind. However, this is not an issue here because:

1. The systemd service orders `nanoclaw-cloud-mount.service` **before** `nanoclaw.service`
2. NanoClaw starts containers on-demand (when messages arrive), not at boot
3. By the time any container runs, `~/cloud-drive` is already the FUSE filesystem
4. Docker's `-v ~/cloud-drive:/workspace/extra/cloud-drive` binds the FUSE mount directly

If the rclone mount is restarted while a container is running, that container will lose access (stale mount). This is acceptable — containers are short-lived and will get a fresh mount on next spawn.

### FUSE Configuration Prerequisite

The host must allow non-root FUSE access for Docker:

```bash
# /etc/fuse.conf — uncomment or add:
user_allow_other
```

Without this, Docker containers cannot access the FUSE mount.

### Failure Modes

| Scenario | Behavior |
|----------|----------|
| Internet drops while agent writes | Write succeeds locally (VFS cache). Syncs when internet returns. |
| Internet drops while agent reads uncached file | Read fails with I/O error. Agent sees filesystem error. |
| Internet drops while agent reads cached file | Read succeeds (served from cache). |
| rclone mount crashes | Agents see "Transport endpoint is not connected". Systemd auto-restarts mount. |
| Cloud provider quota exceeded | Write fails with I/O error. |
| OAuth refresh token revoked | Mount fails with auth errors. Re-run `rclone config` to re-authenticate. |

### Security

- No cloud credentials enter containers — rclone runs on the host only
- Mount validated against existing allowlist (blocked patterns still apply)
- `nonMainReadOnly: false` means non-main groups get read-write access; set to `true` to restrict them to read-only
- Container path traversal prevented by existing `isValidContainerPath()` validation

## Implementation Steps

1. Install rclone on host
2. Run `rclone config` to authenticate with cloud provider
3. Enable `user_allow_other` in `/etc/fuse.conf`
4. Create mount point directory `~/cloud-drive`
5. Test manual mount: `rclone mount <remote>: ~/cloud-drive --vfs-cache-mode full --allow-other &`
6. Verify mount works: `ls ~/cloud-drive` (should show cloud files, not empty)
7. Unmount test: `fusermount -u ~/cloud-drive`
8. Create and enable systemd user service
7. Add `~/cloud-drive` to mount allowlist
10. Add `additionalMounts` to desired groups
11. Add note to `groups/main/CLAUDE.md` and `groups/global/CLAUDE.md`
12. Test: spawn an agent, verify it can list/read/write files in `/workspace/extra/cloud-drive/`

## Scope

- **In scope:** Host-side rclone setup, systemd service, NanoClaw configuration
- **Out of scope:** Code changes to NanoClaw, new MCP tools, container image changes
