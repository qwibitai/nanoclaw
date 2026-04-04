---
name: mount-openclaw-persona
description: Mount an OpenClaw workspace into NanoClaw containers. OpenClaw workspaces are git-managed directories containing agent persona, memory, and skills (AGENTS.md, SOUL.md, memory/, skills/, etc.). This skill bridges the two systems so NanoClaw's container agent can use an existing OpenClaw workspace as its identity and memory store.
---

# Mount OpenClaw Workspace

## What is an OpenClaw Workspace?

[OpenClaw](https://github.com/openclaw/openclaw) is a personal AI assistant platform. An OpenClaw **workspace** is a git-managed directory that holds an agent's persona, memory, and skills. Workspaces are version-controlled — every memory update is committed, giving the agent a full history of its identity over time.

### Typical workspace structure

```
workspace/
  AGENTS.md          # Main instructions: session startup, memory rules, behavior
  SOUL.md            # Core identity, values, personality
  IDENTITY.md        # Appearance, speech patterns (optional)
  VOICE.md           # Tone and voice guidelines (optional)
  USER.md            # Info about the human the agent serves
  MEMORY.md          # Distilled important memories
  TOOLS.md           # Environment-specific tool notes
  HEARTBEAT.md       # Heartbeat/polling behavior (optional)
  memory/            # Episodic memory (date-based files)
    YYYY-MM-DD.md
    YYYY-MM-DD-sNN-topic.md
    {topic}/*.md     # Topic-organized notes
    archives/        # Older consolidated memories
  skills/            # OpenClaw skills (SKILL.md + scripts)
  config/            # MCP and tool configuration
  scripts/           # Custom scripts
```

Not all files are present in every workspace. `AGENTS.md` is the entrypoint — it describes the session startup procedure and references other files.

### Key difference from NanoClaw

NanoClaw stores agent instructions in `groups/{name}/CLAUDE.md`. OpenClaw spreads this across multiple specialized files. The workspace is designed to be the agent's entire world — persona, memory, and tools in one place, versioned with git.

## Goal

Mount an OpenClaw workspace into a NanoClaw container as a read-write volume so the agent can:

- Read persona files (identity, values, memory) on session startup
- Write new memories and commit them via git
- Use workspace skills and tools
- Preserve the existing git-based version management workflow

## Prerequisites

- A working NanoClaw installation with at least one registered group
- An OpenClaw workspace directory (local or as a git repo to clone)
- Git configured on the host

## Phase 1: Locate or Clone the Workspace

Ask the user:

1. **Do you already have the workspace on this machine?** If yes, get the absolute path.
2. **If not, where is it?** Get the git remote URL and ask where to clone it.

```bash
git clone <remote-url> <target-path>
```

Record the absolute path for later steps. Verify the workspace looks correct:

```bash
ls <workspace-path>/AGENTS.md <workspace-path>/SOUL.md 2>/dev/null
```

At minimum, `AGENTS.md` should exist.

## Phase 2: Mount Allowlist

The mount allowlist at `~/.config/nanoclaw/mount-allowlist.json` controls which host directories can be mounted into containers. The workspace path (or its parent) must be listed.

### Check if allowlist exists

```bash
cat ~/.config/nanoclaw/mount-allowlist.json 2>/dev/null
```

### If it doesn't exist, create it

```json
{
  "allowedRoots": [
    {
      "path": "<parent-directory-of-workspace>",
      "allowReadWrite": true,
      "description": "OpenClaw workspace"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

### If it already exists, add a new entry to `allowedRoots`

Add to the existing array:

```json
{
  "path": "<parent-directory-of-workspace>",
  "allowReadWrite": true,
  "description": "OpenClaw workspace"
}
```

`allowReadWrite: true` is required so the agent can update memory files. If the workspace is under an already-allowed root, skip this step.

## Phase 3: Register Additional Mount

Add the workspace as an `additionalMount` on the target group's `containerConfig`. It will appear at `/workspace/extra/<mount-name>` inside the container.

### Determine the target group

Ask the user which group should have access. Typically the main group.

### Choose a mount name

Use the workspace directory's basename, or ask the user. This becomes the container path: `/workspace/extra/<mount-name>`.

### Update the group registration

From the host:

```bash
sqlite3 store/messages.db "
  UPDATE registered_groups
  SET container_config = json_set(
    COALESCE(container_config, '{}'),
    '$.additionalMounts',
    json('[{\"hostPath\": \"<absolute-workspace-path>\", \"containerPath\": \"<mount-name>\", \"readonly\": false}]')
  )
  WHERE folder = '<group-folder>';
"
```

**If the group already has `additionalMounts`**, read the current value first, append the new mount, and write back the full array.

### Verify

```bash
sqlite3 store/messages.db "SELECT container_config FROM registered_groups WHERE folder = '<group-folder>';"
```

## Phase 4: Update Group CLAUDE.md

The group's `CLAUDE.md` needs to tell the agent about the workspace. Read `AGENTS.md` from the workspace first to understand its session startup procedure, then write CLAUDE.md instructions accordingly.

### Read the workspace's AGENTS.md

```bash
cat <workspace-path>/AGENTS.md
```

This file describes which files to read at session start, how memory works, and behavioral rules. The CLAUDE.md should direct the agent to follow these instructions.

### Add to groups/{folder}/CLAUDE.md

Template (adapt based on the actual AGENTS.md content):

```markdown
## OpenClaw Workspace

Your persona and memory files are mounted at `/workspace/extra/<mount-name>/`.

On session startup, follow the procedure in `/workspace/extra/<mount-name>/AGENTS.md`.

When writing memories, commit changes:

\`\`\`bash
cd /workspace/extra/<mount-name>
git add -A
git commit -m "memory: <brief description>"
\`\`\`
```

Keep the CLAUDE.md concise — point to AGENTS.md rather than duplicating its content.

## Phase 5: Handle MCP Servers (If Present)

OpenClaw workspaces may reference MCP servers (e.g., for memory management, tool proxying). Check:

```bash
grep -ri "mcp\|mcporter" <workspace-path>/AGENTS.md <workspace-path>/TOOLS.md 2>/dev/null
```

If MCP servers are referenced:

1. Ask the user if those MCP servers are available on this host
2. If yes, use the `/add-mcp` skill to configure them for the NanoClaw container
3. If not, note the unavailability in the CLAUDE.md so the agent knows to fall back to file-based alternatives

## Phase 6: Verify

### Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

### Check container logs

```bash
tail -50 groups/<group-folder>/logs/container-*.log | grep -i mount
```

### Test

Send a message to the bot and verify:
1. The agent reads persona files on startup
2. The agent's personality matches the workspace persona
3. The agent can write to memory files
4. Git commits work inside the container (if git is available)

## Phase 7: Git Inside Container

The default NanoClaw container may not include git. If the agent needs to commit:

### Option A: Host-side auto-commit

Cron job or file watcher on the host:

```bash
*/5 * * * * cd <workspace-path> && git add -A && git diff --cached --quiet || git commit -m "auto: memory update $(date +\%Y-\%m-\%dT\%H:\%M)"
```

### Option B: IPC-based commit

The agent writes a task file to `/workspace/ipc/tasks/` requesting a git commit. Implement a host-side handler that processes these requests.

### Option C: Git in container

If git is available in the container image, the agent commits directly. Check with `which git` inside the container.

## Troubleshooting

### Mount rejected

- Is the workspace path under an `allowedRoots` entry in `~/.config/nanoclaw/mount-allowlist.json`?
- Is `allowReadWrite` set to `true`?
- Does the path exist (no broken symlinks)?

### Agent ignores persona files

- Verify CLAUDE.md points to the correct container path (`/workspace/extra/<mount-name>/`)
- Check container logs for mount presence

### Permission denied on writes

- Verify the mount is not forced read-only (`nonMainReadOnly` in allowlist applies to non-main groups)
- Check file ownership — container runs as host UID

### Existing additionalMounts overwritten

Always read the current `container_config` before updating. Append to the existing `additionalMounts` array rather than replacing it.
