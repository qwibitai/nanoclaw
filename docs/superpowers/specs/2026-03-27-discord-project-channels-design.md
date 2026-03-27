# Discord Project Channels

Create Discord channels linked to projects in `~/projects/`, allowing Shoggoth to have project-scoped conversations with read-write access to project files.

## Motivation

Shoggoth currently operates through a main Discord channel (#general) and can be extended with additional registered channels. To support project-specific discussions that result in actual project edits, we need a way to dynamically create Discord channels linked to project directories, with the agent having full read-write access to the project within an isolated container.

## Command Interface

Natural language via #general. The user asks Shoggoth to create a project channel. Shoggoth:

1. Lists all projects in `~/projects/`, showing which already have linked channels.
2. Asks for confirmation with the channel name and project path.
3. On confirmation, creates the channel and registers it.

Example flow:

```
User: @Andy create a channel for discontinuous-machines

Shoggoth: Here are your projects:
  • discontinuous-machines — no channel
  • platform-abm — #project-platform-abm (already registered)

I'll create #project-discontinuous-machines linked to ~/projects/discontinuous-machines. Go ahead?

User: Yes

Shoggoth: Done — #project-discontinuous-machines is live and linked to your project.
```

## Channel Naming

All project channels use the prefix `project-` followed by the project folder name: `#project-discontinuous-machines`. This provides a clean namespace for future non-project Discord uses.

## Architecture

Agent orchestrates the conversation; host executes privileged side effects via IPC.

```
User in #general
    ↓
Main group agent (container)
  - Reads ~/projects/ listing
  - Reads available_groups.json (includes project_path)
  - Shows project list with registration status
  - Asks for confirmation
  - Writes IPC action file on confirmation
  - Waits for IPC response
  - Reports result
    ↓
IPC watcher (host process, src/ipc.ts)
  - Receives create_project_channel action
  - Creates Discord channel via guild.channels.create()
  - Creates group folder (if absent)
  - Seeds CLAUDE.md (if absent)
  - Registers group in DB with project_path
  - Writes IPC response file
```

## IPC Protocol

### Request (agent → host)

Written by the agent to the IPC directory:

```json
{
  "action": "create_project_channel",
  "projectName": "discontinuous-machines",
  "projectPath": "/home/square/projects/discontinuous-machines",
  "channelName": "project-discontinuous-machines",
  "requestedBy": "dc:1486810983824490620"
}
```

### Response (host → agent)

Written by the host to the same IPC directory:

```json
{
  "action": "create_project_channel_result",
  "success": true,
  "channelId": "dc:1234567890",
  "channelName": "project-discontinuous-machines",
  "folder": "project_discontinuous_machines",
  "error": null
}
```

## Database Changes

### Migration

Add nullable `project_path` column to `registered_groups`:

```sql
ALTER TABLE registered_groups ADD COLUMN project_path TEXT;
```

Existing groups are unaffected (null value).

### Registration Row

New project channels are registered with:

| Field | Value |
|-------|-------|
| `jid` | `dc:<new-channel-snowflake>` |
| `name` | `Shoggoth #project-discontinuous-machines` |
| `folder` | `project_discontinuous_machines` |
| `trigger_pattern` | `@Andy` |
| `requires_trigger` | `true` |
| `is_main` | `false` |
| `project_path` | `/home/square/projects/discontinuous-machines` |

## Container Volume Mounts

In `buildVolumeMounts()` in `container-runner.ts`:

- If the group has a non-null `project_path` and is not the main group, mount `project_path` **read-write** at `/workspace/project`.
- Main group retains its existing behavior (mounts shoggoth root at `/workspace/project`).
- Git history in the project provides the safety net for any agent edits.

## Available Groups Extension

`available_groups.json` (built in `index.ts`, passed to main group container) is extended to include `project_path` for each group. This allows the main group agent to show which projects are already linked when listing projects.

## Group Folder Setup

When the host creates a project channel:

1. `mkdir -p groups/project_<name>/` — no-op if folder already exists (preserves accumulated context).
2. Write `CLAUDE.md` only if one does not already exist:

```markdown
# Project: discontinuous-machines

Project directory mounted at /workspace/project.
```

This allows pre-configuring a group folder with custom agent instructions before channel creation.

## Error Handling

- **Project path doesn't exist:** The host-side IPC handler validates that `projectPath` exists on disk before proceeding. If not, it returns an error response and the agent relays the failure.
- **Channel creation fails:** Discord API errors (permissions, rate limits) are caught and returned in the IPC error response.
- **Group folder already exists:** Reused as-is. Only `CLAUDE.md` is seeded if absent.
- **Project already has a channel:** The agent detects this from `available_groups.json` and tells the user during the listing step, before any IPC action is sent.

## Discord Permissions

The bot requires the `Manage Channels` permission on the Discord server (already configured via role update). No changes to gateway intents needed — `Guilds` intent is sufficient for channel creation API calls.

## Files Changed

| File | Change |
|------|--------|
| `src/db.ts` | Migration adding `project_path` column to `registered_groups` |
| `src/ipc.ts` | New `create_project_channel` action handler (Discord API + DB + folder setup) |
| `src/container-runner.ts` | Mount `project_path` at `/workspace/project` for project groups |
| `src/index.ts` | Include `project_path` in `available_groups.json` |
| `groups/main/CLAUDE.md` | Agent instructions for project channel creation flow + IPC format |

No new source files. Group folders created at runtime.
