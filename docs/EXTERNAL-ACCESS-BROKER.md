# External Access Broker — Specification v0

## Problem

Agents in NanoClaw run in sandboxed containers with no network access and no credentials. When they need to interact with external services (GitHub, cloud providers, Stripe), they currently cannot — the human must do it manually.

The Orchestration Kernel solved multi-agent workflow. The External Access Broker solves **controlled external access**: agents request capabilities, the host executes with real credentials, and every call is logged as evidence.

## Design Principles

1. **Fail-closed** — No capability = denied. Unknown provider = denied. Missing field = denied.
2. **Host executes** — Containers never hold secrets. The broker runs on the host, holds credentials, and returns sanitized results.
3. **Capability-based** — Access is per-group, per-provider, per-access-level. Not role-based.
4. **Evidence trail** — Every external call is logged: who, what, when, result, duration.
5. **Read/write separation** — Read (L1) is always safe. Write (L2+) requires explicit capability grant.
6. **Gate-gated production** — L3 (money/production) requires governance gate approval before execution.
7. **Idempotent** — Duplicate requests produce same result (where provider supports it).

## Access Levels

| Level | Name | Description | Examples |
|-------|------|-------------|----------|
| L0 | None | No external access (default) | — |
| L1 | Read | Read-only access to external APIs | GitHub: list repos, read issues, read PRs. Cloud: read logs. |
| L2 | Write | Write with guardrails | GitHub: create branch, open PR, create issue. Cloud: deploy to staging. |
| L3 | Production | Money or production mutations | Stripe: create charge. GitHub: merge to main. Cloud: deploy to production. |

Every group starts at L0. Capabilities are granted explicitly per provider.

## Architecture

```
Container (no network)          Host (credentials + network)
┌──────────────┐               ┌──────────────────────────┐
│ ext_call MCP │──IPC JSON──►  │ ext-broker.ts            │
│ tool         │               │  ├─ validate capability   │
│              │               │  ├─ check access level    │
│              │               │  ├─ check gate (L3)       │
│              │               │  ├─ execute provider      │
│              │               │  ├─ log evidence          │
│              │◄──response──  │  └─ return sanitized      │
└──────────────┘               └──────────────────────────┘
                                         │
                                    ┌────┴────┐
                                    │Providers│
                                    ├─────────┤
                                    │ github  │ (gh CLI / Octokit)
                                    │ cloud   │ (provider CLI)
                                    └─────────┘
```

### Flow

1. Agent calls `ext_call` MCP tool with `{ provider, action, params }`
2. Container writes IPC JSON to `/workspace/ipc/tasks/`
3. Host IPC watcher picks up, routes to `processExtAccessIpc()`
4. Broker checks:
   a. Does `ext_capabilities` grant this group access to this provider?
   b. Is the action's access level <= the group's granted level?
   c. If L3: does the governance task have the required gate approval?
5. If authorized: execute provider action, log evidence, return result
6. If denied: log denial, return error with reason

### Synchronous vs Asynchronous

The current IPC is fire-and-forget (container writes JSON, host processes, but container doesn't wait for a response). For ext_call, we need **request-response**.

**Solution: Response files**

1. Container writes request to `/workspace/ipc/tasks/ext-{requestId}.json`
2. Container polls `/workspace/ipc/responses/{requestId}.json` (with timeout)
3. Host processes request, writes response to `/workspace/ipc/responses/{requestId}.json`
4. Container reads response and returns to agent

**Request ID format**: `ext-{Date.now()}-{random6}`

**Poll parameters**:
- Interval: 500ms
- Timeout: 30s (configurable per provider, max 120s)
- On timeout: return error `{ status: 'timeout', message: 'External call timed out' }`

---

## Database Schema

### `ext_capabilities`

Defines what each group can do. Managed by main group only.

```sql
CREATE TABLE IF NOT EXISTS ext_capabilities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_folder TEXT NOT NULL,
  provider TEXT NOT NULL,
  access_level INTEGER NOT NULL DEFAULT 0,  -- 0=none, 1=read, 2=write, 3=production
  allowed_actions TEXT,                      -- JSON array of action names, null = all for level
  denied_actions TEXT,                       -- JSON array of explicitly denied actions
  requires_task_gate TEXT,                   -- gate required for L3 (e.g., 'Security')
  granted_by TEXT NOT NULL,                  -- group that granted this
  granted_at TEXT NOT NULL,
  expires_at TEXT,                           -- null = no expiry
  active INTEGER NOT NULL DEFAULT 1,        -- soft delete
  UNIQUE(group_folder, provider)
);
CREATE INDEX IF NOT EXISTS idx_ext_cap_group ON ext_capabilities(group_folder);
CREATE INDEX IF NOT EXISTS idx_ext_cap_active ON ext_capabilities(active, group_folder);
```

### `ext_calls`

Append-only evidence log. Every external call — successful or denied — is recorded.

```sql
CREATE TABLE IF NOT EXISTS ext_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  group_folder TEXT NOT NULL,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  access_level INTEGER NOT NULL,            -- level required for this action
  params_hash TEXT NOT NULL,                -- SHA-256 of params JSON (not raw params — may contain PII)
  params_summary TEXT,                      -- human-readable summary (sanitized)
  status TEXT NOT NULL,                     -- 'authorized' | 'denied' | 'executed' | 'failed' | 'timeout'
  denial_reason TEXT,                       -- if denied, why
  result_summary TEXT,                      -- sanitized result summary
  task_id TEXT,                             -- governance task ID if applicable
  duration_ms INTEGER,                      -- execution time
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_calls_group ON ext_calls(group_folder, created_at);
CREATE INDEX IF NOT EXISTS idx_ext_calls_provider ON ext_calls(provider, action);
CREATE INDEX IF NOT EXISTS idx_ext_calls_request ON ext_calls(request_id);
```

### CRUD Functions (`src/ext-broker-db.ts`)

```typescript
// Capabilities
export function getCapability(groupFolder: string, provider: string): ExtCapability | undefined
export function getAllCapabilities(groupFolder: string): ExtCapability[]
export function grantCapability(cap: Omit<ExtCapability, 'id'>): void           // UPSERT
export function revokeCapability(groupFolder: string, provider: string): void    // SET active=0

// Evidence
export function logExtCall(call: ExtCall): void                                   // INSERT always
export function getExtCalls(groupFolder: string, limit?: number): ExtCall[]
export function getExtCallByRequestId(requestId: string): ExtCall | undefined
```

---

## Provider Abstraction

### Provider Interface

```typescript
// src/ext-broker-providers.ts

export interface ExtProvider {
  name: string;
  actions: Record<string, ExtAction>;
}

export interface ExtAction {
  level: 1 | 2 | 3;                      // minimum access level required
  description: string;
  params: z.ZodType<unknown>;            // zod schema for validation
  execute: (params: unknown, secrets: ProviderSecrets) => Promise<ExtActionResult>;
  summarize: (params: unknown) => string; // human-readable summary (no secrets)
  idempotent: boolean;                    // safe to retry?
}

export interface ExtActionResult {
  ok: boolean;
  data: unknown;                          // returned to container (sanitized)
  summary: string;                        // logged in ext_calls.result_summary
}

export type ProviderSecrets = Record<string, string>;
```

### v0 Providers

#### GitHub (`src/ext-providers/github.ts`)

Secrets: `GITHUB_TOKEN` (from host `.env`)

| Action | Level | Description | Idempotent |
|--------|-------|-------------|------------|
| `list_repos` | L1 | List repositories for authenticated user | Yes |
| `get_repo` | L1 | Get repository details | Yes |
| `list_issues` | L1 | List issues (with filters) | Yes |
| `get_issue` | L1 | Get single issue | Yes |
| `list_prs` | L1 | List pull requests | Yes |
| `get_pr` | L1 | Get PR details + diff summary | Yes |
| `get_pr_comments` | L1 | Get PR review comments | Yes |
| `list_branches` | L1 | List branches | Yes |
| `create_issue` | L2 | Create new issue | No |
| `comment_issue` | L2 | Add comment to issue | No |
| `create_branch` | L2 | Create branch from ref | No |
| `create_pr` | L2 | Open pull request | No |
| `comment_pr` | L2 | Add review comment to PR | No |
| `merge_pr` | L3 | Merge pull request to target branch | No |
| `close_issue` | L2 | Close an issue | No |

Implementation: Use `gh` CLI (already available on host) or `@octokit/rest`.

**Guardrails (L2)**:
- `create_branch`: cannot create `main` or `master`
- `create_pr`: base branch validation (no direct-to-production without L3)
- All writes: require `owner/repo` to be in allowlist (env `EXT_GITHUB_REPOS`)

#### Cloud Logs (`src/ext-providers/cloud-logs.ts`)

Secrets: Cloud provider credentials (from host env)

| Action | Level | Description | Idempotent |
|--------|-------|-------------|------------|
| `query_logs` | L1 | Query recent logs with filters | Yes |
| `get_log_entry` | L1 | Get specific log entry by ID | Yes |
| `list_services` | L1 | List monitored services | Yes |

Implementation: Provider-agnostic wrapper. v0 uses local log files or simple `journalctl`-style queries. v1 adds CloudWatch/GCP Logging.

**Guardrails**:
- Read-only (L1 only) — no write actions defined
- Query time range capped at 24h (prevent full-history scans)
- Result size capped at 100 entries per query

---

## IPC Protocol

### Request (Container → Host)

Written to `/workspace/ipc/tasks/` as JSON:

```json
{
  "type": "ext_call",
  "request_id": "ext-1707900000000-a1b2c3",
  "provider": "github",
  "action": "list_issues",
  "params": {
    "owner": "org-name",
    "repo": "repo-name",
    "state": "open",
    "labels": ["bug"]
  },
  "task_id": "gov-123-abc",
  "timestamp": "2026-02-14T10:00:00.000Z"
}
```

Fields:
- `type`: always `"ext_call"`
- `request_id`: unique, generated by container, used for response matching
- `provider`: registered provider name
- `action`: action within provider
- `params`: action-specific parameters (validated by provider's zod schema)
- `task_id`: optional governance task ID (required for L3 actions)
- `timestamp`: ISO 8601

### Response (Host → Container)

Written to `/workspace/ipc/responses/{request_id}.json`:

```json
{
  "request_id": "ext-1707900000000-a1b2c3",
  "status": "executed",
  "data": { "issues": [...] },
  "summary": "Listed 12 open issues with label 'bug' in org-name/repo-name",
  "timestamp": "2026-02-14T10:00:01.000Z"
}
```

**Status values**:
- `executed` — success, `data` contains result
- `denied` — capability check failed, `error` contains reason
- `failed` — provider execution failed, `error` contains message
- `timeout` — provider call timed out

**Error response**:
```json
{
  "request_id": "ext-1707900000000-a1b2c3",
  "status": "denied",
  "error": "Group 'developer' has L1 (read) access to github, but action 'merge_pr' requires L3 (production)",
  "timestamp": "2026-02-14T10:00:00.100Z"
}
```

### Capability Grant (Main → Host)

Written to `/workspace/ipc/tasks/` as JSON:

```json
{
  "type": "ext_grant",
  "group_folder": "developer",
  "provider": "github",
  "access_level": 2,
  "allowed_actions": null,
  "denied_actions": ["merge_pr"],
  "requires_task_gate": "Security",
  "timestamp": "2026-02-14T09:00:00.000Z"
}
```

### Capability Revoke (Main → Host)

```json
{
  "type": "ext_revoke",
  "group_folder": "developer",
  "provider": "github",
  "timestamp": "2026-02-14T09:00:00.000Z"
}
```

---

## Host-Side Broker (`src/ext-broker.ts`)

### Entry Point

```typescript
export async function processExtAccessIpc(
  data: ExtAccessIpcData,
  sourceGroup: string,
  isMain: boolean,
): Promise<void>
```

Called from `processTaskIpc()` in `src/ipc.ts` for types: `ext_call`, `ext_grant`, `ext_revoke`, `ext_list`.

### Authorization Flow (`ext_call`)

```
1. Parse request_id, provider, action, params
2. Look up provider in registry → if not found, deny
3. Look up action in provider → if not found, deny
4. Look up capability: getCapability(sourceGroup, provider)
   → if not found or active=0, deny (L0)
   → if expired, deny
5. Check access level: action.level <= capability.access_level
   → if insufficient, deny
6. Check allowed_actions: if not null, action must be in list
   → if not in list, deny
7. Check denied_actions: action must NOT be in deny list
   → if in deny list, deny
8. If action.level === 3:
   → data.task_id required
   → look up governance task
   → check task has required gate approval (from capability.requires_task_gate)
   → if no approval, deny
9. Validate params with action.params (zod)
   → if invalid, deny
10. Log ext_call with status='authorized'
11. Execute: action.execute(params, providerSecrets)
12. If success: update ext_call status='executed', write response
13. If failure: update ext_call status='failed', write error response
```

### Response Writing

```typescript
function writeExtResponse(groupFolder: string, requestId: string, response: ExtResponse): void {
  const dir = path.join(DATA_DIR, 'ipc', groupFolder, 'responses');
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `${requestId}.json.tmp`);
  const finalPath = path.join(dir, `${requestId}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(response, null, 2));
  fs.renameSync(tempPath, finalPath);
}
```

### Secret Management

Secrets are loaded from host environment on startup. Never passed to containers. Never logged.

```typescript
// src/ext-broker.ts
const PROVIDER_SECRETS: Record<string, ProviderSecrets> = {
  github: {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  },
  'cloud-logs': {
    // v0: no secrets needed (local logs)
  },
};
```

Validation: if a required secret is empty, the provider is disabled at startup and all calls to it are denied.

---

## MCP Tools (Container-Side)

### `ext_call`

```typescript
server.tool(
  'ext_call',
  'Call an external service through the broker. The host executes the actual API call — you never hold credentials.',
  {
    provider: z.string().describe('Provider name (e.g., "github", "cloud-logs")'),
    action: z.string().describe('Action to perform (e.g., "list_issues", "create_pr")'),
    params: z.record(z.unknown()).describe('Action-specific parameters'),
    task_id: z.string().optional().describe('Governance task ID (required for L3/production actions)'),
  },
  async (args) => {
    const requestId = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write request
    writeIpcFile(TASKS_DIR, {
      type: 'ext_call',
      request_id: requestId,
      provider: args.provider,
      action: args.action,
      params: args.params,
      task_id: args.task_id,
      timestamp: new Date().toISOString(),
    });

    // Poll for response
    const responsePath = path.join(IPC_DIR, 'responses', `${requestId}.json`);
    const timeout = 30_000;
    const interval = 500;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      if (fs.existsSync(responsePath)) {
        const response = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
        // Clean up response file
        fs.unlinkSync(responsePath);

        if (response.status === 'executed') {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(response.data, null, 2),
            }],
          };
        } else {
          return {
            content: [{
              type: 'text' as const,
              text: `External call ${response.status}: ${response.error || response.summary}`,
            }],
            isError: true,
          };
        }
      }
      await new Promise(r => setTimeout(r, interval));
    }

    return {
      content: [{ type: 'text' as const, text: 'External call timed out waiting for response' }],
      isError: true,
    };
  },
);
```

### `ext_capabilities`

```typescript
server.tool(
  'ext_capabilities',
  'List your external access capabilities. Shows which providers and actions you can use.',
  {},
  async () => {
    const capPath = path.join(IPC_DIR, 'ext_capabilities.json');
    if (!fs.existsSync(capPath)) {
      return {
        content: [{ type: 'text' as const, text: 'No external capabilities configured.' }],
      };
    }
    const caps = JSON.parse(fs.readFileSync(capPath, 'utf-8'));
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(caps, null, 2) }],
    };
  },
);
```

### `ext_grant` (main only)

```typescript
server.tool(
  'ext_grant',
  'Grant external access capability to a group. Main only.',
  {
    group_folder: z.string().describe('Target group folder'),
    provider: z.string().describe('Provider name'),
    access_level: z.number().min(0).max(3).describe('0=none, 1=read, 2=write, 3=production'),
    allowed_actions: z.array(z.string()).optional().describe('Restrict to specific actions'),
    denied_actions: z.array(z.string()).optional().describe('Explicitly deny specific actions'),
    requires_task_gate: z.string().optional().describe('Gate type required for L3 actions'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only main can grant capabilities' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'ext_grant',
      ...args,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Capability grant requested: ${args.group_folder} → ${args.provider} L${args.access_level}` }],
    };
  },
);
```

### `ext_revoke` (main only)

```typescript
server.tool(
  'ext_revoke',
  'Revoke external access capability from a group. Main only.',
  {
    group_folder: z.string().describe('Target group folder'),
    provider: z.string().describe('Provider name'),
  },
  async (args) => {
    if (!isMain) {
      return { content: [{ type: 'text' as const, text: 'Only main can revoke capabilities' }], isError: true };
    }
    writeIpcFile(TASKS_DIR, {
      type: 'ext_revoke',
      ...args,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `Capability revoke requested: ${args.group_folder} → ${args.provider}` }],
    };
  },
);
```

---

## Snapshot (`ext_capabilities.json`)

Written by host before container spawn, alongside `gov_pipeline.json`.

```json
{
  "generatedAt": "2026-02-14T10:00:00.000Z",
  "capabilities": [
    {
      "provider": "github",
      "access_level": 2,
      "allowed_actions": null,
      "denied_actions": ["merge_pr"],
      "actions": {
        "list_repos": { "level": 1, "description": "List repositories" },
        "list_issues": { "level": 1, "description": "List issues with filters" },
        "create_issue": { "level": 2, "description": "Create new issue" },
        "create_pr": { "level": 2, "description": "Open pull request" },
        "merge_pr": { "level": 3, "description": "Merge PR (DENIED)" }
      }
    }
  ],
  "providers_available": ["github", "cloud-logs"]
}
```

The snapshot includes the full action catalog for each granted provider, so agents know what's available without trial and error. Actions above the group's level are shown with `(DENIED)` annotation. Actions in the deny list are explicitly marked.

---

## Integration with Existing Code

### `src/ipc.ts` — New cases

```typescript
case 'ext_call':
case 'ext_grant':
case 'ext_revoke':
case 'ext_list':
  await processExtAccessIpc(data, sourceGroup, isMain);
  break;
```

### `src/db.ts` — Schema init

```typescript
import { createExtAccessSchema } from './ext-broker-db.js';

// In initDatabase():
createExtAccessSchema(db);
```

### `src/gov-loop.ts` — Snapshot writing

Add `writeExtCapabilitiesSnapshot(groupFolder)` call alongside `writeGovSnapshot()` before container spawn.

### `src/index.ts` — No changes

The broker is reactive (responds to IPC), not polling-based. No loop needed.

### Container mount — Responses directory

Add `responses/` to the IPC directory structure. The host writes here, the container reads.

```
${DATA_DIR}/ipc/${groupFolder}/
  ├── messages/
  ├── tasks/
  ├── responses/              ← NEW: host writes ext_call responses here
  ├── gov_pipeline.json
  └── ext_capabilities.json   ← NEW: capability snapshot
```

---

## Configuration

### Environment Variables (Host)

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_TOKEN` | — | GitHub personal access token (required for github provider) |
| `EXT_GITHUB_REPOS` | — | Comma-separated allowlist of `owner/repo` (empty = all accessible) |
| `EXT_CALL_TIMEOUT` | `30000` | Default timeout for ext_call responses (ms) |
| `EXT_LOG_QUERY_MAX_HOURS` | `24` | Max time range for cloud-logs queries |
| `EXT_LOG_QUERY_MAX_RESULTS` | `100` | Max entries per cloud-logs query |

### Default Capabilities

On first boot, no capabilities exist. Main must explicitly grant them. Suggested bootstrap:

```
developer: github L2 (denied: merge_pr), cloud-logs L1
security:  github L1, cloud-logs L1
main:      github L3, cloud-logs L1
```

---

## Security Considerations

### Secrets

- **Never in containers**: Secrets live in host `.env`, loaded at startup, passed to provider `execute()` only.
- **Never in logs**: `ext_calls` stores `params_hash` (SHA-256) not raw params. `params_summary` is sanitized by provider's `summarize()` function.
- **Never in snapshots**: `ext_capabilities.json` contains no secrets.
- **Never in IPC**: Request/response files contain params and results, but never credentials. IPC directory is per-group (no cross-group access).

### Denial Logging

Every denial is logged with reason. This catches:
- Unauthorized access attempts (capability violation)
- Privilege escalation attempts (L1 group trying L2 action)
- Policy violations (denied action list)

### Rate Limiting (v1)

v0 does not implement rate limiting. v1 will add:
- Per-group, per-provider rate limits in `ext_capabilities`
- Sliding window counter in `ext_calls`
- Configurable via capability grant

### Expiry

Capabilities can have `expires_at`. The broker checks on every call. Expired capabilities are treated as L0 (denied).

---

## Go/No-Go Checklist

Before shipping v0, verify:

- [ ] **Fail-closed**: Remove all capabilities → every `ext_call` denied
- [ ] **Read-only enforcement**: L1 group cannot execute L2 actions
- [ ] **L3 gate requirement**: L3 action without governance gate approval → denied
- [ ] **Evidence generation**: Every call (success + denial) has `ext_calls` row
- [ ] **No secrets in logs**: `ext_calls.params_hash` is hash, not cleartext
- [ ] **No secrets in containers**: Container has no access to `GITHUB_TOKEN` etc.
- [ ] **Idempotent grants**: Double `ext_grant` with same params → no error, upsert
- [ ] **Response cleanup**: Container deletes response file after reading
- [ ] **Timeout handling**: Slow provider → container gets timeout error, not hang
- [ ] **Denied actions**: Action in `denied_actions` → denied even if level sufficient
- [ ] **Snapshot accuracy**: `ext_capabilities.json` reflects current DB state

---

## Files to Create/Edit

| File | Action | Lines ~est |
|------|--------|-----------|
| `src/ext-broker-db.ts` | **NEW** — schema + CRUD | ~100 |
| `src/ext-broker.ts` | **NEW** — IPC handler + auth flow | ~180 |
| `src/ext-broker-providers.ts` | **NEW** — provider interface + registry | ~30 |
| `src/ext-providers/github.ts` | **NEW** — GitHub provider (gh CLI) | ~200 |
| `src/ext-providers/cloud-logs.ts` | **NEW** — Cloud logs provider | ~80 |
| `src/ipc.ts` | **EDIT** — add ext_* cases | ~8 |
| `src/db.ts` | **EDIT** — call createExtAccessSchema | ~4 |
| `src/gov-loop.ts` | **EDIT** — writeExtCapabilitiesSnapshot | ~20 |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | **EDIT** — 4 MCP tools | ~150 |
| `groups/main/CLAUDE.md` | **EDIT** — document ext_grant/revoke | ~15 |
| `groups/developer/CLAUDE.md` | **EDIT** — document ext_call | ~10 |
| `groups/security/CLAUDE.md` | **EDIT** — document ext_call | ~10 |

---

## Open Questions for v1

1. **Streaming results** — Large query results (e.g., 100 log entries) as a single JSON response may be unwieldy. Consider chunked responses.
2. **Webhook callbacks** — Some providers (GitHub) support webhooks. Should the broker accept inbound events and route to governance tasks?
3. **Multi-provider transactions** — e.g., "create GitHub issue AND deploy" as atomic. Deferred to v2.
4. **Capability delegation** — Can main delegate grant authority to another group? Currently main-only.
5. **Audit dashboard** — `ext_calls` table is queryable. Should we add a `gov_list_ext_calls` MCP tool for transparency?
