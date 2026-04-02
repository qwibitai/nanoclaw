---
name: manage-remote-storage
description: List, assign, unassign, test, or remove remote storage mounts. Use after /add-remote-storage.
---

# Manage Remote Storage

Manage existing remote storage mounts configured by `/add-remote-storage`.

## Interactive Flow

Start by listing current mounts:

```bash
npx tsx setup/index.ts --step remote-mount list
```

Present the list:

> **Configured remote mounts:**
>
> | Name | Type | URL | Remote Path | Mount Point |
> |------|------|-----|-------------|-------------|
> | {name} | {type} | {url} | {remotePath} | {mountPoint} |
>
> What would you like to do?
> 1. **Assign** a mount to a group
> 2. **Unassign** a mount from a group
> 3. **Test** mount connectivity
> 4. **Remove** a mount entirely
> 5. **Update credentials** for a mount

### Option 1: Assign to Group

Ask for group folder name and access level (ro/rw). Verify mount is active first:

```bash
npx tsx setup/index.ts --step remote-mount status {name}
```

Then assign:

```bash
npx tsx setup/index.ts --step remote-mount assign-group {name} {folder} {ro|rw}
```

Restart NanoClaw after assigning:

```bash
sudo systemctl restart nanoclaw
```

### Option 2: Unassign from Group

Ask for group folder name. Then:

```bash
npx tsx setup/index.ts --step remote-mount unassign-group {name} {folder}
```

### Option 3: Test Connectivity

Check exit code to distinguish success from failure:

```bash
rclone lsd nanoclaw-{name}:{remotePath} 2>&1; echo "EXIT:$?"
```

If `EXIT:0`, show the listing. If non-zero, suggest checking credentials and network.

### Option 4: Remove Mount

Confirm with operator. Then:

```bash
npx tsx setup/index.ts --step remote-mount remove {name}
```

Also unassign from any groups that reference it. Check all groups:

```bash
npx tsx setup/index.ts --step remote-mount unassign-group {name} {folder}
```

Clean the mount-allowlist entry manually if needed (`~/.config/nanoclaw/mount-allowlist.json`).

### Option 5: Update Credentials

**CRITICAL: Never ask for credentials in conversation.**

> Run in your terminal to update the rclone remote interactively:
>
> `! rclone config`
>
> Edit the `nanoclaw-{name}` remote and update credentials.
>
> Then restart the mount:
>
> ```bash
> sudo systemctl restart nanoclaw-mount-{name}.service
> ```
