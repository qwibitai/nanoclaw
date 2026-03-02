# Host Commands — IPC Pathway for Container-Restricted Operations

Anything the agent container can't do (Docker, system services, writing outside the project)
has a pathway back to the host via IPC. This is the pattern to use every time you hit
"this needs to run on the host."

---

## The Two IPC Tools

### `run_host_command`

Runs a named shell command on the host and sends the output back to the chat.

**Agent side** (`ipc-mcp-stdio.ts`): writes `{type: "run_host_command", name, chatJid}` to `/workspace/ipc/tasks/`

**Host side** (`src/ipc.ts`): reads `~/.config/nanoclaw/host-commands.json`, runs the command, sends result via `deps.sendMessage(chatJid, ...)`.

**Allowlist file** (`~/.config/nanoclaw/host-commands.json`):
```json
{
  "commands": {
    "my-command": {
      "command": "cd ~/projects/foo && make deploy",
      "description": "Human-readable description",
      "timeout": 120000
    }
  }
}
```
No restart needed when adding commands — the file is read fresh on each invocation.

### `update_mount_allowlist`

Adds new paths to `~/.config/nanoclaw/mount-allowlist.json` from chat.
Main-group only. Used when registering a new topic + project entirely from Telegram.

---

## Adding a New Host-Restricted Operation

1. **Determine if it's a one-shot command** (build, restart, check logs) → add to `host-commands.json`
2. **Determine if it's a structural change** (new mount, new allowlist entry) → add a new IPC task type in `src/ipc.ts` + a corresponding MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
3. **Document it** in `container/skills/host-commands/SKILL.md` so the agent knows about it

### Adding a new named command (no code changes)

Just add an entry to `~/.config/nanoclaw/host-commands.json`. The key is the name the agent
passes to `run_host_command`. Available immediately, no restart.

### Adding a new IPC task type (code changes)

1. Add a `case 'my_new_type':` block in `src/ipc.ts → processTaskIpc()`
2. Add the field types to the `data` parameter union in `processTaskIpc()`
3. Add an MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts` that writes the task file
4. Rebuild the agent container: `./container/build.sh`
5. Restart NanoClaw: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

---

## Registering a New Topic + Project Entirely from Telegram

The agent can do this without host access:

1. `update_mount_allowlist` → adds new project path to `~/.config/nanoclaw/mount-allowlist.json`
2. `register_group` → registers JID + mounts in SQLite + live in-memory state

Both take effect immediately. The only thing that still needs host access is adding new
*named commands* to `host-commands.json` (the file is intentionally not IPC-writable —
it would let any command name map to arbitrary shell).

---

## Security Model

- **`host-commands.json`** is pre-approved by the human and cannot be modified via IPC.
  The agent can only invoke names that already exist in the file.
- **`mount-allowlist.json`** CAN be updated via IPC, but only from the main group.
  The main group is trusted (the human controls who can message it).
- **Containers cannot escalate their own privileges** — a non-main container writing
  `update_mount_allowlist` is blocked in the IPC handler.
