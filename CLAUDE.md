# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/add-sdlc` | Establish PR-based SDLC workflow for auditable, tracked changes |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## SDLC Workflow

**Every code change goes through a branch and PR.** No exceptions.

### Making Changes

1. **Create a branch** from `main`:
   - `feature/*` — new capabilities or skills
   - `fix/*` — bug fixes
   - `config/*` — configuration or environment changes
   - `docs/*` — documentation only

2. **Make changes and commit** with clear, descriptive messages. Include context about WHY, not just what.

3. **Push and open a PR** against `main`:
   ```bash
   git push -u origin <branch-name>
   gh pr create --title "<short title>" --body "<what and why>"
   ```

4. **CI runs automatically** on PRs (typecheck, format, tests). Fix failures before merging.

5. **Merge** when ready. Prefer squash-merge for clean history.

### Rules

- **Never commit directly to `main`.** Always use a branch + PR.
- **Never force-push to `main`.** Use `git revert` to undo bad merges.
- **Every PR must build clean** (`npm run build` + `npm test` pass).
- **Write tests** for new functionality. Run `npx vitest run` before pushing.
- **Tag releases** with semver when deploying: `git tag v<major>.<minor>.<patch>`.

### When the Runtime Agent Wants Code Changes

The agent running inside a container cannot directly modify the NanoClaw codebase. If the agent determines a code change is needed (new skill, bug fix, behavior change), it should:

1. Write a detailed description of the desired change to `groups/main/requested-changes/` as a markdown file
2. Include: what to change, why, which files, and expected behavior
3. A human (or Claude Code session) picks up the request, creates a branch, implements it, and opens a PR

This separation ensures the running agent never breaks itself.
