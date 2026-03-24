# Code Healer — Multi-User Automated Code Analysis & Repair

**Date:** 2026-03-24
**Status:** Approved design, pending implementation

## Overview

A multi-user system where NanoClaw automatically pulls logs from remote machines, analyzes them alongside local source code, and creates fix branches with PRs. Each user configures their own repos, remote log sources, and inspection schedules via Discord DM with a shared bot.

## Architecture

### Identity Chain

```
Discord User ID → Linux user on VPS → their Claude Max OAuth token
                                     → their repos (owned by their UID)
                                     → their gh CLI auth (~/.config/gh/)
                                     → their Tailscale SSH identity (for remote logs)
                                     → container runs as their UID/GID
```

### Single Instance, Multi-User

One NanoClaw process, one Discord bot. Each user DMs the bot — their DM channel maps to a NanoClaw group with an associated user profile. Containers run as the user's Linux UID, using their Claude Max subscription and their GitHub credentials.

## Data Model

### UserProfile

```typescript
interface UserProfile {
  id: string;                    // UUID
  discordUserId: string;         // Discord snowflake
  linuxUsername: string;          // VPS user, e.g., "alice"
  uid: number;                   // From /etc/passwd
  gid: number;                   // From /etc/passwd
  homeDir: string;               // e.g., "/home/alice"
  repos: RepoConfig[];
  remoteSources: RemoteLogSource[];
  createdAt: string;
}

interface RepoConfig {
  name: string;                  // Display name, e.g., "api"
  localPath: string;             // Absolute path, e.g., "/home/alice/projects/api"
  inspectionTypes: InspectionType[];
  schedule: string;              // Cron expression, default "0 23 * * *"
  healBranchPrefix: string;      // Default "heal/"
}

interface RemoteLogSource {
  name: string;                  // e.g., "prod-api"
  host: string;                  // Tailscale hostname or IP
  logPath: string;               // Remote path, e.g., "/var/log/api/"
  logPattern: string;            // Glob, e.g., "*.log"
  linkedRepo: string;            // Which RepoConfig.name these logs relate to
}

type InspectionType = 'log-analysis' | 'code-review' | 'security-review';
```

### Storage

New SQLite table `user_profiles` keyed by `discordUserId`. The group's `containerConfig` gets an optional `userProfileId` field linking a group to a profile.

## User Registration Flow (Chat-Based)

User DMs the bot: "set me up, my Linux username is alice"

1. Resolve `alice` via `/etc/passwd` → uid, gid, homeDir
2. Check `/home/alice/.claude/.credentials.json` exists (Claude Max auth)
3. Check `/home/alice/.config/gh/hosts.yml` exists (GitHub CLI)
4. Create profile, store in DB
5. Reply with confirmation and prompt for repo configuration

User then: "monitor ~/projects/api with nightly log analysis, pull logs from prod-server:/var/log/api/"

6. Store RepoConfig and RemoteLogSource in the profile
7. Create scheduled task (`0 23 * * *`) linked to this group

## Per-User Credential Proxy

### Problem

Single shared proxy injects one user's OAuth token into all containers.

### Solution: Per-User Proxy on Ephemeral Port

```
Container for alice (port 48201) → Proxy(alice's token) → api.anthropic.com
Container for bob   (port 48202) → Proxy(bob's token)   → api.anthropic.com
```

#### Always-Fresh Tokens

The per-user proxy reads the token fresh on every request (never cached at startup). This prevents the stale-token bug that was fixed on 2026-03-24 where the shared proxy cached a token at startup that later expired.

```typescript
function readUserCredentialsToken(homeDir: string): string | undefined {
  const credsPath = path.join(homeDir, '.claude', '.credentials.json');
  const raw = fs.readFileSync(credsPath, 'utf-8');
  return JSON.parse(raw)?.claudeAiOauth?.accessToken;
}
```

#### Fallback Chain (per request)

1. `/home/{username}/.claude/.credentials.json` (auto-refreshed by Claude Code)
2. → 401 error to container → reported to user via Discord DM: "Your Claude token has expired. Run `claude` on the VPS to refresh it."

#### Lifecycle

1. Container spawn: start proxy on port 0 (OS picks ephemeral port), configured with user's homeDir
2. Container gets `ANTHROPIC_BASE_URL=http://host.docker.internal:{port}`
3. Container exit: proxy instance closed in the existing `close` handler

## Pre-Task Log Sync

### Flow

When a heal task fires (e.g., 11pm cron), NanoClaw syncs logs on the host before spawning the container:

1. Resolve user profile for the group
2. For each RemoteLogSource:
   a. Create temp dir: `/tmp/nanoclaw-logs/{userId}/{sourceName}/`
   b. SSH as the user's UID via Tailscale:
      `ssh {user}@{host} "find {logPath} -name '{pattern}' -newermt 'today 00:00'"`
      → get list of today's log files
   c. `scp` those files into the temp dir
3. Mount temp dirs into container at `/workspace/logs/{sourceName}/` (read-only)
4. Spawn container
5. On container exit: `rm -rf /tmp/nanoclaw-logs/{userId}/`

### Key constraints

- Only today's logs are pulled (filter by modification time)
- Local temp copies are deleted after the task completes
- Remote logs are NEVER modified or deleted
- Sync runs as the user's UID (Tailscale SSH authenticates as them)

## Heal Task Lifecycle

### Container Mounts

For a heal task, the container gets:

| Mount | Container Path | Mode |
|-------|---------------|------|
| User's repo | `/workspace/extra/{repoName}` | read-write |
| Synced logs | `/workspace/logs/{sourceName}` | read-only |
| `~/.config/gh` | `/workspace/extra/.gh-config` | read-only |
| Standard NanoClaw mounts | (unchanged) | (unchanged) |

Container runs as `--user {uid}:{gid}` from the user profile.

### Agent Prompt (generated dynamically)

The prompt is built at runtime from the current profile config, so config changes take effect immediately without modifying scheduled tasks.

Example for log-analysis:

```
You are a code healer. Analyze today's logs and source code, then create fixes.

REPO: api at /workspace/extra/api
LOGS: /workspace/logs/prod-api/ (today's logs only)
INSPECTION: log-analysis

WORKFLOW:
1. Read today's logs — identify errors, warnings, and anomalies
2. Cross-reference with source code to find root causes
3. For each fixable issue:
   a. Create branch: heal/2026-03-24-{short-description}
   b. Implement the fix
   c. Commit with a clear message explaining the issue and fix
   d. Push the branch
   e. Create a PR using `gh pr create` with a description of the issue and fix
4. Send a summary of all findings and PRs created

GIT CONFIG: Use ~/.config/gh from /workspace/extra/.gh-config
Set GIT_CONFIG_GLOBAL if needed.

IMPORTANT:
- Never commit directly to main
- Each fix gets its own branch and PR
- Include log excerpts in PR descriptions so reviewers see the evidence
- If an issue is unclear or risky, flag it in the summary instead of fixing it
```

### Inspection Type Variants

- **log-analysis**: Errors/warnings in logs → trace to code → fix root causes
- **code-review**: No logs needed — review recent commits or full codebase for quality, bugs, code smells
- **security-review**: OWASP top 10, dependency vulnerabilities, secrets in code, insecure patterns

### Output

The agent sends a Discord DM summary after completing:

```
## Heal Report — api (2026-03-24)

### Issues Found: 3

1. **Unhandled null in /src/parser.ts:42** — TypeError in logs (12 occurrences)
   → PR #87: heal/2026-03-24-null-parser

2. **SQL injection risk in /src/routes/search.ts:18** — unsanitized user input
   → PR #88: heal/2026-03-24-sql-injection

3. **Memory leak in WebSocket handler** — connections not cleaned up on error
   → Flagged only (complex fix, needs human review)

### No Issues: 0 warnings suppressed
```

## New & Modified Files

### New Files

| File | Purpose |
|------|---------|
| `src/user-profile.ts` | UserProfile CRUD, `/etc/passwd` lookup, validation |
| `src/user-profile.test.ts` | Tests |
| `src/log-sync.ts` | Pre-task remote log sync via Tailscale SSH |
| `src/log-sync.test.ts` | Tests |
| `src/heal-prompt.ts` | Generates heal prompts from profile + repo + inspection config |
| `src/heal-prompt.test.ts` | Tests |

### Modified Files

| File | Change |
|------|--------|
| `src/types.ts` | Add UserProfile, RepoConfig, RemoteLogSource, InspectionType |
| `src/db.ts` | Add `user_profiles` table, CRUD operations |
| `src/credential-proxy.ts` | Extract proxy factory: `createUserProxy(homeDir)` returns a scoped proxy instance on ephemeral port |
| `src/container-runner.ts` | Look up user profile → run as user's UID → mount repos + gh config → start/stop per-user proxy |
| `src/task-scheduler.ts` | Before heal tasks: call log-sync, mount temp logs, clean up after |
| `src/mount-security.ts` | Allow `~/.config/gh` for user-profile containers |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Add `setup_profile`, `add_repo`, `add_log_source` MCP tools |

### New Container Skill

| File | Purpose |
|------|---------|
| `container/skills/heal/SKILL.md` | Guides the agent through the heal workflow: branch, fix, commit, PR, summary |

## Implementation Order

1. Types + DB — data model, migration
2. User profile — registration, `/etc/passwd` lookup, validation
3. Credential proxy refactor — extract per-user proxy factory
4. Container runner changes — per-user UID, mounts, proxy lifecycle
5. Log sync — Tailscale SSH fetch, today-only filter, temp dir, cleanup
6. Heal prompt generator — builds agent prompts per inspection type
7. MCP tools for onboarding — `setup_profile`, `add_repo`, `add_log_source`
8. Task scheduler integration — pre-task log sync, post-task cleanup
9. Container skill — `heal` skill in `container/skills/`

## Admin Setup

### Mount Allowlist

The NanoClaw admin must add user repo directories and the temp log directory to
`~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "/home",
      "allowReadWrite": true,
      "description": "User home directories — repos and gh config"
    },
    {
      "path": "/tmp/nanoclaw-logs",
      "allowReadWrite": false,
      "description": "Temporary synced logs (read-only in containers)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": false
}
```

### Sudoers

The NanoClaw process user needs passwordless sudo for SSH commands as other users:

```
# /etc/sudoers.d/nanoclaw
nanoclaw_user ALL=(ALL) NOPASSWD: /usr/bin/ssh, /usr/bin/scp
```

### Tailscale

All VPS machines must be on the same tailnet. Users must have Tailscale SSH
access to their remote log machines (configured in Tailscale ACLs).

## Out of Scope

- Auto-discovery of repos (explicit paths only)
- Multi-VPS NanoClaw federation
- Web dashboard for configuration
- Automatic token refresh (user runs `claude` to refresh)
- Direct commit to main (always branch + PR)
