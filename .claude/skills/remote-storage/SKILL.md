---
name: add-remote-storage
description: Mount remote storage (Nextcloud/WebDAV) and assign it to NanoClaw groups. Use when operator wants to give agents access to remote files.
---

# Add Remote Storage

Mount remote storage into NanoClaw group containers via rclone + systemd.

## Important: Use AskUserQuestion

For every step that requires operator input, use the `AskUserQuestion` tool with structured options so the operator can navigate choices with their cursor. Only fall back to free-text when the input is inherently open-ended (URLs, paths, names).

## Interactive Flow

Follow these steps in order. One question at a time.

### Step 1: Storage Type

Use AskUserQuestion:
- **question:** "What type of remote storage do you want to mount?"
- **header:** "Storage"
- **options:**
  - label: "WebDAV (Recommended)", description: "Nextcloud, ownCloud, or any WebDAV server"
  - label: "S3-compatible", description: "Coming soon — not yet supported"
  - label: "SFTP", description: "Coming soon — not yet supported"

If S3 or SFTP selected, inform that only WebDAV is supported in this version and ask if they want to proceed with WebDAV instead.

### Step 2: WebDAV URL

Use AskUserQuestion:
- **question:** "What's the full WebDAV endpoint URL?"
- **header:** "URL"
- **options:**
  - label: "Nextcloud", description: "https://your-server.com/remote.php/webdav"
  - label: "ownCloud", description: "https://your-server.com/remote.php/dav/files/USERNAME"
  - label: "Other WebDAV", description: "I'll provide the full WebDAV URL"

Based on their selection, ask for the actual URL if needed (the operator will likely choose "Other" and type the URL, or select a template and customize it).

Validate it starts with `http://` or `https://` and contains a path component.

### Step 3: Remote Path

Use AskUserQuestion (free-text expected via "Other"):
- **question:** "What remote path do you want to mount? (folder path relative to the WebDAV root)"
- **header:** "Path"
- **options:**
  - label: "Root (/)", description: "Mount the entire WebDAV root"
  - label: "Custom path", description: "I'll specify a subfolder path (e.g., /Projects/personal/my-folder)"

### Step 4: Mount Name

Use AskUserQuestion (free-text expected via "Other"):
- **question:** "Pick a name for this mount (lowercase, numbers, hyphens only — e.g., gambi-casa)"
- **header:** "Name"
- **options:**
  - label: "Auto-generate", description: "Derive name from the remote path"
  - label: "Custom name", description: "I'll type a name"

If "Auto-generate": derive from the last path segment of the remote path (e.g., `/Projects/personal/gambi-nanoclaw-casa` → `gambi-nanoclaw-casa`).

Validate: `/^[a-z0-9][a-z0-9-]*$/`

Check if name already exists:

```bash
npx tsx setup/index.ts --step remote-mount list
```

If it exists, use AskUserQuestion:
- **question:** "Mount '{name}' already exists. What do you want to do?"
- **header:** "Conflict"
- **options:**
  - label: "Update it", description: "Reconfigure the existing mount"
  - label: "Choose different name", description: "Go back and pick a new name"

### Step 5: Check Dependencies

Run (no user interaction needed unless something is missing):

```bash
npx tsx setup/index.ts --step remote-mount status deps
```

If rclone or fuse3 missing, use AskUserQuestion:
- **question:** "Missing dependencies: {list}. Install them now?"
- **header:** "Dependencies"
- **options:**
  - label: "Install (Recommended)", description: "Run: sudo apt install rclone fuse3"
  - label: "Skip", description: "I'll install them manually later"

If "Install": run `sudo apt install -y rclone fuse3`, then verify again.

Also check that `/etc/fuse.conf` contains `user_allow_other` (required for containers to access the mount):

```bash
grep -q '^user_allow_other' /etc/fuse.conf 2>/dev/null || echo "MISSING"
```

If missing, use AskUserQuestion:
- **question:** "The `user_allow_other` option must be enabled in /etc/fuse.conf. Fix it now?"
- **header:** "FUSE config"
- **options:**
  - label: "Fix automatically (Recommended)", description: "Run: sudo sed -i to uncomment user_allow_other"
  - label: "I'll fix it manually", description: "Skip this step"

If "Fix automatically":

```bash
sudo sed -i 's/^#user_allow_other/user_allow_other/' /etc/fuse.conf
```

### Step 6: Configure rclone Remote

**CRITICAL SAFETY RULES:**
- NEVER ask for username or password in the conversation
- NEVER display credential values
- Always use `!` prefix so commands run in the operator's terminal

The rclone remote must be named `nanoclaw-{name}` (matching the mount name).

Tell the operator:

> I need to configure rclone with your server credentials.
> Please run this in your terminal to create the remote interactively:
>
> `! rclone config`
>
> Create a new remote with:
> - **Name:** `nanoclaw-{name}`
> - **Type:** `webdav`
> - **URL:** `{url}` (the WebDAV URL from Step 2)
> - **Vendor:** choose your server type
> - **User/Pass:** enter when prompted (use a Nextcloud **App Password** if applicable)

Then use AskUserQuestion:
- **question:** "Have you finished configuring the rclone remote?"
- **header:** "rclone"
- **options:**
  - label: "Yes, it's configured", description: "Verify the remote and continue"
  - label: "I need help", description: "Show me more detailed instructions"

After confirmation, verify the remote works:

```bash
rclone lsd nanoclaw-{name}:{remotePath} 2>&1; echo "EXIT:$?"
```

If `EXIT:0`, the remote is working. If non-zero, suggest checking credentials/URL and retrying.

### Step 7: Create Mount

Run:

```bash
npx tsx setup/index.ts --step remote-mount create {name} webdav {url} {remotePath}
```

Parse status output:
- `STATUS=success`: proceed to group assignment. The allowlist is updated automatically.
- `STATUS=mount_failed`: show error, suggest checking rclone remote and network, offer retry
- `STATUS=missing_deps`: go back to Step 5
- `STATUS=missing_remote`: go back to Step 6

### Step 8: Group Assignment

First, list available groups by reading the database:

```bash
npx tsx -e "import { initDatabase, getAllRegisteredGroups } from './src/db.js'; initDatabase(); const g = getAllRegisteredGroups(); for (const [jid, group] of Object.entries(g)) { console.log(group.folder + (group.isMain ? ' (main)' : '')); }"
```

Use AskUserQuestion with multiSelect:
- **question:** "Which groups should have access to mount '{name}'? (You can add more later with /manage-remote-storage)"
- **header:** "Groups"
- **multiSelect:** true
- **options:** (populate from available groups, up to 4; operator can select "Other" for unlisted)
  - label: "{folder1}", description: "Assign read-write access"
  - label: "{folder2}", description: "Assign read-write access"
  - etc.

For each selected group, use AskUserQuestion:
- **question:** "What access level for group '{folder}'?"
- **header:** "Access"
- **options:**
  - label: "Read-write (Recommended)", description: "Group can read and write files"
  - label: "Read-only", description: "Group can only read files"

Then run:

```bash
npx tsx setup/index.ts --step remote-mount assign-group {name} {folder} {ro|rw}
```

Parse status output:
- `STATUS=success`: group assigned
- `STATUS=already_assigned`: group already has this mount
- Error: show error message

After assigning groups, restart NanoClaw so the new mounts take effect on next container spawn:

```bash
sudo systemctl restart nanoclaw
```

### Step 9: Verification

Confirm:

> Remote storage "{name}" configured:
> - **Type:** WebDAV
> - **URL:** {url}
> - **Remote path:** {remotePath}
> - **Mount point:** `/mnt/nanoclaw/{name}/`
> - **Systemd service:** `nanoclaw-mount-{name}.service` (enabled, active)
> - **Mount allowlist:** updated automatically
> - **Groups:** {list with access levels}
>
> The mount persists across reboots. Agents in assigned groups see it at `/workspace/extra/{name}/`.
>
> Tip: add a `CLAUDE.md` file to the remote folder to give agents context about its contents.
