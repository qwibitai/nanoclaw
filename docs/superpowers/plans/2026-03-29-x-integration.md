# X/Twitter Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Playwright-based X integration with official XDK SDK, add autonomous timeline monitoring with Claude-driven engagement, and build a reusable core approval mechanism.

**Architecture:** Three deliverables across two repos. Phase 1 builds the core approval mechanism in nanoclaw. Phase 2 builds the generic social monitor framework as a container skill. Phase 3 builds the X-specific integration skill on top. Phase 4 updates bearclaw-platform with new scopes, tables, API endpoints, and WebSocket events.

**Tech Stack:** TypeScript (nanoclaw), Go (bearclaw-platform), `@xdevplatform/xdk` v0.5.0, SQLite (container-side), PostgreSQL (platform-side), vitest (TS tests), Go stdlib testing

**Spec:** `docs/superpowers/specs/2026-03-29-x-integration-design.md`
**OpenAPI Reference:** `~/code/bearclaw/x-openapi.json`

---

## File Structure

### nanoclaw — New Files

```
src/approval.ts                              # Core approval store + notification logic
src/approval.test.ts                         # Tests for approval module

container/skills/social-monitor/
├── SKILL.md                                 # Framework documentation
├── interfaces.ts                            # SocialMonitor, TimelineItem, etc.
├── framework.ts                             # Pipeline orchestrator
├── dedup.ts                                 # Seen items SQLite store
├── engagement-log.ts                        # Audit trail SQLite store
└── decision-prompt.ts                       # Claude decision prompt builder

container/skills/x-integration/
├── SKILL.md                                 # X integration documentation
├── client.ts                                # XDK client wrapper
├── actions.ts                               # Post, like, reply, retweet, quote
├── monitor.ts                               # SocialMonitor implementation for X
├── setup.ts                                 # Persona bootstrapping
└── tools.ts                                 # MCP tool definitions
```

### nanoclaw — Modified Files

```
src/ipc.ts:465-467                           # Add request_approval case before default
src/index.ts                                 # Import approval module, wire expiry timer
container/agent-runner/src/ipc-mcp-stdio.ts  # Add request_approval MCP tool
container/agent-runner/package.json          # Add @xdevplatform/xdk dependency
container/Dockerfile                         # Add XDK install + skill copy steps
```

### bearclaw-platform — New Files

```
migrations/019_approval_engagement.sql       # New tables
internal/model/approval.go                   # PendingApproval model
internal/model/engagement.go                 # EngagementAction model
internal/store/approval.go                   # Approval store
internal/store/engagement.go                 # Engagement store
internal/api/handler/approval.go             # Approval API handler
```

### bearclaw-platform — Modified Files

```
internal/service/social.go:174,240           # Add like.read, like.write scopes
internal/integration/twitter_api.go:28-32    # Add like/retweet policy rules
internal/api/router.go                       # Add approval routes
internal/gateway/nc_protocol.go:66-83        # Add engagement.sync, approval.* events
internal/gateway/manager.go                  # Handle new events
```

---

## Phase 1: Core Approval Mechanism (nanoclaw)

### Task 1: Approval Store Module

**Files:**
- Create: `src/approval.ts`
- Create: `src/approval.test.ts`

- [ ] **Step 1: Write test for createApproval**

```typescript
// src/approval.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ApprovalStore } from './approval.js';

describe('ApprovalStore', () => {
  let db: Database.Database;
  let store: ApprovalStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ApprovalStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates and retrieves a pending approval', () => {
    const approval = store.create({
      id: 'apr-001',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet: Hello world',
      details: { content: 'Hello world' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(approval.id).toBe('apr-001');
    expect(approval.status).toBe('pending');

    const retrieved = store.get('apr-001');
    expect(retrieved).toBeDefined();
    expect(retrieved!.category).toBe('x_post');
    expect(retrieved!.summary).toBe('Post tweet: Hello world');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run src/approval.test.ts`
Expected: FAIL — module `./approval.js` not found

- [ ] **Step 3: Write ApprovalStore implementation**

```typescript
// src/approval.ts
import Database from 'better-sqlite3';
import { logger } from './logger.js';

export interface ApprovalRequest {
  id: string;
  category: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  groupFolder: string;
  expiresAt: string;
}

export interface Approval {
  id: string;
  category: string;
  action: string;
  summary: string;
  details: Record<string, unknown>;
  groupFolder: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  expiresAt: string;
  respondedBy: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export class ApprovalStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL,
        group_folder TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        expires_at TEXT NOT NULL,
        responded_by TEXT,
        responded_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_approvals_status
      ON pending_approvals(status)
    `);
  }

  create(req: ApprovalRequest): Approval {
    const stmt = this.db.prepare(`
      INSERT INTO pending_approvals (id, category, action, summary, details, group_folder, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(req.id, req.category, req.action, req.summary, JSON.stringify(req.details), req.groupFolder, req.expiresAt);
    return this.get(req.id)!;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare('SELECT * FROM pending_approvals WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.rowToApproval(row);
  }

  listPending(groupFolder?: string): Approval[] {
    const sql = groupFolder
      ? 'SELECT * FROM pending_approvals WHERE status = ? AND group_folder = ? ORDER BY created_at DESC'
      : 'SELECT * FROM pending_approvals WHERE status = ? ORDER BY created_at DESC';
    const args = groupFolder ? ['pending', groupFolder] : ['pending'];
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map(r => this.rowToApproval(r));
  }

  resolve(id: string, approved: boolean, respondedBy: string): Approval | undefined {
    const stmt = this.db.prepare(`
      UPDATE pending_approvals
      SET status = ?, responded_by = ?, responded_at = datetime('now')
      WHERE id = ? AND status = 'pending'
    `);
    const result = stmt.run(approved ? 'approved' : 'rejected', respondedBy, id);
    if (result.changes === 0) return undefined;
    return this.get(id);
  }

  expireStale(): number {
    const stmt = this.db.prepare(`
      UPDATE pending_approvals
      SET status = 'expired'
      WHERE status = 'pending' AND expires_at <= datetime('now')
    `);
    const result = stmt.run();
    return result.changes;
  }

  private rowToApproval(row: Record<string, unknown>): Approval {
    return {
      id: row.id as string,
      category: row.category as string,
      action: row.action as string,
      summary: row.summary as string,
      details: JSON.parse(row.details as string),
      groupFolder: row.group_folder as string,
      status: row.status as Approval['status'],
      expiresAt: row.expires_at as string,
      respondedBy: row.responded_by as string | null,
      respondedAt: row.responded_at as string | null,
      createdAt: row.created_at as string,
    };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run src/approval.test.ts`
Expected: PASS

- [ ] **Step 5: Add tests for resolve and expiry**

```typescript
// Append to src/approval.test.ts

  it('resolves an approval as approved', () => {
    store.create({
      id: 'apr-002',
      category: 'x_reply',
      action: 'reply',
      summary: 'Reply to @user',
      details: { tweetId: '123', content: 'Great post!' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const resolved = store.resolve('apr-002', true, 'whatsapp:matthew');
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe('approved');
    expect(resolved!.respondedBy).toBe('whatsapp:matthew');
  });

  it('resolves an approval as rejected', () => {
    store.create({
      id: 'apr-003',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet',
      details: { content: 'test' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const resolved = store.resolve('apr-003', false, 'telegram:matthew');
    expect(resolved).toBeDefined();
    expect(resolved!.status).toBe('rejected');
  });

  it('does not resolve an already-resolved approval', () => {
    store.create({
      id: 'apr-004',
      category: 'x_post',
      action: 'post',
      summary: 'Post tweet',
      details: { content: 'test' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    store.resolve('apr-004', true, 'whatsapp:matthew');
    const second = store.resolve('apr-004', false, 'telegram:someone');
    expect(second).toBeUndefined();
  });

  it('expires stale approvals', () => {
    store.create({
      id: 'apr-005',
      category: 'x_post',
      action: 'post',
      summary: 'Expired post',
      details: { content: 'old' },
      groupFolder: 'main',
      expiresAt: new Date(Date.now() - 1_000).toISOString(), // already expired
    });

    const count = store.expireStale();
    expect(count).toBe(1);

    const expired = store.get('apr-005');
    expect(expired!.status).toBe('expired');
  });

  it('lists pending approvals for a group', () => {
    store.create({
      id: 'apr-006', category: 'x_post', action: 'post', summary: 'A',
      details: {}, groupFolder: 'main',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    store.create({
      id: 'apr-007', category: 'x_like', action: 'like', summary: 'B',
      details: {}, groupFolder: 'other',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const mainApprovals = store.listPending('main');
    expect(mainApprovals).toHaveLength(1);
    expect(mainApprovals[0].id).toBe('apr-006');

    const allApprovals = store.listPending();
    expect(allApprovals).toHaveLength(2);
  });
```

- [ ] **Step 6: Run all approval tests**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run src/approval.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add src/approval.ts src/approval.test.ts
git commit -m "feat: add core approval store with SQLite persistence

Reusable approval mechanism for any skill that needs HITL confirmation.
Supports create, resolve (approve/reject), expiry, and listing."
```

---

### Task 2: Approval Policy Loader

**Files:**
- Modify: `src/approval.ts`
- Modify: `src/approval.test.ts`

- [ ] **Step 1: Write test for loadApprovalPolicy**

```typescript
// Append to src/approval.test.ts
import { loadApprovalPolicy, getActionMode } from './approval.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('ApprovalPolicy', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it('loads policy from JSON file', () => {
    const policyPath = path.join(tmpDir, 'approval-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
      defaults: { mode: 'confirm' },
      actions: {
        x_like: { mode: 'auto' },
        x_post: { mode: 'confirm' },
      },
      notifyChannels: ['whatsapp'],
      expiryMinutes: 30,
    }));

    const policy = loadApprovalPolicy(policyPath);
    expect(policy.defaults.mode).toBe('confirm');
    expect(policy.actions.x_like.mode).toBe('auto');
    expect(policy.expiryMinutes).toBe(30);
  });

  it('returns default policy when file does not exist', () => {
    const policy = loadApprovalPolicy(path.join(tmpDir, 'nonexistent.json'));
    expect(policy.defaults.mode).toBe('confirm');
    expect(policy.notifyChannels).toEqual([]);
    expect(policy.expiryMinutes).toBe(60);
  });

  it('resolves action mode with fallback to defaults', () => {
    const policy = loadApprovalPolicy(path.join(tmpDir, 'nonexistent.json'));
    expect(getActionMode(policy, 'x_post')).toBe('confirm');

    const policyPath = path.join(tmpDir, 'approval-policy.json');
    fs.writeFileSync(policyPath, JSON.stringify({
      defaults: { mode: 'confirm' },
      actions: { x_like: { mode: 'auto' } },
      notifyChannels: [],
      expiryMinutes: 60,
    }));

    const loaded = loadApprovalPolicy(policyPath);
    expect(getActionMode(loaded, 'x_like')).toBe('auto');
    expect(getActionMode(loaded, 'x_post')).toBe('confirm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run src/approval.test.ts`
Expected: FAIL — `loadApprovalPolicy` not exported

- [ ] **Step 3: Implement policy loader**

Add to `src/approval.ts`:

```typescript
import fs from 'fs';

export interface ApprovalPolicy {
  defaults: { mode: 'auto' | 'confirm' | 'block' };
  actions: Record<string, { mode: 'auto' | 'confirm' | 'block' }>;
  notifyChannels: string[];
  expiryMinutes: number;
}

const DEFAULT_POLICY: ApprovalPolicy = {
  defaults: { mode: 'confirm' },
  actions: {},
  notifyChannels: [],
  expiryMinutes: 60,
};

export function loadApprovalPolicy(filePath: string): ApprovalPolicy {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      defaults: parsed.defaults ?? DEFAULT_POLICY.defaults,
      actions: parsed.actions ?? {},
      notifyChannels: parsed.notifyChannels ?? [],
      expiryMinutes: parsed.expiryMinutes ?? 60,
    };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function getActionMode(
  policy: ApprovalPolicy,
  action: string,
): 'auto' | 'confirm' | 'block' {
  return policy.actions[action]?.mode ?? policy.defaults.mode;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run src/approval.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add src/approval.ts src/approval.test.ts
git commit -m "feat: add approval policy loader with sensible defaults

Reads approval-policy.json from group folder. Falls back to confirm-all
default when file is missing."
```

---

### Task 3: Wire Approval into IPC

**Files:**
- Modify: `src/ipc.ts:465-467`
- Modify: `src/approval.ts` (add IPC result writer)

- [ ] **Step 1: Add writeApprovalResult to approval.ts**

Add to `src/approval.ts`:

```typescript
import path from 'path';

export function writeApprovalResult(
  dataDir: string,
  sourceGroup: string,
  requestId: string,
  result: { requestId: string; approved: boolean; respondedBy: string; respondedAt: string },
): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'approval_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const filePath = path.join(resultsDir, `${requestId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(result));
  fs.renameSync(tempPath, filePath);
}
```

- [ ] **Step 2: Add request_approval case to processTaskIpc in src/ipc.ts**

Find the default case at line 465 of `src/ipc.ts`:
```typescript
default:
  logger.warn({ type: data.type }, 'Unknown IPC task type');
```

Add before it:

```typescript
case 'request_approval': {
  const { requestId, category, action, summary, details, expiresAt } = data;
  if (!requestId || !category || !action || !summary) {
    logger.warn({ type: data.type }, 'request_approval missing required fields');
    break;
  }

  const policyPath = path.join(GROUPS_DIR, sourceGroup, 'approval-policy.json');
  const policy = loadApprovalPolicy(policyPath);
  const mode = getActionMode(policy, category as string);

  if (mode === 'auto') {
    writeApprovalResult(DATA_DIR, sourceGroup, requestId as string, {
      requestId: requestId as string,
      approved: true,
      respondedBy: 'auto',
      respondedAt: new Date().toISOString(),
    });
    logger.info({ requestId, category }, 'Approval auto-approved by policy');
    break;
  }

  if (mode === 'block') {
    writeApprovalResult(DATA_DIR, sourceGroup, requestId as string, {
      requestId: requestId as string,
      approved: false,
      respondedBy: 'policy:block',
      respondedAt: new Date().toISOString(),
    });
    logger.info({ requestId, category }, 'Approval blocked by policy');
    break;
  }

  // mode === 'confirm'
  const expiryMinutes = policy.expiryMinutes ?? 60;
  const expiresAtDate = (expiresAt as string) || new Date(Date.now() + expiryMinutes * 60_000).toISOString();

  deps.approvalStore.create({
    id: requestId as string,
    category: category as string,
    action: action as string,
    summary: summary as string,
    details: (details as Record<string, unknown>) ?? {},
    groupFolder: sourceGroup,
    expiresAt: expiresAtDate,
  });

  // Notify configured channels
  const notifyText = `Approval needed: ${summary}\nReply YES or NO (expires in ${expiryMinutes}m)\n[ID: ${requestId}]`;
  for (const channelName of policy.notifyChannels) {
    try {
      await deps.sendToGroup(sourceGroup, notifyText);
    } catch (err) {
      logger.error({ err, channelName, requestId }, 'Failed to send approval notification');
    }
  }

  logger.info({ requestId, category, expiresAt: expiresAtDate }, 'Approval pending confirmation');
  break;
}
```

- [ ] **Step 3: Add imports to src/ipc.ts**

Add at top of `src/ipc.ts`:

```typescript
import { ApprovalStore, loadApprovalPolicy, getActionMode, writeApprovalResult } from './approval.js';
```

Add `approvalStore: ApprovalStore` and `sendToGroup: (groupFolder: string, text: string) => Promise<void>` to the deps interface for `processTaskIpc`.

- [ ] **Step 4: Run existing IPC tests to verify no regressions**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run`
Expected: All existing tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add src/ipc.ts src/approval.ts
git commit -m "feat: wire request_approval IPC type into host

Handles auto/confirm/block modes per approval policy. Sends
notifications to configured channels for confirm mode."
```

---

### Task 4: Add request_approval MCP Tool to Container

**Files:**
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts`

- [ ] **Step 1: Add request_approval tool after register_group tool (after line 338)**

```typescript
server.tool(
  'request_approval',
  'Request human approval before performing an action. Returns approved/rejected/expired status. ' +
  'Use this before write actions that require confirmation per the approval policy.',
  {
    requestId: z.string().describe('Unique ID for this approval request (e.g., apr-{timestamp}-{random})'),
    category: z.string().describe('Action category (e.g., x_post, x_reply, x_quote)'),
    action: z.string().describe('Short action name (e.g., post, reply, quote)'),
    summary: z.string().describe('Human-readable summary shown in approval notification'),
    details: z.record(z.unknown()).optional().describe('Full action payload for audit trail'),
  },
  async (args) => {
    const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(); // 1 hour default

    writeIpcFile(TASKS_DIR, {
      type: 'request_approval',
      requestId: args.requestId,
      category: args.category,
      action: args.action,
      summary: args.summary,
      details: args.details ?? {},
      expiresAt,
      groupFolder: NANOCLAW_GROUP_FOLDER,
      timestamp: new Date().toISOString(),
    });

    // Poll for result
    const resultDir = path.join(IPC_DIR, 'approval_results');
    const resultFile = path.join(resultDir, `${args.requestId}.json`);
    const maxWait = 3600_000; // 1 hour
    const pollInterval = 2_000;
    let elapsed = 0;

    while (elapsed < maxWait) {
      if (fs.existsSync(resultFile)) {
        try {
          const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
          fs.unlinkSync(resultFile);
          return {
            content: [{
              type: 'text' as const,
              text: result.approved
                ? `Approved by ${result.respondedBy}`
                : `Rejected by ${result.respondedBy}`,
            }],
            isError: !result.approved,
          };
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Failed to read approval result: ${err}` }],
            isError: true,
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      elapsed += pollInterval;
    }

    return {
      content: [{ type: 'text' as const, text: 'Approval request timed out' }],
      isError: true,
    };
  },
);
```

- [ ] **Step 2: Verify the container agent-runner compiles**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw/container/agent-runner && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: add request_approval MCP tool for container agents

Agents can request human approval before write actions. Writes IPC
request, polls for result file. Supports 1-hour timeout."
```

---

### Task 5: Approval Expiry Timer and Response Detection

**Files:**
- Modify: `src/index.ts`
- Modify: `src/approval.ts`

- [ ] **Step 1: Add expiry check to approval store**

Add to `src/approval.ts`:

```typescript
export function startApprovalExpiryTimer(
  store: ApprovalStore,
  dataDir: string,
  intervalMs = 30_000,
): NodeJS.Timeout {
  return setInterval(() => {
    const expired = store.expireStale();
    if (expired > 0) {
      logger.info({ count: expired }, 'Expired stale approvals');
      // Write expired results for each
      const pending = store.listPending();
      // Already expired by expireStale, so we need to write results
      // for approvals that just transitioned. Query recently expired:
      const db = (store as any).db as Database.Database;
      const recentlyExpired = db.prepare(`
        SELECT id, group_folder FROM pending_approvals
        WHERE status = 'expired' AND responded_at IS NULL
      `).all() as { id: string; group_folder: string }[];

      for (const row of recentlyExpired) {
        writeApprovalResult(dataDir, row.group_folder, row.id, {
          requestId: row.id,
          approved: false,
          respondedBy: 'system:expired',
          respondedAt: new Date().toISOString(),
        });
        // Mark as having been notified
        db.prepare(`UPDATE pending_approvals SET responded_at = datetime('now') WHERE id = ?`).run(row.id);
      }
    }
  }, intervalMs);
}
```

- [ ] **Step 2: Wire into src/index.ts**

Add import and initialization in `src/index.ts` after the database is opened (near the approval store initialization):

```typescript
import { ApprovalStore, startApprovalExpiryTimer } from './approval.js';

// After db initialization:
const approvalStore = new ApprovalStore(db);
const approvalTimer = startApprovalExpiryTimer(approvalStore, DATA_DIR);

// On shutdown:
clearInterval(approvalTimer);
```

Pass `approvalStore` to the IPC processing deps.

- [ ] **Step 3: Add approval response detection in message handler**

In the message processing flow in `src/index.ts`, add detection for YES/NO replies to approval notifications. When an incoming message contains "YES" or "NO" followed by an approval ID pattern `[ID: apr-xxx]`:

```typescript
// In the incoming message handler, before routing to agent:
const approvalMatch = text.match(/^(YES|NO)\b/i);
if (approvalMatch) {
  const idMatch = text.match(/\[ID:\s*(apr-[^\]]+)\]/);
  if (idMatch) {
    const approved = approvalMatch[1].toUpperCase() === 'YES';
    const approvalId = idMatch[1];
    const resolved = approvalStore.resolve(approvalId, approved, `${channel}:${senderName}`);
    if (resolved) {
      writeApprovalResult(DATA_DIR, resolved.groupFolder, approvalId, {
        requestId: approvalId,
        approved,
        respondedBy: `${channel}:${senderName}`,
        respondedAt: new Date().toISOString(),
      });
      await routeOutbound(channels, chatJid, `Approval ${approvalId}: ${approved ? 'Approved' : 'Rejected'}`);
      return; // Don't route to agent
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add src/index.ts src/approval.ts
git commit -m "feat: add approval expiry timer and message-based response detection

Approvals expire automatically. Users can reply YES/NO to approval
notifications in any configured messaging channel."
```

---

## Phase 2: Social Monitor Framework (nanoclaw container skill)

### Task 6: Framework Interfaces

**Files:**
- Create: `container/skills/social-monitor/interfaces.ts`

- [ ] **Step 1: Write the interfaces file**

```typescript
// container/skills/social-monitor/interfaces.ts

export interface MonitorContext {
  groupFolder: string;
  personaPath: string;
  approvalPolicyPath: string;
  dryRun: boolean;
}

export interface TimelineItem {
  id: string;
  author: { handle: string; name: string; followers?: number };
  content: string;
  createdAt: string;
  metrics?: { likes: number; replies: number; reposts: number };
  url: string;
}

export interface EngagementAction {
  type: 'like' | 'reply' | 'repost' | 'quote' | 'ignore';
  targetId: string;
  targetUrl: string;
  targetAuthor: string;
  targetContent: string;
  content?: string; // for reply/quote
  approvalCategory: string; // e.g., 'x_like', 'x_reply'
}

export interface ActionResult {
  success: boolean;
  platformId?: string;
  url?: string;
  error?: string;
  dryRun?: boolean;
}

export interface PersonaDraft {
  content: string;
  sourceStats: {
    postsAnalyzed: number;
    likesAnalyzed: number;
    dateRange: { from: string; to: string };
  };
}

export interface SocialMonitor {
  platform: string;
  fetchTimeline(ctx: MonitorContext): Promise<TimelineItem[]>;
  formatForDecision(items: TimelineItem[]): string;
  executeAction(action: EngagementAction): Promise<ActionResult>;
  bootstrapPersona?(ctx: MonitorContext): Promise<PersonaDraft>;
}

export interface EngagementLogEntry {
  id: string;
  platform: string;
  actionType: string;
  targetId: string;
  targetUrl: string;
  targetAuthor: string;
  targetContent: string;
  content: string | null;
  approvalId: string | null;
  status: 'executed' | 'rejected' | 'expired' | 'failed';
  triggeredBy: 'monitor' | 'command';
  createdAt: string;
  executedAt: string | null;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/social-monitor/interfaces.ts
git commit -m "feat: define social monitor framework interfaces

SocialMonitor, TimelineItem, EngagementAction, ActionResult,
PersonaDraft, and EngagementLogEntry types."
```

---

### Task 7: Deduplication Store

**Files:**
- Create: `container/skills/social-monitor/dedup.ts`

- [ ] **Step 1: Write the dedup store**

```typescript
// container/skills/social-monitor/dedup.ts
import Database from 'better-sqlite3';

export class DedupStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS seen_items (
        item_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        seen_at TEXT NOT NULL DEFAULT (datetime('now')),
        action_taken TEXT,
        PRIMARY KEY (item_id, platform)
      )
    `);
  }

  hasSeen(itemId: string, platform: string): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM seen_items WHERE item_id = ? AND platform = ?',
    ).get(itemId, platform);
    return !!row;
  }

  markSeen(itemId: string, platform: string, actionTaken?: string): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO seen_items (item_id, platform, action_taken)
      VALUES (?, ?, ?)
    `).run(itemId, platform, actionTaken ?? null);
  }

  filterUnseen<T extends { id: string }>(items: T[], platform: string): T[] {
    return items.filter(item => !this.hasSeen(item.id, platform));
  }

  prune(maxAgeDays = 7): number {
    const result = this.db.prepare(`
      DELETE FROM seen_items
      WHERE seen_at < datetime('now', '-' || ? || ' days')
    `).run(maxAgeDays);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/social-monitor/dedup.ts
git commit -m "feat: add deduplication store for timeline monitoring

SQLite-backed seen_items table with 7-day TTL pruning."
```

---

### Task 8: Engagement Log

**Files:**
- Create: `container/skills/social-monitor/engagement-log.ts`

- [ ] **Step 1: Write the engagement log store**

```typescript
// container/skills/social-monitor/engagement-log.ts
import Database from 'better-sqlite3';
import type { EngagementLogEntry } from './interfaces.js';

export class EngagementLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engagement_log (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_url TEXT NOT NULL,
        target_author TEXT NOT NULL,
        target_content TEXT NOT NULL,
        content TEXT,
        approval_id TEXT,
        status TEXT NOT NULL,
        triggered_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        executed_at TEXT
      )
    `);
  }

  log(entry: EngagementLogEntry): void {
    this.db.prepare(`
      INSERT INTO engagement_log
        (id, platform, action_type, target_id, target_url, target_author,
         target_content, content, approval_id, status, triggered_by, executed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.id, entry.platform, entry.actionType, entry.targetId,
      entry.targetUrl, entry.targetAuthor, entry.targetContent,
      entry.content, entry.approvalId, entry.status, entry.triggeredBy,
      entry.executedAt,
    );
  }

  updateStatus(id: string, status: string, executedAt?: string): void {
    this.db.prepare(`
      UPDATE engagement_log SET status = ?, executed_at = ? WHERE id = ?
    `).run(status, executedAt ?? null, id);
  }

  listRecent(platform: string, limit = 50): EngagementLogEntry[] {
    const rows = this.db.prepare(`
      SELECT * FROM engagement_log
      WHERE platform = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(platform, limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as string,
      platform: r.platform as string,
      actionType: r.action_type as string,
      targetId: r.target_id as string,
      targetUrl: r.target_url as string,
      targetAuthor: r.target_author as string,
      targetContent: r.target_content as string,
      content: r.content as string | null,
      approvalId: r.approval_id as string | null,
      status: r.status as EngagementLogEntry['status'],
      triggeredBy: r.triggered_by as EngagementLogEntry['triggeredBy'],
      createdAt: r.created_at as string,
      executedAt: r.executed_at as string | null,
    }));
  }

  /** Returns entries for syncing to platform, then marks them as synced. */
  drainForSync(platform: string): EngagementLogEntry[] {
    const entries = this.listRecent(platform);
    // In practice, track a sync cursor. For now, return all recent.
    return entries;
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/social-monitor/engagement-log.ts
git commit -m "feat: add engagement log for audit trail

SQLite-backed log of all engagement actions with status tracking."
```

---

### Task 9: Decision Prompt Builder

**Files:**
- Create: `container/skills/social-monitor/decision-prompt.ts`

- [ ] **Step 1: Write the prompt builder**

```typescript
// container/skills/social-monitor/decision-prompt.ts
import fs from 'fs';
import type { TimelineItem } from './interfaces.js';

export function buildDecisionPrompt(
  personaPath: string,
  formattedItems: string,
): string {
  let persona = '';
  try {
    persona = fs.readFileSync(personaPath, 'utf-8');
  } catch {
    persona = '(No persona file found. Use general good judgment.)';
  }

  return `You are managing a social media account. Your persona and engagement rules are below.

<persona>
${persona}
</persona>

<timeline>
${formattedItems}
</timeline>

For each timeline item, decide what action to take. Options:
- "ignore" — skip this item
- "like" — like/favorite it
- "reply" — reply with a message (provide content)
- "repost" — repost/retweet it
- "quote" — quote it with your own commentary (provide content)

Follow the persona rules strictly:
- "Always Engage" items should get at least a like
- "Never Engage" items must be ignored
- For everything else, use your judgment based on the persona's goals and style

Respond with a JSON array. Each element:
{
  "itemIndex": <number>,
  "action": "ignore" | "like" | "reply" | "repost" | "quote",
  "content": "<reply or quote text, omit for like/repost/ignore>"
}

Only include items where action is NOT "ignore". Respond with ONLY the JSON array, no other text.`;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/social-monitor/decision-prompt.ts
git commit -m "feat: add decision prompt builder for Claude engagement decisions

Combines persona file with formatted timeline items into a structured
prompt that returns JSON engagement actions."
```

---

### Task 10: Pipeline Orchestrator

**Files:**
- Create: `container/skills/social-monitor/framework.ts`
- Create: `container/skills/social-monitor/SKILL.md`

- [ ] **Step 1: Write the framework orchestrator**

```typescript
// container/skills/social-monitor/framework.ts
import path from 'path';
import { DedupStore } from './dedup.js';
import { EngagementLog } from './engagement-log.js';
import { buildDecisionPrompt } from './decision-prompt.js';
import type {
  SocialMonitor,
  MonitorContext,
  EngagementAction,
  EngagementLogEntry,
} from './interfaces.js';

interface FrameworkDeps {
  /** Send a prompt to Claude and get a response */
  askClaude: (prompt: string) => Promise<string>;
  /** Request approval via IPC and wait for result */
  requestApproval: (args: {
    requestId: string;
    category: string;
    action: string;
    summary: string;
    details: Record<string, unknown>;
  }) => Promise<{ approved: boolean; respondedBy: string }>;
  /** Send engagement sync IPC message */
  syncEngagement: (entries: EngagementLogEntry[]) => void;
}

export async function runMonitorCycle(
  monitor: SocialMonitor,
  ctx: MonitorContext,
  deps: FrameworkDeps,
): Promise<{ actionsExecuted: number; actionsPending: number }> {
  const groupDir = `/workspace/group`;
  const dedupPath = path.join(groupDir, 'seen_items.db');
  const logPath = path.join(groupDir, 'engagement_log.db');

  const dedup = new DedupStore(dedupPath);
  const engLog = new EngagementLog(logPath);

  try {
    // 1. Fetch
    const allItems = await monitor.fetchTimeline(ctx);

    // 2. Filter
    const newItems = dedup.filterUnseen(allItems, monitor.platform);
    if (newItems.length === 0) {
      dedup.prune();
      return { actionsExecuted: 0, actionsPending: 0 };
    }

    // 3. Decide
    const formatted = monitor.formatForDecision(newItems);
    const prompt = buildDecisionPrompt(ctx.personaPath, formatted);
    const response = await deps.askClaude(prompt);

    let decisions: Array<{ itemIndex: number; action: string; content?: string }>;
    try {
      // Extract JSON from potential markdown code fence
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      decisions = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      decisions = [];
    }

    // 4. Act
    let actionsExecuted = 0;
    let actionsPending = 0;

    for (const decision of decisions) {
      const item = newItems[decision.itemIndex];
      if (!item || decision.action === 'ignore') continue;

      const action: EngagementAction = {
        type: decision.action as EngagementAction['type'],
        targetId: item.id,
        targetUrl: item.url,
        targetAuthor: item.author.handle,
        targetContent: item.content,
        content: decision.content,
        approvalCategory: `${monitor.platform}_${decision.action}`,
      };

      const entryId = `${monitor.platform}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const logEntry: EngagementLogEntry = {
        id: entryId,
        platform: monitor.platform,
        actionType: decision.action,
        targetId: item.id,
        targetUrl: item.url,
        targetAuthor: item.author.handle,
        targetContent: item.content.slice(0, 500),
        content: decision.content ?? null,
        approvalId: null,
        status: 'executed',
        triggeredBy: 'monitor',
        createdAt: new Date().toISOString(),
        executedAt: null,
      };

      // Check approval policy (loaded by the caller, passed via context)
      // For the framework, we always go through requestApproval which checks policy
      const approvalId = `apr-${entryId}`;

      try {
        const approvalResult = await deps.requestApproval({
          requestId: approvalId,
          category: action.approvalCategory,
          action: decision.action,
          summary: `${decision.action} ${item.author.handle}: "${item.content.slice(0, 100)}..."`,
          details: { ...action },
        });

        logEntry.approvalId = approvalId;

        if (!approvalResult.approved) {
          logEntry.status = 'rejected';
          engLog.log(logEntry);
          continue;
        }
      } catch {
        logEntry.status = 'failed';
        engLog.log(logEntry);
        continue;
      }

      // Execute the action
      if (ctx.dryRun) {
        logEntry.status = 'executed';
        logEntry.executedAt = new Date().toISOString();
        engLog.log(logEntry);
        dedup.markSeen(item.id, monitor.platform, decision.action);
        actionsExecuted++;
        continue;
      }

      try {
        const result = await monitor.executeAction(action);
        if (result.success) {
          logEntry.status = 'executed';
          logEntry.executedAt = new Date().toISOString();
          actionsExecuted++;
        } else {
          logEntry.status = 'failed';
        }
      } catch {
        logEntry.status = 'failed';
      }

      engLog.log(logEntry);
      dedup.markSeen(item.id, monitor.platform, decision.action);
    }

    // Mark all fetched items as seen (even if ignored)
    for (const item of newItems) {
      if (!dedup.hasSeen(item.id, monitor.platform)) {
        dedup.markSeen(item.id, monitor.platform, 'ignored');
      }
    }

    // 5. Sync
    const toSync = engLog.drainForSync(monitor.platform);
    if (toSync.length > 0) {
      deps.syncEngagement(toSync);
    }

    dedup.prune();
    return { actionsExecuted, actionsPending };
  } finally {
    dedup.close();
    engLog.close();
  }
}
```

- [ ] **Step 2: Write SKILL.md**

```markdown
---
name: social-monitor
description: Generic social media timeline monitoring framework. Provides fetch-filter-decide-act pipeline for autonomous engagement. Platform-specific skills implement the SocialMonitor interface.
---

# Social Monitor Framework

Generic pipeline for autonomous social media engagement.

## Architecture

```
fetch timeline → filter (dedup) → decide (Claude) → act (with approval) → sync to platform
```

## Usage

Platform skills (X, LinkedIn, etc.) implement the `SocialMonitor` interface from `interfaces.ts` and pass it to `runMonitorCycle()` from `framework.ts`.

## Files

- `interfaces.ts` — Type definitions
- `framework.ts` — Pipeline orchestrator
- `dedup.ts` — Seen items deduplication store
- `engagement-log.ts` — Audit trail
- `decision-prompt.ts` — Claude prompt builder
```

- [ ] **Step 3: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/social-monitor/
git commit -m "feat: add social monitor framework with pipeline orchestrator

Generic fetch-filter-decide-act pipeline. Platform skills implement
SocialMonitor interface. Includes dedup, engagement log, and Claude
decision prompt builder."
```

---

## Phase 3: X Integration Skill (nanoclaw container)

### Task 11: XDK Client Wrapper

**Files:**
- Create: `container/skills/x-integration/client.ts`
- Modify: `container/agent-runner/package.json`

- [ ] **Step 1: Add @xdevplatform/xdk to container package.json**

Add to `container/agent-runner/package.json` dependencies:

```json
"@xdevplatform/xdk": "^0.5.0"
```

- [ ] **Step 2: Install dependency**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw/container/agent-runner && npm install`

- [ ] **Step 3: Write XDK client wrapper**

```typescript
// container/skills/x-integration/client.ts
import { Client } from '@xdevplatform/xdk';

let cachedClient: Client | null = null;
let cachedUserId: string | null = null;

export function getXClient(): Client {
  if (cachedClient) return cachedClient;

  const accessToken = process.env.X_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('X_ACCESS_TOKEN environment variable not set. Ensure OneCLI proxy is configured.');
  }

  cachedClient = new Client({ accessToken });
  return cachedClient;
}

export async function getAuthenticatedUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId;

  const client = getXClient();
  const me = await client.users.getMe();
  if (!me.data?.id) {
    throw new Error('Failed to get authenticated user ID from X API');
  }
  cachedUserId = me.data.id;
  return cachedUserId;
}

export function isDryRun(): boolean {
  return process.env.X_DRY_RUN === 'true';
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw/container/agent-runner && npx tsc --noEmit`
Expected: No errors (the skill files may not be in the tsconfig include path yet — verify and add if needed)

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/agent-runner/package.json container/agent-runner/package-lock.json container/skills/x-integration/client.ts
git commit -m "feat: add XDK client wrapper for X integration

Initializes @xdevplatform/xdk with access token from OneCLI proxy.
Caches client and authenticated user ID."
```

---

### Task 12: X Actions Module

**Files:**
- Create: `container/skills/x-integration/actions.ts`

- [ ] **Step 1: Write the actions module**

```typescript
// container/skills/x-integration/actions.ts
import { getXClient, getAuthenticatedUserId, isDryRun } from './client.js';
import type { ActionResult } from '../social-monitor/interfaces.js';

export async function postTweet(text: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would post: "${text.slice(0, 50)}..."` };
  }
  const client = getXClient();
  const response = await client.posts.create({ text });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function replyToTweet(tweetId: string, text: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would reply to ${tweetId}` };
  }
  const client = getXClient();
  const response = await client.posts.create({
    text,
    reply: { in_reply_to_tweet_id: tweetId },
  });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function quoteTweet(tweetId: string, comment: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true, url: `(dry-run) would quote ${tweetId}` };
  }
  const client = getXClient();
  const response = await client.posts.create({
    text: comment,
    quote_tweet_id: tweetId,
  });
  const id = response.data?.id;
  return {
    success: true,
    platformId: id,
    url: id ? `https://x.com/i/web/status/${id}` : undefined,
  };
}

export async function likeTweet(tweetId: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true };
  }
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  await client.users.likePost(userId, { body: { tweet_id: tweetId } });
  return { success: true };
}

export async function retweet(tweetId: string): Promise<ActionResult> {
  if (isDryRun()) {
    return { success: true, dryRun: true };
  }
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  await client.users.repostPost(userId, { body: { tweet_id: tweetId } });
  return { success: true };
}

export async function searchRecent(query: string, maxResults = 10): Promise<unknown> {
  const client = getXClient();
  const response = await client.posts.searchRecent(query, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
  });
  return response;
}

export async function getHomeTimeline(maxResults = 50): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getTimeline(userId, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
    expansions: ['author_id'],
    userFields: ['name', 'username', 'public_metrics'],
  });
  return response;
}

export async function getUserTweets(maxResults = 100): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getPosts(userId, {
    maxResults,
    tweetFields: ['created_at', 'public_metrics', 'referenced_tweets'],
  });
  return response;
}

export async function getLikedTweets(maxResults = 100): Promise<unknown> {
  const client = getXClient();
  const userId = await getAuthenticatedUserId();
  const response = await client.users.getLikedPosts(userId, {
    maxResults,
    tweetFields: ['author_id', 'created_at', 'public_metrics'],
  });
  return response;
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/x-integration/actions.ts
git commit -m "feat: add X actions module wrapping XDK SDK calls

Post, reply, quote, like, retweet, search, timeline, and user
tweets/likes. All respect DRY_RUN mode."
```

---

### Task 13: X SocialMonitor Implementation

**Files:**
- Create: `container/skills/x-integration/monitor.ts`

- [ ] **Step 1: Write the monitor implementation**

```typescript
// container/skills/x-integration/monitor.ts
import type {
  SocialMonitor,
  MonitorContext,
  TimelineItem,
  EngagementAction,
  ActionResult,
  PersonaDraft,
} from '../social-monitor/interfaces.js';
import {
  postTweet,
  replyToTweet,
  quoteTweet,
  likeTweet,
  retweet,
  getHomeTimeline,
  getUserTweets,
  getLikedTweets,
} from './actions.js';

export class XMonitor implements SocialMonitor {
  platform = 'x';

  async fetchTimeline(ctx: MonitorContext): Promise<TimelineItem[]> {
    const response = await getHomeTimeline(50) as any;
    const tweets = response.data ?? [];
    const users = new Map<string, any>();
    for (const user of response.includes?.users ?? []) {
      users.set(user.id, user);
    }

    return tweets.map((tweet: any) => {
      const author = users.get(tweet.author_id);
      return {
        id: tweet.id,
        author: {
          handle: author?.username ?? 'unknown',
          name: author?.name ?? 'Unknown',
          followers: author?.public_metrics?.followers_count,
        },
        content: tweet.text,
        createdAt: tweet.created_at,
        metrics: tweet.public_metrics
          ? {
              likes: tweet.public_metrics.like_count,
              replies: tweet.public_metrics.reply_count,
              reposts: tweet.public_metrics.retweet_count,
            }
          : undefined,
        url: `https://x.com/${author?.username ?? 'i'}/status/${tweet.id}`,
      };
    });
  }

  formatForDecision(items: TimelineItem[]): string {
    return items
      .map((item, i) => {
        const metrics = item.metrics
          ? ` [${item.metrics.likes}L ${item.metrics.replies}R ${item.metrics.reposts}RT]`
          : '';
        return `[${i}] @${item.author.handle}${item.author.followers ? ` (${item.author.followers} followers)` : ''}${metrics}\n    ${item.content}\n    ${item.url}`;
      })
      .join('\n\n');
  }

  async executeAction(action: EngagementAction): Promise<ActionResult> {
    switch (action.type) {
      case 'like':
        return likeTweet(action.targetId);
      case 'reply':
        if (!action.content) return { success: false, error: 'Reply requires content' };
        return replyToTweet(action.targetId, action.content);
      case 'repost':
        return retweet(action.targetId);
      case 'quote':
        if (!action.content) return { success: false, error: 'Quote requires content' };
        return quoteTweet(action.targetId, action.content);
      default:
        return { success: false, error: `Unknown action type: ${action.type}` };
    }
  }

  async bootstrapPersona(ctx: MonitorContext): Promise<PersonaDraft> {
    const [tweetsResp, likesResp] = await Promise.all([
      getUserTweets(200) as Promise<any>,
      getLikedTweets(100) as Promise<any>,
    ]);

    const tweets = tweetsResp.data ?? [];
    const likes = likesResp.data ?? [];

    const tweetDates = tweets.map((t: any) => t.created_at).filter(Boolean).sort();
    const dateRange = {
      from: tweetDates[0] ?? new Date().toISOString(),
      to: tweetDates[tweetDates.length - 1] ?? new Date().toISOString(),
    };

    const tweetSummary = tweets
      .slice(0, 50)
      .map((t: any, i: number) => `[${i}] ${t.text}`)
      .join('\n');

    const likeSummary = likes
      .slice(0, 30)
      .map((t: any, i: number) => `[${i}] ${t.text}`)
      .join('\n');

    // This content will be passed to Claude by the setup tool
    const analysisPrompt = `Analyze this X/Twitter account's recent activity and generate an x-persona.md file.

<recent_tweets count="${tweets.length}">
${tweetSummary}
</recent_tweets>

<recent_likes count="${likes.length}">
${likeSummary}
</recent_likes>

Generate an x-persona.md following this template exactly:

# X Persona

## Identity
(Describe the account's voice, tone, and role based on their tweets)

## Engage Rules
### Always Engage
- @handles: (accounts they interact with most)
- Topics: (recurring themes in their tweets and likes)

### Never Engage
- Topics: (topics they clearly avoid)
- Accounts: (types of accounts they don't engage with)

### Style
- Replies: (describe their reply style based on their tweets)
- Likes: (describe what they tend to like)
- Quotes: (describe when they quote tweet)

## Content Guidelines
- Voice: (describe their writing voice)
- Promote: (what they promote or share)
- Avoid: (what they avoid posting about)

## Goals
- (Inferred goals based on their activity patterns)

Be specific and grounded in the actual data. Don't make up details that aren't supported by the tweets and likes.`;

    return {
      content: analysisPrompt,
      sourceStats: {
        postsAnalyzed: tweets.length,
        likesAnalyzed: likes.length,
        dateRange,
      },
    };
  }
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/x-integration/monitor.ts
git commit -m "feat: implement SocialMonitor for X platform

XMonitor handles timeline fetching, formatting for Claude decisions,
action execution, and persona bootstrapping from account history."
```

---

### Task 14: X MCP Tools

**Files:**
- Create: `container/skills/x-integration/tools.ts`
- Create: `container/skills/x-integration/SKILL.md`

- [ ] **Step 1: Write the MCP tools**

```typescript
// container/skills/x-integration/tools.ts
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import {
  postTweet,
  replyToTweet,
  quoteTweet,
  likeTweet,
  retweet,
  searchRecent,
  getHomeTimeline,
} from './actions.js';
import { XMonitor } from './monitor.js';
import { runMonitorCycle } from '../social-monitor/framework.js';
import type { MonitorContext, EngagementLogEntry } from '../social-monitor/interfaces.js';

const TASKS_DIR = '/workspace/ipc/tasks';
const IPC_DIR = '/workspace/ipc';
const GROUP_FOLDER = process.env.NANOCLAW_GROUP_FOLDER || '';
const IS_MAIN = process.env.NANOCLAW_IS_MAIN === 'true';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

function mainOnly(): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!IS_MAIN) {
    return {
      content: [{ type: 'text', text: 'Only the main group can use X integration.' }],
      isError: true,
    };
  }
  return null;
}

export function createXTools(server: any) {
  server.tool(
    'x_post',
    'Post a tweet to X. Requires approval per policy.',
    { content: z.string().max(280).describe('Tweet text (max 280 chars)') },
    async (args: { content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const result = await postTweet(args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Tweet posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_like',
    'Like a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        await likeTweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Liked tweet ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_reply',
    'Reply to a tweet on X. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      content: z.string().max(280).describe('Reply text (max 280 chars)'),
    },
    async (args: { tweet_url: string; content: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const result = await replyToTweet(tweetId, args.content);
        return { content: [{ type: 'text' as const, text: result.url || 'Reply posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_retweet',
    'Retweet a tweet on X.',
    { tweet_url: z.string().describe('Tweet URL or ID') },
    async (args: { tweet_url: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        await retweet(tweetId);
        return { content: [{ type: 'text' as const, text: `Retweeted ${tweetId}` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_quote',
    'Quote tweet on X with your own commentary. Requires approval per policy.',
    {
      tweet_url: z.string().describe('Tweet URL or ID'),
      comment: z.string().max(280).describe('Your commentary (max 280 chars)'),
    },
    async (args: { tweet_url: string; comment: string }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      const tweetId = extractTweetId(args.tweet_url);
      try {
        const result = await quoteTweet(tweetId, args.comment);
        return { content: [{ type: 'text' as const, text: result.url || 'Quote posted' }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_search',
    'Search recent tweets on X (last 7 days).',
    {
      query: z.string().describe('Search query'),
      max_results: z.number().min(10).max(100).default(10).optional(),
    },
    async (args: { query: string; max_results?: number }) => {
      try {
        const results = await searchRecent(args.query, args.max_results ?? 10);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_timeline',
    'Fetch your home timeline from X.',
    { max_results: z.number().min(10).max(100).default(50).optional() },
    async (args: { max_results?: number }) => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const results = await getHomeTimeline(args.max_results ?? 50);
        return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );

  server.tool(
    'x_setup',
    'Bootstrap your X persona from account history. Analyzes recent tweets and likes to generate an x-persona.md draft for review.',
    {},
    async () => {
      const blocked = mainOnly();
      if (blocked) return blocked;
      try {
        const monitor = new XMonitor();
        const ctx: MonitorContext = {
          groupFolder: GROUP_FOLDER,
          personaPath: '/workspace/group/x-persona.md',
          approvalPolicyPath: '/workspace/group/approval-policy.json',
          dryRun: false,
        };
        const draft = await monitor.bootstrapPersona!(ctx);
        // The draft.content is actually an analysis prompt for Claude.
        // Return it so the agent can process it and write the persona file.
        return {
          content: [{
            type: 'text' as const,
            text: `Persona bootstrap data collected. ${draft.sourceStats.postsAnalyzed} tweets and ${draft.sourceStats.likesAnalyzed} likes analyzed (${draft.sourceStats.dateRange.from} to ${draft.sourceStats.dateRange.to}).\n\nUse the analysis below to generate the x-persona.md file and save it to /workspace/group/x-persona.md. The user should review and edit it.\n\n${draft.content}`,
          }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Failed: ${err.message}` }], isError: true };
      }
    },
  );
}

function extractTweetId(urlOrId: string): string {
  const match = urlOrId.match(/status\/(\d+)/);
  return match ? match[1] : urlOrId;
}
```

- [ ] **Step 2: Write SKILL.md**

```markdown
---
name: x-integration
description: X (Twitter) integration using official XDK SDK. Post, like, reply, retweet, quote, search, timeline monitoring. Use for setup, testing, or X interactions. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X (Twitter) Integration

Direct X API integration via official `@xdevplatform/xdk` SDK.

## Prerequisites

1. X account connected via bearclaw-platform UI (OAuth 2.0)
2. OneCLI vault configured with X API credentials
3. `x-persona.md` in group folder (run `x_setup` to bootstrap)

## Tools

| Tool | Description | Approval |
|------|-------------|----------|
| `x_setup` | Bootstrap persona from account history | None (read-only) |
| `x_post` | Post a tweet | Per policy (default: confirm) |
| `x_like` | Like a tweet | Per policy (default: auto) |
| `x_reply` | Reply to a tweet | Per policy (default: confirm) |
| `x_retweet` | Retweet | Per policy (default: auto) |
| `x_quote` | Quote tweet | Per policy (default: confirm) |
| `x_search` | Search recent tweets | None (read-only) |
| `x_timeline` | Fetch home timeline | None (read-only) |

## DRY_RUN Mode

Set `X_DRY_RUN=true` to test without making real API calls.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/skills/x-integration/
git commit -m "feat: add X integration MCP tools and SKILL.md

8 tools: x_setup, x_post, x_like, x_reply, x_retweet, x_quote,
x_search, x_timeline. Main-group only. DRY_RUN support."
```

---

### Task 15: Container Build Updates

**Files:**
- Modify: `container/Dockerfile`
- Modify: `container/agent-runner/src/ipc-mcp-stdio.ts` (import X tools)

- [ ] **Step 1: Update Dockerfile to copy skill files**

After the `COPY agent-runner/ ./` line and before `RUN npm run build`, add:

```dockerfile
# Copy social monitor and X integration skills
COPY skills/social-monitor/ ./src/skills/social-monitor/
COPY skills/x-integration/ ./src/skills/x-integration/
```

- [ ] **Step 2: Import and register X tools in ipc-mcp-stdio.ts**

Add import at top of `container/agent-runner/src/ipc-mcp-stdio.ts`:

```typescript
// @ts-ignore - Copied during Docker build from container/skills/
import { createXTools } from './skills/x-integration/tools.js';
```

Add after the last `server.tool()` call (before `server.connect()`):

```typescript
if (NANOCLAW_IS_MAIN === 'true') {
  createXTools(server);
}
```

- [ ] **Step 3: Verify container agent-runner compiles**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw/container/agent-runner && npx tsc --noEmit`
Expected: No errors (or expected @ts-ignore warnings)

- [ ] **Step 4: Build the container**

Run: `cd /Users/matthewholden/code/bearclaw/nanoclaw && ./container/build.sh`
Expected: Build succeeds, output shows COPY of skill files

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add container/Dockerfile container/agent-runner/src/ipc-mcp-stdio.ts
git commit -m "feat: wire X integration into container build

Copies social-monitor and x-integration skills into container.
Registers X tools for main-group agents."
```

---

### Task 16: Remove Old Playwright X Skill

**Files:**
- Delete: `.claude/skills/x-integration/host.ts`
- Delete: `.claude/skills/x-integration/agent.ts`
- Delete: `.claude/skills/x-integration/scripts/` (all files)
- Delete: `.claude/skills/x-integration/lib/browser.ts`
- Modify: `.claude/skills/x-integration/SKILL.md` (replace with redirect)
- Modify: `src/ipc.ts` (remove handleXIpc import and call if present)

- [ ] **Step 1: Remove old files**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
rm -f .claude/skills/x-integration/host.ts
rm -f .claude/skills/x-integration/agent.ts
rm -rf .claude/skills/x-integration/scripts/
rm -f .claude/skills/x-integration/lib/browser.ts
rmdir .claude/skills/x-integration/lib/ 2>/dev/null || true
```

- [ ] **Step 2: Update .claude/skills/x-integration/SKILL.md**

Replace the entire file content with:

```markdown
---
name: x-integration
description: X (Twitter) integration for NanoClaw. Post tweets, like, reply, retweet, and quote. Use for setup, testing, or troubleshooting X functionality. Triggers on "setup x", "x integration", "twitter", "post tweet", "tweet".
---

# X Integration (Redirected)

This skill has been migrated to a container-native implementation using the official X SDK (`@xdevplatform/xdk`).

The new implementation lives at:
- `container/skills/x-integration/` — MCP tools and SDK client
- `container/skills/social-monitor/` — Timeline monitoring framework

See `docs/superpowers/specs/2026-03-29-x-integration-design.md` for the full architecture.

## Setup

1. Connect X account via bearclaw-platform UI
2. Run `x_setup` tool to bootstrap persona
3. Timeline monitoring auto-schedules on first use
```

- [ ] **Step 3: Remove handleXIpc from src/ipc.ts if present**

Check if `handleXIpc` is imported in `src/ipc.ts`. If so, remove the import and the call in the default case. Revert the default case to:

```typescript
default:
  logger.warn({ type: data.type }, 'Unknown IPC task type');
```

- [ ] **Step 4: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
git add -A .claude/skills/x-integration/ src/ipc.ts
git commit -m "chore: remove old Playwright-based X integration

Replaced by container-native XDK implementation. Old browser
automation scripts, host IPC handler, and Chrome profile auth removed."
```

---

## Phase 4: bearclaw-platform Changes

### Task 17: OAuth Scope and Policy Rules Update

**Files:**
- Modify: `internal/service/social.go:174,240`
- Modify: `internal/integration/twitter_api.go:28-32`

- [ ] **Step 1: Update OAuth scopes in social.go**

At line 174, change the scope string:
```go
// From:
"scope": {"tweet.read tweet.write users.read offline.access"}
// To:
"scope": {"tweet.read tweet.write like.read like.write users.read offline.access"}
```

At line 240, update the scopes slice:
```go
// From:
scopes = []string{"tweet.read", "tweet.write", "users.read", "offline.access"}
// To:
scopes = []string{"tweet.read", "tweet.write", "like.read", "like.write", "users.read", "offline.access"}
```

- [ ] **Step 2: Add like/retweet policy rules in twitter_api.go**

Replace the PolicyRules at lines 28-32:
```go
PolicyRules: []PolicyRule{
    {Name: "twitter-read", PathPattern: "/2/*", Method: "GET", Action: "rate_limit", RateLimit: 2000, RateLimitWindow: "hour"},
    {Name: "twitter-write", PathPattern: "/2/tweets", Method: "POST", Action: "rate_limit", RateLimit: 10, RateLimitWindow: "hour"},
    {Name: "twitter-like", PathPattern: "/2/users/*/likes", Method: "POST", Action: "rate_limit", RateLimit: 50, RateLimitWindow: "hour"},
    {Name: "twitter-retweet", PathPattern: "/2/users/*/retweets", Method: "POST", Action: "rate_limit", RateLimit: 50, RateLimitWindow: "hour"},
    {Name: "twitter-delete", PathPattern: "/2/tweets/*", Method: "DELETE", Action: "rate_limit", RateLimit: 5, RateLimitWindow: "hour"},
},
```

- [ ] **Step 3: Run Go tests**

Run: `cd /Users/matthewholden/code/bearclaw/bearclaw-platform && go test ./internal/...`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add internal/service/social.go internal/integration/twitter_api.go
git commit -m "feat: add like.read/like.write scopes and engagement policy rules

Enables liking/retweeting via X API. Existing accounts need reconnect
to pick up new scopes."
```

---

### Task 18: Database Migration for Approval and Engagement Tables

**Files:**
- Create: `migrations/019_approval_engagement.sql`

- [ ] **Step 1: Write the migration**

```sql
-- migrations/019_approval_engagement.sql

CREATE TABLE IF NOT EXISTS pending_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    summary TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    expires_at TIMESTAMPTZ NOT NULL,
    responded_by TEXT,
    responded_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_approvals_instance_status
    ON pending_approvals(instance_id, status);

CREATE INDEX idx_pending_approvals_expires
    ON pending_approvals(expires_at)
    WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS engagement_actions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id UUID NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    action_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    target_url TEXT NOT NULL,
    target_author TEXT NOT NULL,
    target_content TEXT NOT NULL,
    content TEXT,
    approval_id UUID REFERENCES pending_approvals(id),
    status TEXT NOT NULL,
    triggered_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at TIMESTAMPTZ
);

CREATE INDEX idx_engagement_actions_instance
    ON engagement_actions(instance_id, created_at DESC);

CREATE INDEX idx_engagement_actions_platform
    ON engagement_actions(instance_id, platform, created_at DESC);
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add migrations/019_approval_engagement.sql
git commit -m "feat: add pending_approvals and engagement_actions tables

Migration 019: two new tables for HITL approval workflow and
engagement action tracking."
```

---

### Task 19: Models for Approval and Engagement

**Files:**
- Create: `internal/model/approval.go`
- Create: `internal/model/engagement.go`

- [ ] **Step 1: Write the approval model**

```go
// internal/model/approval.go
package model

import (
	"encoding/json"
	"time"
)

type ApprovalStatus string

const (
	ApprovalStatusPending  ApprovalStatus = "pending"
	ApprovalStatusApproved ApprovalStatus = "approved"
	ApprovalStatusRejected ApprovalStatus = "rejected"
	ApprovalStatusExpired  ApprovalStatus = "expired"
)

type PendingApproval struct {
	ID          string          `json:"id"`
	InstanceID  string          `json:"instance_id"`
	Category    string          `json:"category"`
	Action      string          `json:"action"`
	Summary     string          `json:"summary"`
	Details     json.RawMessage `json:"details"`
	Status      ApprovalStatus  `json:"status"`
	ExpiresAt   time.Time       `json:"expires_at"`
	RespondedBy *string         `json:"responded_by,omitempty"`
	RespondedAt *time.Time      `json:"responded_at,omitempty"`
	CreatedAt   time.Time       `json:"created_at"`
}
```

- [ ] **Step 2: Write the engagement model**

```go
// internal/model/engagement.go
package model

import "time"

type EngagementAction struct {
	ID            string     `json:"id"`
	InstanceID    string     `json:"instance_id"`
	Platform      string     `json:"platform"`
	ActionType    string     `json:"action_type"`
	TargetID      string     `json:"target_id"`
	TargetURL     string     `json:"target_url"`
	TargetAuthor  string     `json:"target_author"`
	TargetContent string     `json:"target_content"`
	Content       *string    `json:"content,omitempty"`
	ApprovalID    *string    `json:"approval_id,omitempty"`
	Status        string     `json:"status"`
	TriggeredBy   string     `json:"triggered_by"`
	CreatedAt     time.Time  `json:"created_at"`
	ExecutedAt    *time.Time `json:"executed_at,omitempty"`
}
```

- [ ] **Step 3: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add internal/model/approval.go internal/model/engagement.go
git commit -m "feat: add PendingApproval and EngagementAction models"
```

---

### Task 20: Approval Store and API Handler

**Files:**
- Create: `internal/store/approval.go`
- Create: `internal/api/handler/approval.go`
- Modify: `internal/api/router.go`

- [ ] **Step 1: Write the approval store**

```go
// internal/store/approval.go
package store

import (
	"context"
	"time"

	"github.com/bearclaw/bearclaw-platform/internal/model"
)

type ApprovalStore interface {
	CreateApproval(ctx context.Context, a *model.PendingApproval) error
	GetApproval(ctx context.Context, id string) (*model.PendingApproval, error)
	ListApprovalsByInstance(ctx context.Context, instanceID string, status *string) ([]model.PendingApproval, error)
	ResolveApproval(ctx context.Context, id string, approved bool, respondedBy string) error
	ExpireStaleApprovals(ctx context.Context, now time.Time) (int64, error)
}

var _ ApprovalStore = (*Store)(nil)

const approvalCols = `id, instance_id, category, action, summary, details,
	status, expires_at, responded_by, responded_at, created_at`

func scanApproval(row interface{ Scan(dest ...any) error }) (*model.PendingApproval, error) {
	var a model.PendingApproval
	err := row.Scan(
		&a.ID, &a.InstanceID, &a.Category, &a.Action, &a.Summary, &a.Details,
		&a.Status, &a.ExpiresAt, &a.RespondedBy, &a.RespondedAt, &a.CreatedAt,
	)
	return &a, err
}

func (s *Store) CreateApproval(ctx context.Context, a *model.PendingApproval) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO pending_approvals (id, instance_id, category, action, summary, details, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		a.ID, a.InstanceID, a.Category, a.Action, a.Summary, a.Details, a.ExpiresAt,
	)
	return err
}

func (s *Store) GetApproval(ctx context.Context, id string) (*model.PendingApproval, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT `+approvalCols+` FROM pending_approvals WHERE id = $1`, id)
	return scanApproval(row)
}

func (s *Store) ListApprovalsByInstance(ctx context.Context, instanceID string, status *string) ([]model.PendingApproval, error) {
	var rows interface{ Next() bool; Scan(dest ...any) error; Err() error }
	var err error
	if status != nil {
		rows, err = s.pool.Query(ctx,
			`SELECT `+approvalCols+` FROM pending_approvals WHERE instance_id = $1 AND status = $2 ORDER BY created_at DESC`,
			instanceID, *status)
	} else {
		rows, err = s.pool.Query(ctx,
			`SELECT `+approvalCols+` FROM pending_approvals WHERE instance_id = $1 ORDER BY created_at DESC`,
			instanceID)
	}
	if err != nil {
		return nil, err
	}
	var result []model.PendingApproval
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *a)
	}
	return result, rows.Err()
}

func (s *Store) ResolveApproval(ctx context.Context, id string, approved bool, respondedBy string) error {
	status := model.ApprovalStatusRejected
	if approved {
		status = model.ApprovalStatusApproved
	}
	_, err := s.pool.Exec(ctx, `
		UPDATE pending_approvals
		SET status = $1, responded_by = $2, responded_at = now()
		WHERE id = $3 AND status = 'pending'`,
		status, respondedBy, id,
	)
	return err
}

func (s *Store) ExpireStaleApprovals(ctx context.Context, now time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE pending_approvals
		SET status = 'expired'
		WHERE status = 'pending' AND expires_at <= $1`,
		now,
	)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
```

- [ ] **Step 2: Write the approval API handler**

```go
// internal/api/handler/approval.go
package handler

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/bearclaw/bearclaw-platform/internal/model"
)

type ApprovalStoreHandler interface {
	GetApproval(ctx context.Context, id string) (*model.PendingApproval, error)
	ListApprovalsByInstance(ctx context.Context, instanceID string, status *string) ([]model.PendingApproval, error)
	ResolveApproval(ctx context.Context, id string, approved bool, respondedBy string) error
}

type ApprovalHandler struct {
	instances InstanceGetter
	store     ApprovalStoreHandler
}

func NewApprovalHandler(instances InstanceGetter, store ApprovalStoreHandler) *ApprovalHandler {
	return &ApprovalHandler{instances: instances, store: store}
}

func (h *ApprovalHandler) List(w http.ResponseWriter, r *http.Request) {
	instanceID := checkOwnership(w, r, h.instances)
	if instanceID == "" {
		return
	}

	status := r.URL.Query().Get("status")
	var statusPtr *string
	if status != "" {
		statusPtr = &status
	}

	approvals, err := h.store.ListApprovalsByInstance(r.Context(), instanceID, statusPtr)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to list approvals")
		return
	}

	writeJSON(w, http.StatusOK, approvals)
}

func (h *ApprovalHandler) Get(w http.ResponseWriter, r *http.Request) {
	instanceID := checkOwnership(w, r, h.instances)
	if instanceID == "" {
		return
	}

	approvalID := r.PathValue("approvalId")
	approval, err := h.store.GetApproval(r.Context(), approvalID)
	if err != nil {
		writeError(w, http.StatusNotFound, "Approval not found")
		return
	}
	if approval.InstanceID != instanceID {
		writeError(w, http.StatusNotFound, "Approval not found")
		return
	}

	writeJSON(w, http.StatusOK, approval)
}

func (h *ApprovalHandler) Patch(w http.ResponseWriter, r *http.Request) {
	instanceID := checkOwnership(w, r, h.instances)
	if instanceID == "" {
		return
	}

	approvalID := r.PathValue("approvalId")

	var body struct {
		Approved bool `json:"approved"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Invalid request body")
		return
	}

	// Verify approval belongs to this instance
	approval, err := h.store.GetApproval(r.Context(), approvalID)
	if err != nil || approval.InstanceID != instanceID {
		writeError(w, http.StatusNotFound, "Approval not found")
		return
	}

	userID, _ := r.Context().Value("user_id").(string)
	respondedBy := "platform:" + userID

	if err := h.store.ResolveApproval(r.Context(), approvalID, body.Approved, respondedBy); err != nil {
		writeError(w, http.StatusInternalServerError, "Failed to resolve approval")
		return
	}

	// TODO: Send approval.respond WebSocket method to nanoclaw
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}
```

- [ ] **Step 3: Add routes to router.go**

Add after the schedule endpoints in `internal/api/router.go`:

```go
// Approval endpoints (require auth middleware).
mux.Handle("GET /api/v1/instances/{id}/approvals", requireAuth(http.HandlerFunc(approvals.List)))
mux.Handle("GET /api/v1/instances/{id}/approvals/{approvalId}", requireAuth(http.HandlerFunc(approvals.Get)))
mux.Handle("PATCH /api/v1/instances/{id}/approvals/{approvalId}", requireAuth(http.HandlerFunc(approvals.Patch)))
```

Wire the `approvals` handler in the constructor where other handlers are created.

- [ ] **Step 4: Run Go tests**

Run: `cd /Users/matthewholden/code/bearclaw/bearclaw-platform && go test ./internal/...`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add internal/store/approval.go internal/api/handler/approval.go internal/api/router.go
git commit -m "feat: add approval store, API handler, and routes

GET/PATCH /api/v1/instances/{id}/approvals for listing and
resolving pending approvals from the platform UI."
```

---

### Task 21: Engagement Store

**Files:**
- Create: `internal/store/engagement.go`

- [ ] **Step 1: Write the engagement store**

```go
// internal/store/engagement.go
package store

import (
	"context"

	"github.com/bearclaw/bearclaw-platform/internal/model"
)

type EngagementStore interface {
	CreateEngagementAction(ctx context.Context, a *model.EngagementAction) error
	CreateEngagementActions(ctx context.Context, actions []model.EngagementAction) error
	ListEngagementByInstance(ctx context.Context, instanceID string, limit int) ([]model.EngagementAction, error)
}

var _ EngagementStore = (*Store)(nil)

const engagementCols = `id, instance_id, platform, action_type, target_id,
	target_url, target_author, target_content, content, approval_id,
	status, triggered_by, created_at, executed_at`

func scanEngagement(row interface{ Scan(dest ...any) error }) (*model.EngagementAction, error) {
	var a model.EngagementAction
	err := row.Scan(
		&a.ID, &a.InstanceID, &a.Platform, &a.ActionType, &a.TargetID,
		&a.TargetURL, &a.TargetAuthor, &a.TargetContent, &a.Content, &a.ApprovalID,
		&a.Status, &a.TriggeredBy, &a.CreatedAt, &a.ExecutedAt,
	)
	return &a, err
}

func (s *Store) CreateEngagementAction(ctx context.Context, a *model.EngagementAction) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO engagement_actions
			(id, instance_id, platform, action_type, target_id, target_url,
			 target_author, target_content, content, approval_id, status,
			 triggered_by, executed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
		a.ID, a.InstanceID, a.Platform, a.ActionType, a.TargetID, a.TargetURL,
		a.TargetAuthor, a.TargetContent, a.Content, a.ApprovalID, a.Status,
		a.TriggeredBy, a.ExecutedAt,
	)
	return err
}

func (s *Store) CreateEngagementActions(ctx context.Context, actions []model.EngagementAction) error {
	for _, a := range actions {
		if err := s.CreateEngagementAction(ctx, &a); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) ListEngagementByInstance(ctx context.Context, instanceID string, limit int) ([]model.EngagementAction, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+engagementCols+` FROM engagement_actions
		 WHERE instance_id = $1
		 ORDER BY created_at DESC
		 LIMIT $2`,
		instanceID, limit,
	)
	if err != nil {
		return nil, err
	}
	var result []model.EngagementAction
	for rows.Next() {
		a, err := scanEngagement(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *a)
	}
	return result, rows.Err()
}
```

- [ ] **Step 2: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add internal/store/engagement.go
git commit -m "feat: add engagement actions store

CRUD for engagement_actions table. Supports batch insert for
sync from nanoclaw."
```

---

### Task 22: WebSocket Events for Engagement Sync and Approvals

**Files:**
- Modify: `internal/gateway/nc_protocol.go`
- Modify: `internal/gateway/manager.go`

- [ ] **Step 1: Add event constants and payload types to nc_protocol.go**

Add to the event constants block:

```go
// Engagement and approval events.
NCEventEngagementSync  = "engagement.sync"
NCEventApprovalCreated = "approval.created"
```

Add payload structs:

```go
type EngagementSyncPayload struct {
	Actions []EngagementSyncAction `json:"actions"`
}

type EngagementSyncAction struct {
	Platform      string  `json:"platform"`
	ActionType    string  `json:"actionType"`
	TargetID      string  `json:"targetId"`
	TargetURL     string  `json:"targetUrl"`
	TargetAuthor  string  `json:"targetAuthor"`
	TargetContent string  `json:"targetContent"`
	Content       *string `json:"content,omitempty"`
	Status        string  `json:"status"`
	TriggeredBy   string  `json:"triggeredBy"`
	ExecutedAt    *string `json:"executedAt,omitempty"`
}

type ApprovalCreatedPayload struct {
	ID        string `json:"id"`
	Category  string `json:"category"`
	Action    string `json:"action"`
	Summary   string `json:"summary"`
	ExpiresAt string `json:"expiresAt"`
}
```

- [ ] **Step 2: Add event handlers in manager.go**

In the `connectClient` method (or wherever event handlers are registered for a new client), add:

```go
client.OnEvent(NCEventEngagementSync, func(event NCEventFrame) {
	var payload EngagementSyncPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		m.logger.Error("failed to parse engagement.sync", "error", err)
		return
	}
	// Convert to model.EngagementAction and insert via store
	var actions []model.EngagementAction
	for _, a := range payload.Actions {
		actions = append(actions, model.EngagementAction{
			InstanceID:    instanceID,
			Platform:      a.Platform,
			ActionType:    a.ActionType,
			TargetID:      a.TargetID,
			TargetURL:     a.TargetURL,
			TargetAuthor:  a.TargetAuthor,
			TargetContent: a.TargetContent,
			Content:       a.Content,
			Status:        a.Status,
			TriggeredBy:   a.TriggeredBy,
		})
	}
	if err := m.engagementStore.CreateEngagementActions(context.Background(), actions); err != nil {
		m.logger.Error("failed to store engagement actions", "error", err)
	}
})

client.OnEvent(NCEventApprovalCreated, func(event NCEventFrame) {
	var payload ApprovalCreatedPayload
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		m.logger.Error("failed to parse approval.created", "error", err)
		return
	}
	// Store in platform's pending_approvals table
	if err := m.approvalStore.CreateApproval(context.Background(), &model.PendingApproval{
		ID:         payload.ID,
		InstanceID: instanceID,
		Category:   payload.Category,
		Action:     payload.Action,
		Summary:    payload.Summary,
	}); err != nil {
		m.logger.Error("failed to store approval", "error", err)
	}
})
```

Add `engagementStore EngagementStore` and `approvalStore ApprovalStore` to the Manager struct and constructor.

- [ ] **Step 3: Run Go tests**

Run: `cd /Users/matthewholden/code/bearclaw/bearclaw-platform && go test ./internal/...`
Expected: All PASS

- [ ] **Step 4: Commit**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
git add internal/gateway/nc_protocol.go internal/gateway/manager.go
git commit -m "feat: add engagement.sync and approval.created WebSocket events

Platform receives engagement actions and approval requests from
nanoclaw via WebSocket and stores in Postgres."
```

---

## Verification

### Task 23: End-to-End DRY_RUN Test

- [ ] **Step 1: Rebuild nanoclaw container**

```bash
cd /Users/matthewholden/code/bearclaw/nanoclaw
npm run build
./container/build.sh
```

- [ ] **Step 2: Create test persona file**

Write `groups/main/x-persona.md` with the example persona from the spec.

- [ ] **Step 3: Create test approval policy**

Write `groups/main/approval-policy.json`:
```json
{
  "defaults": { "mode": "confirm" },
  "actions": {
    "x_like": { "mode": "auto" },
    "x_retweet": { "mode": "auto" },
    "x_post": { "mode": "confirm" },
    "x_reply": { "mode": "confirm" },
    "x_quote": { "mode": "confirm" }
  },
  "notifyChannels": ["whatsapp"],
  "expiryMinutes": 60
}
```

- [ ] **Step 4: Test with X_DRY_RUN=true**

Send via WhatsApp to the main group:
```
@Assistant post a tweet: This is a test of the new X integration
```

Expected: Agent uses `x_post` tool → requests approval → approval notification sent to WhatsApp → reply YES → agent reports dry-run success.

- [ ] **Step 5: Run bearclaw-platform migration**

```bash
cd /Users/matthewholden/code/bearclaw/bearclaw-platform
# Run migration 019
make migrate
```

- [ ] **Step 6: Commit any fixes**

```bash
# In both repos, commit any fixes discovered during E2E testing
```
