---
name: add-classroom-gws
description: Layer Google Workspace integration onto /add-classroom — auto-creates a Drive folder per student via instructor OAuth, shares with the student's email, and exposes the folder as /workspace/drive/ inside the student container via an rclone bind mount.
---

# Add Classroom — Google Workspace

Layered on top of `/add-classroom`. Adds:

- A pair-time consumer that creates each student's Drive folder via
  the instructor's existing Google OAuth, shares it as Editor with
  the student's email, and DMs the folder URL.
- A skeleton-mount contributor that injects `/workspace/drive/` into
  each student's `container.json`, pointing at a per-student rclone
  view path.
- The `--drive-parent` and `--drive-mount-root` CLI flags for
  `class-skeleton.ts` (handled by the contributor; base script
  doesn't know about them).
- The `googleapis` npm dep.

## Prerequisites

- `/add-classroom` must be installed first. The skill aborts otherwise.
- Google OAuth credentials with `drive` scope at
  `~/.config/gws/credentials.json` (already present on most installs
  that ran `/add-gmail-tool` or `/add-gcal-tool`). The skill validates
  this file exists during VERIFY.
- `rclone` installed on the host. The skill does NOT install or
  configure rclone — see `docs/class-setup.md` for the configuration
  steps. (Without rclone running, the bind mounts work but reference
  empty directories; the agent gets no Drive content.)

## Install

### Pre-flight (idempotent)

Skip to **Configure** if all of these are in place:

- `src/class-drive.ts` and `src/class-pair-drive.ts` exist
- `src/class-skeleton-drive-mount.ts` exists
- `googleapis` is in `package.json` dependencies
- `src/index.ts` contains `import './class-pair-drive.js';`
- `scripts/class-skeleton-extensions.ts` contains
  `import '../src/class-skeleton-drive-mount.js';`

### 1. Verify base skill is installed

```bash
[ -f src/class-pair-greeting.ts ] || { echo "Run /add-classroom first."; exit 1; }
```

### 2. Fetch the classroom branch

```bash
git fetch origin classroom
```

### 3. Copy the gws-specific files

```bash
git show origin/classroom:src/class-drive.ts                > src/class-drive.ts
git show origin/classroom:src/class-pair-drive.ts           > src/class-pair-drive.ts
git show origin/classroom:src/class-skeleton-drive-mount.ts > src/class-skeleton-drive-mount.ts
```

### 4. Append the self-registration imports

Append to `src/index.ts` (skip if present):

```typescript
import './class-pair-drive.js';
```

Append to `scripts/class-skeleton-extensions.ts` (skip if present):

```typescript
import '../src/class-skeleton-drive-mount.js';
```

### 5. Install the googleapis dep

```bash
pnpm install googleapis@171.4.0
```

The version is pinned. Bumping past `minimumReleaseAge: 4320` (3
days) requires the `pnpm-workspace.yaml` to permit it — check with
`npm view googleapis time` before changing.

### 6. Build

```bash
pnpm exec tsc --noEmit
pnpm test
```

## Configure (instructor-side)

These steps happen outside the skill — they're prerequisites for
provisioning a real class.

1. **Confirm OAuth credentials exist**:
   ```bash
   jq '.scope' ~/.config/gws/credentials.json | grep -q drive || \
     echo "Run /add-gmail-tool or /add-gcal-tool to authorize Drive scope."
   ```

2. **Create the parent Drive folder** in the instructor's account
   and note the folder ID (the part after `/folders/` in the URL).

3. **Set up rclone** (one-time):
   ```bash
   sudo apt install rclone   # or `brew install rclone` on macOS
   rclone config             # interactive — see docs/class-setup.md
   mkdir -p ~/nanoclaw-drive-mount
   # Add ~/nanoclaw-drive-mount to ~/.config/nanoclaw/mount-allowlist.json
   rclone mount class-drive: ~/nanoclaw-drive-mount/ \
     --vfs-cache-mode writes --dir-cache-time 30s \
     --poll-interval 15s --daemon
   ```

4. **Provision the class** with the gws flags:
   ```bash
   pnpm exec tsx scripts/class-skeleton.ts \
     --count 16 \
     --names "Alice,Bob,..." \
     --drive-parent <FOLDER_ID> \
     --drive-mount-root ~/nanoclaw-drive-mount \
     --kb /srv/class-kb \
     --wiki /srv/class-wiki
   ```

The `--drive-mount-root` defaults to `~/nanoclaw-drive-mount` if
omitted. `--drive-parent` is what tells the gws skill to engage; if
you omit it, the gws contributor returns no mounts and pairing
falls through to the base greeting only.

## What students experience

When a student pairs successfully, the gws consumer fires after the
base greeting:

> Hi Alice! Welcome to class. Send /playground any time to customize…  ← greeting (base)
> Your Google Drive folder is shared with you here: https://drive.google.com/...  ← gws

The folder URL appears in the second message. After ~15s (rclone's
poll cycle), the folder is also visible inside the student's
container at `/workspace/drive/`.
