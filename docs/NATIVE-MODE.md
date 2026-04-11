# Native Runner Mode

Native mode spawns the NanoClaw agent-runner as a direct child process on the host instead of inside a Docker container. This unlocks integrations that are impractical or impossible inside a Linux container.

## When to use it

| Capability | Container mode | Native mode |
|---|---|---|
| tmux sessions on host | Requires socket mount + version match | Native |
| Claude Code interactive PTY | Blocked by container stdio | Native |
| Playwright headed browser | No display server | Native (inherits display) |
| macOS screen capture / camera | Linux container only | Native |
| Ollama on localhost | Bridge network hop | Direct |
| System notifications (`osascript`) | Blocked | Native |
| `gh` auth / SSH keys | Requires explicit mounts | Inherits `~/.ssh`, `~/.config/gh` |
| Git config / GPG signing | Requires mounts | Inherits `~/.gitconfig`, keychain |

Use native mode when you are running NanoClaw as a personal assistant on a single-user machine and you want the agent to have the same host access you do.

Use container mode (the default) for any deployment where isolation matters — multi-user setups, servers, or any environment where you do not want an agent to touch arbitrary files on the host.

## Activation

Add to your `.env`:

```
RUNTIME_MODE=native
```

Restart NanoClaw. On first start, native mode installs agent-runner npm dependencies (once only) and symlinks `container/skills/` into `~/.claude/skills/`.

## How it works

- The `container/agent-runner/src/index.ts` is executed directly with `tsx` as a child process
- The same stdin/stdout JSON IPC protocol is used as in container mode — the agent-runner is unchanged
- Per-group workspace directories (`data/sessions/<group>/`, IPC dirs) are created on the host exactly as they would be inside a container
- `HOME` is set to the real user home directory so SSH keys, `gh` auth, and `~/.gitconfig` work
- Skills in `container/skills/` are symlinked into `~/.claude/skills/` at startup. Symlinks update automatically after `git pull`. User-owned skills (real directories in `~/.claude/skills/`) are never overwritten.

## Security trade-offs

Native mode deliberately removes the Docker isolation boundary. Be aware:

**Filesystem access**: The agent process runs as your user and can read and write any file you can. The `additionalMounts` allowlist still validates which paths are exposed via the `NANOCLAW_WORKSPACE_EXTRA` directory, but read-only constraints cannot be enforced — there is no container boundary to back them up. A warning is logged for each mount marked `readonly` in your config.

**Process access**: The agent can spawn child processes with your full permissions — `sudo` prompts aside. This is intentional for use-cases like running `tmux new-session` or `gh` commands, but it means a misbehaving prompt could cause unintended system changes.

**No network namespace isolation**: In container mode, the agent's network access can be restricted. In native mode, the agent has direct access to all interfaces including `localhost` services (databases, local APIs, Ollama).

**Recommendation**: Only use native mode on machines you control, for personal use, with groups you trust. For any shared or production deployment, use container mode.

## tmux in container mode (`MOUNT_TMUX_SOCKET`)

If you prefer container mode but still need tmux access, set:

```
MOUNT_TMUX_SOCKET=true
```

This mounts the host tmux socket directory into containers. The socket path is resolved via `$TMUX_TMPDIR` (set by macOS launchd) with `/tmp/tmux-<uid>` as a fallback for Linux.

**Security note**: Any container with the tmux socket can send keystrokes to any existing tmux session owned by your user, including sessions running in other groups. This grants cross-group host access. Only enable on single-user personal deployments where all groups are trusted.

## Skills sync

On startup, native mode symlinks each skill directory from `container/skills/<name>` into `~/.claude/skills/<name>`. This means:

- Skills are always up-to-date after `git pull` — no manual copy step
- No race conditions: symlinks are atomic, unlike recursive file copies
- Your own skills (real directories in `~/.claude/skills/`) are never touched — only directories that are symlinks or don't yet exist are managed

If you want to customize a skill locally, replace the symlink with a real directory. NanoClaw will detect the real directory and leave it alone on subsequent starts.

## Troubleshooting

**`npx tsx` not found on startup**
Native mode resolves `npx` from the same directory as the Node.js binary (`process.execPath`). If you installed Node via a version manager, ensure the correct version is active when NanoClaw starts (especially relevant for launchd service setups).

**Credentials not picked up**
Native mode reads `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` from your `.env` file using the same parser as the rest of NanoClaw. Ensure values are not double-quoted (`KEY="value"` is fine; it handles quoting correctly). Check `logs/nanoclaw.log` for authentication errors.

**Skills not appearing in the agent**
Check that `~/.claude/skills/` contains symlinks pointing into `container/skills/`. If a skill directory exists as a real directory (not a symlink), native mode skips it. Run `ls -la ~/.claude/skills/` to inspect.

**macOS launchd: wrong tmux socket path**
macOS launchd sets `$TMUX_TMPDIR` to a path under `/private/var/folders/`. If `MOUNT_TMUX_SOCKET=true` logs a warning about the socket not being found, check `echo $TMUX_TMPDIR` in your shell and verify NanoClaw's launchd plist passes `TMUX_TMPDIR` in its `EnvironmentVariables` dict.
