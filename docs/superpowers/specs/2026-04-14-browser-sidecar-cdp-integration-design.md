# Browser Sidecar CDP Integration Design

**Date:** 2026-04-14
**Status:** Approved
**Scope:** Close the browser sidecar gap from the Apr 13 scope expansion — replace the v1 state-machine-only scaffolding with real CDP integration, dual-layer browser automation, and full profile persistence.

## Context

The Apr 13 scope expansion built the browser sidecar scaffolding:
- `src/browser/session-manager.ts` — state machine only, no real CDP connections
- `src/browser/profile-crypto.ts` — AES-256-GCM encryption, fully implemented
- `docker-compose.browser.yml` — Playwright sidecar on port 9222, not connected to anything

This design closes the gap: real CDP connections, agent-facing browser tools, trust integration, encrypted profile persistence, and visual monitoring.

## Architecture

Dual-layer browser automation. Both layers share the same Playwright sidecar and browser contexts.

```
Agent Container
├── Playwright MCP (MCP server, direct tool calls)
│   Zero extra LLM cost. For structured, known-site tasks.
│   Tools: browser_navigate, browser_snapshot, browser_click,
│          browser_type, browser_select_option, browser_file_upload, etc.
│
└── Stagehand IPC (natural language actions via orchestrator)
    1-3 LLM calls per action (Claude Haiku). For unknown sites, complex forms.
    Tools: browser_act, browser_extract, browser_observe

Both connect to:
  NanoClaw Orchestrator
  ├── BrowserSessionManager (generic-pool for context lifecycle)
  ├── Stagehand Bridge (wraps @browserbasehq/stagehand)
  ├── Profile Crypto (AES-256-GCM, key from OneCLI vault)
  └── Playwright Client → Docker Network → Browser Sidecar (Chromium on 9222)
```

### Why Dual-Layer

| Layer | When to Use | Cost | Reliability |
|-------|-------------|------|-------------|
| Playwright MCP | Known sites, predictable structure, step-by-step workflows | Zero extra LLM calls | High for standard HTML |
| Stagehand | Unknown sites, complex forms (custom dropdowns, date pickers), "figure it out" | 1-3 Haiku calls/action | High for dynamic UIs |

The agent chooses which layer to use per task. Both operate on the same browser context — an agent can navigate via Playwright MCP, then switch to Stagehand for a complex form, seamlessly.

## 1. Docker Network & Sidecar Management

### Network

Named Docker network `nanoclaw` connects sidecar and agent containers.

**New in `container-runtime.ts`:**

`ensureDockerNetwork(name: string)` — runs `docker network create nanoclaw`. Idempotent (ignores "already exists" error). Called at NanoClaw startup before any containers launch.

### Sidecar Lifecycle

**New in `container-runtime.ts`:**

`ensureBrowserSidecar()` — runs `docker compose -f docker-compose.browser.yml up -d`. Health-checks the CDP endpoint via TCP on port 9222.

**Startup sequence in `index.ts`:**
```
1. ensureContainerRuntimeRunning()     (existing)
2. ensureDockerNetwork("nanoclaw")     (new)
3. ensureBrowserSidecar()              (new)
4. cleanupOrphans()                    (existing)
```

**Shutdown:** `docker compose -f docker-compose.browser.yml down` on process exit.

**Crash recovery:** If sidecar crashes mid-session, BrowserSessionManager detects WebSocket disconnect, marks all contexts closed, emits `browser.sidecar.down`. Next browser request auto-restarts the sidecar.

### Container Runner Changes

**In `container-runner.ts`:**
- Add `--network nanoclaw` to `docker run` args for every agent container
- Pass `BROWSER_CDP_URL=ws://browser-sidecar:9222` as env var

### Docker Compose Changes

**`docker-compose.browser.yml`:**
- Bump `mem_limit: 512m` → `mem_limit: 1536m` (5 contexts × ~200-300MB each)
- Network config already references `nanoclaw` as external — no change needed

## 2. Playwright Client & Session Manager

### Dependencies

| Package | Location | Purpose |
|---------|----------|---------|
| `playwright-core` | Orchestrator | CDP connection to sidecar |
| `generic-pool` | Orchestrator | Context pooling, idle eviction |
| `@browserbasehq/stagehand` | Orchestrator | Natural language browser automation |
| `@playwright/mcp` | Agent container | MCP server for direct browser tools |
| `pixelmatch` | Orchestrator | Visual diff for monitoring |

### New File: `src/browser/playwright-client.ts`

Manages the WebSocket connection to the sidecar.

- Connects lazily to `ws://browser-sidecar:9222` on first browser request
- Single reconnect attempt on disconnect, then `browser.sidecar.down` event
- Exposes: `connect()`, `newContext(storageState?)`, `isConnected()`
- Thin wrapper — does not own context lifecycle (that's the pool's job)

### Rewrite: `src/browser/session-manager.ts`

Replaces v1 state-machine-only code with `generic-pool` managing real Playwright contexts.

**Pool configuration:**
```typescript
const contextPool = createPool<PlaywrightBrowserContext>({
  create: async () => playwrightClient.newContext(),
  destroy: async (ctx) => ctx.close(),
  validate: async (ctx) => ctx.isConnected(),
}, {
  max: BROWSER_MAX_CONTEXTS,          // default 5, env override
  min: 0,                             // no pre-warmed contexts
  idleTimeoutMillis: 600_000,         // 10min idle eviction
  acquireTimeoutMillis: 30_000,       // queue up to 30s for a slot
  evictionRunIntervalMillis: 60_000,  // check for idle every 60s
});
```

**Why `generic-pool`:** Battle-proven resource pooling (2M+ npm downloads/week, used by node-postgres, mysql2). Handles max size, idle eviction, acquire queuing, and resource validation. Replaces a custom resource manager that would have used unreliable `os.freemem()` polling.

**Memory management strategy:**
- Pool enforces max concurrent contexts (default 5)
- Docker `mem_limit` on the sidecar container caps total Chromium memory (1536MB)
- Idle eviction reclaims unused contexts after 10 minutes
- If pool is full, requests queue for up to 30s, then reject with clear error
- No custom memory polling — Docker cgroup and pool limits handle it

**Session manager methods:**

`acquireContext(groupId)`:
1. If group already has an active context, return it (reset idle timer)
2. If encrypted profile exists at `groups/{name}/browser/`, decrypt to temp dir
3. Acquire from pool with decrypted storage state
4. Track `groupId → context` mapping
5. Emit `browser.context.created`

`releaseContext(groupId)`:
1. Export storage state from Playwright context
2. Save to `groups/{name}/browser/state.json`
3. Encrypt profile dir, clean up temp dir
4. Release context back to pool
5. Emit `browser.context.closed`

`executeAction(groupId, action) → BrowserResult`:
1. acquireContext (get-or-create, resets idle timer)
2. Get or create page (max `BROWSER_MAX_PAGES` per context, default 2)
3. Execute action via Playwright
4. Return result

`shutdown()`:
1. Export + encrypt all active profiles
2. `contextPool.drain()` then `contextPool.clear()`

### Config Additions (`src/config.ts`)

```
BROWSER_CDP_URL          default ws://browser-sidecar:9222  (updated from host.docker.internal)
BROWSER_MAX_CONTEXTS     default 5   (up from 3)
BROWSER_MAX_PAGES        default 2   (new)
BROWSER_IDLE_TIMEOUT     default 600000  (10min, new)
BROWSER_ACQUIRE_TIMEOUT  default 30000   (30s queue, new)
```

## 3. Dual-Layer Browser Tools

### Layer 1: Playwright MCP (In-Container)

Runs as an MCP server inside each agent container. Claude interacts via standard tool calls — no IPC needed.

**Container setup:**
- `@playwright/mcp` installed in agent container image (`container/Dockerfile`)
- MCP server config in container's Claude configuration, pointing to `ws://browser-sidecar:9222`
- Claude receives tools: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_select_option`, `browser_file_upload`, `browser_tab_new`, `browser_tab_select`, `browser_take_screenshot`, `browser_press_key`, `browser_pdf_save`

**Context coordination:** The orchestrator owns context lifecycle. Two coordination modes:

1. **Orchestrator-managed (preferred):** When a container first needs a browser, it sends an IPC request to the orchestrator. The orchestrator creates a pooled context (with decrypted profile) and returns the CDP endpoint URL for that specific context. The Playwright MCP server in the container connects to that endpoint.

2. **Direct connection (fallback):** If the container's Playwright MCP connects directly to `ws://browser-sidecar:9222`, it creates its own context outside the pool. The orchestrator detects this via sidecar events and adopts the context into its tracking. Profile save/encrypt still happens on container exit via the orchestrator.

Mode 1 is preferred because it ensures profile decryption happens before the agent starts browsing. Mode 2 is the fallback for simplicity during early milestones.

### Layer 2: Stagehand (In Orchestrator, via IPC)

Runs in the orchestrator process. Agents request it via IPC for complex tasks.

**New file: `src/browser/stagehand-bridge.ts`**

```typescript
interface StagehandRequest {
  type: 'act' | 'extract' | 'observe';
  instruction: string;       // natural language
  schema?: ZodSchema;        // for extract — structured output
  contextId: string;         // which browser context to use
}

interface StagehandResponse {
  success: boolean;
  data?: unknown;             // extracted data, observation results
  action?: string;            // description of what was done
  error?: string;
}
```

- Wraps Stagehand, connecting it to the existing Playwright context from the pool
- Initializes Stagehand with `env: "LOCAL"` and passes the pool's Playwright `BrowserContext` — Stagehand operates on the existing context rather than creating its own browser. If Stagehand's API doesn't support injecting an external context directly, the bridge creates a thin adapter that routes Stagehand's internal Playwright calls to the pooled context.
- Uses Claude Haiku for element resolution (~$0.001 per action)
- Stagehand's `page` is the same Playwright `Page` from the pooled context — shared state with Playwright MCP

**Three IPC tools:**

| IPC Tool | Maps To | Trust | Use Case |
|----------|---------|-------|----------|
| `browser_act` | `stagehand.act(instruction)` | write (per-action) | "click the submit button", "select California from dropdown" |
| `browser_extract` | `stagehand.extract({ instruction, schema })` | read (session) | "get all product names and prices as JSON" |
| `browser_observe` | `stagehand.observe(instruction)` | read (session) | "what form fields are on this page?" |

### Shared Browser Context

Both layers operate on the same browser context:

```
Playwright Sidecar (Docker)
         │
  Browser Context (per group)
    ┌────┴────┐
    │         │
Playwright  Stagehand
MCP         (orchestrator)
(container)
    │         │
Same cookies, same localStorage,
same page state, same login session
```

An agent can navigate via Playwright MCP, then call `browser_act` via IPC for a complex form, seamlessly. Profile persistence captures state from both layers.

### Container Skill

New file: `container/skills/browser/SKILL.md`

Provides agent guidance on when to use each layer:
- Playwright MCP: known sites, predictable structure, cost-sensitive
- Stagehand IPC: unknown sites, complex UI components, "figure it out"

## 4. Trust Integration

Hybrid model: session-level grant for read actions, per-action trust for write actions. Intent-aware escalation for destructive browser actions.

### Tool Classification

New entries in `TOOL_CLASS_MAP` (`src/trust-engine.ts`):

```typescript
// Playwright MCP — reads (session-level grant)
browser_navigate:        'info.read',
browser_snapshot:        'info.read',
browser_take_screenshot: 'info.read',
browser_tab_list:        'info.read',
browser_tab_new:         'info.read',
browser_tab_select:      'info.read',
browser_pdf_save:        'info.read',

// Playwright MCP — writes (per-action trust)
browser_click:           'services.write',
browser_type:            'services.write',
browser_select_option:   'services.write',
browser_file_upload:     'services.write',
browser_press_key:       'services.write',

// Stagehand IPC — reads
browser_extract:         'info.read',
browser_observe:         'info.read',

// Stagehand IPC — writes
browser_act:             'services.write',
```

Unknown browser tools default to `services.transact` (highest risk) via existing `classifyTool()` fallback.

### Playwright MCP Trust Flow

Playwright MCP tools go through the existing trust gateway. The container's Claude Agent SDK calls `/trust/evaluate` before executing a tool. No changes to the gateway needed.

### Stagehand Trust Flow

Stagehand actions pass through the IPC handler, which calls the trust gateway before forwarding.

Stagehand actions carry natural language instructions, enabling richer intent validation:

```
Agent IPC: { tool: "browser_act", instruction: "click the delete account button" }
    │
    ├── 1. Classify: browser_act → services.write
    ├── 2. Intent scan: instruction contains "delete" → flag as destructive
    ├── 3. Trust gateway: /trust/evaluate with elevated classification
    │     └── Destructive match → services.transact (threshold 0.95)
    │     └── Normal match → services.write (threshold 0.80)
    ├── 4. Approved → forward to Stagehand
    └── 5. Denied → return rejection to agent
```

**Destructive intent patterns:**
```typescript
const DESTRUCTIVE_BROWSER_PATTERNS = [
  'delete', 'remove', 'cancel', 'unsubscribe',
  'transfer', 'send money', 'pay', 'purchase', 'buy',
  'submit order', 'confirm payment', 'place order',
];
```

### Session Trust State

```typescript
interface BrowserTrustState {
  readGranted: boolean;
  readGrantedAt: number;
  groupId: string;
}
```

- Read trust granted once per browser session, cached until context closes
- Write trust checked per action, never cached
- Session trust resets on context close (idle eviction or explicit)

### User Approval Flow

When trust is insufficient, the approval routes to the user's primary channel (Telegram):

```
🔒 Browser Action Approval

Group: work
Tool: browser_act
Instruction: "click the submit button on the payment form"
Site: https://vendor.com/checkout
Trust level: 0.65 (needs 0.80)

Reply: approve / deny
```

Approval timeout: 30 minutes (existing trust gateway default).

### Trust Graduation

As the user approves browser actions for a group, trust scores increase. Once `services.write` crosses 0.80, routine browser write actions auto-approve. Destructive actions require 0.95 — keeping the user in the loop for high-risk operations.

## 5. Profile Persistence & Encryption

### Storage Layout

```
groups/{name}/browser/
  state.json          # Playwright storageState (cookies, localStorage, origins)
  screenshots/        # Saved screenshots for visual monitoring
```

Only `state.json` is encrypted — it contains auth cookies and tokens. Screenshots are not encrypted.

### Encryption Key

Single master key for all groups, retrieved from OneCLI vault at startup:

```typescript
import { execSync } from 'child_process';

function getProfileKey(): Buffer {
  // wxa-secrets is a Python package — call via CLI from Node.js
  // Resolution order: env var BROWSER_PROFILE_KEY → macOS Keychain via wxa-secrets
  const envKey = process.env.BROWSER_PROFILE_KEY;
  if (envKey) return Buffer.from(envKey, 'hex');

  const raw = execSync('python3 -m wxa_secrets get BROWSER_PROFILE_KEY', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return Buffer.from(raw, 'hex');
}

const PROFILE_KEY = getProfileKey();
```

- If key doesn't exist on first run, `generateEncryptionKey()` creates one and stores it via `wxa_secrets set` automatically
- Key loaded once at startup, held in memory for process lifetime
- Falls back to `BROWSER_PROFILE_KEY` env var for CI/Docker environments without Keychain

### Lifecycle

**Context create:**
1. Check `groups/{name}/browser/state.json` exists
2. If yes: decrypt file with master key → temp file
3. Parse JSON → pass as `storageState` to Playwright `newContext()`
4. Delete temp file
5. Agent has all prior cookies/sessions

**Context close (explicit or idle eviction):**
1. `context.storageState()` → export cookies + localStorage
2. Write to `groups/{name}/browser/state.json` (plaintext, temp)
3. Encrypt file with master key → overwrites with ciphertext
4. Close Playwright context

**NanoClaw shutdown:**
1. `sessionManager.shutdown()` → exports + encrypts all active profiles
2. On next boot, all profiles are encrypted at rest

### Context Ownership

The orchestrator always owns context lifecycle. Playwright MCP in the container connects to a context the orchestrator has already created. The orchestrator creates (with decrypted profile), the orchestrator saves/encrypts on close.

### Edge Cases

- **Corrupted encrypted file:** Log error, start fresh context (no cookies), emit `browser.profile.corrupt` event, notify user
- **Missing key in vault:** Fatal startup error: "Run: wxa-secrets set BROWSER_PROFILE_KEY ..."
- **Profile from older key:** Decryption fails with auth tag mismatch, same as corruption handling

### Changes to `profile-crypto.ts`

The existing recursive `encryptProfile()`/`decryptProfile()` functions stay available. Add single-file convenience wrappers (`encryptFile()`, `decryptFile()` exported) since the primary path is just `state.json` (~10-50KB). Add key loading from OneCLI vault.

## 6. Visual Monitoring & Scheduled Checks

### Screenshot Diffing

**New file: `src/browser/visual-diff.ts`**

```typescript
interface DiffResult {
  changed: boolean;
  diffPercentage: number;    // 0-100
  threshold: number;         // the threshold used (default 5%)
  screenshotBefore: string;  // base64 PNG (stored)
  screenshotAfter: string;   // base64 PNG (current)
}
```

Uses `pixelmatch` (~50KB, zero deps, 3M downloads/week, used by Playwright itself for visual regression testing). Compares current screenshot against last stored screenshot in `groups/{name}/browser/screenshots/{label}.png`.

Threshold configurable per watch — "price changed" needs low threshold (~1%), "page layout redesign" needs higher (~15%).

### Scheduled Checks

No new scheduling infrastructure. Uses existing event router + task scheduler. A group's `events.json` gets browser watch rules:

```json
{
  "rules": [
    {
      "name": "hubspot-deal-alert",
      "schedule": "0 */2 * * *",
      "action": "spawn_task",
      "prompt": "Navigate to https://app.hubspot.com/deals, screenshot the pipeline view, compare with last screenshot. If deals moved stages, notify me."
    }
  ]
}
```

The task scheduler spawns an agent container, the agent uses browser tools, visual diff happens in the orchestrator.

### Network Interception

Playwright's built-in `page.route()` API. Exposed as an optional parameter on `browser_navigate`:

```json
{
  "tool": "browser_navigate",
  "args": {
    "url": "https://app.hubspot.com/deals",
    "interceptPatterns": ["**/api/deals*"],
    "captureResponses": true
  }
}
```

Returns intercepted API responses alongside the page result.

### Event Integration

When a visual diff detects a change above threshold:
1. Emit `browser.visual.changed` event to EventBus
2. Event router picks it up and routes per group rules
3. Daily digest includes browser watch results

Visual monitoring always uses the orchestrator's Stagehand/Playwright layer (not Playwright MCP in-container), since monitoring runs as background scheduled tasks.

## 7. Error Handling & Resilience

### Sidecar Crashes

- Playwright client detects WebSocket disconnect
- All active contexts marked `closed`, profiles saved from last known state
- `browser.sidecar.down` event emitted → event router can notify user
- Next browser request triggers `ensureBrowserSidecar()` auto-restart
- Agents get clean error: "Browser temporarily unavailable, retrying in 10s"
- One automatic retry after sidecar restart, then fail the action

### Context Corruption

- Playwright context becomes unresponsive (page crash, renderer OOM)
- `generic-pool` validation catches it (`ctx.isConnected()` returns false)
- Pool destroys bad context, creates fresh one
- Profile from last successful save is restored
- Worst case: agent loses in-progress form state

### Sidecar OOM

- Docker restarts sidecar container (`restart: unless-stopped`)
- Same flow as sidecar crash
- If OOM repeats, orchestrator logs warning with context count and suggests reducing `BROWSER_MAX_CONTEXTS`

### Network Partition

- Playwright MCP in container gets connection refused from sidecar
- Agent receives tool error, can fall back to non-browser approaches
- Orchestrator health check (every 60s) detects sidecar unreachable, emits event

### Stagehand LLM Failure

- Claude Haiku call fails during element resolution → Stagehand retries once internally
- On second failure, IPC returns error with suggestion: "Try using Playwright MCP tools directly with browser_snapshot for element refs"
- Agent can downgrade from Stagehand to Playwright MCP mid-task

### Profile Decryption Failure

- Corrupted `state.json` or wrong key → logged, fresh context created
- `browser.profile.corrupt` event emitted
- User notified: "Browser profile for {group} was corrupted. Starting fresh session."

## File Summary

### New Files

| File | Purpose | LOC Estimate |
|------|---------|-------------|
| `src/browser/playwright-client.ts` | CDP connection to sidecar | ~150 |
| `src/browser/stagehand-bridge.ts` | Stagehand wrapper + IPC handler | ~120 |
| `src/browser/visual-diff.ts` | Screenshot comparison via pixelmatch | ~80 |
| `container/skills/browser/SKILL.md` | Agent guidance for both layers | ~80 |

### Modified Files

| File | Changes |
|------|---------|
| `src/browser/session-manager.ts` | Rewrite: generic-pool + real Playwright contexts |
| `src/browser/profile-crypto.ts` | Add single-file wrappers, OneCLI key loading |
| `src/container-runtime.ts` | Add `ensureDockerNetwork()`, `ensureBrowserSidecar()` |
| `src/container-runner.ts` | Add `--network nanoclaw`, pass `BROWSER_CDP_URL` env |
| `src/trust-engine.ts` | Add browser tools to `TOOL_CLASS_MAP` |
| `src/ipc.ts` | Add 3 Stagehand IPC handlers with hybrid trust |
| `src/config.ts` | Update defaults, add new config vars |
| `src/index.ts` | Call network/sidecar setup at startup, shutdown on exit |
| `docker-compose.browser.yml` | Bump `mem_limit` to `1536m` |
| `container/Dockerfile` | Add `@playwright/mcp` |

### New Dependencies

| Package | Where | Size | Purpose |
|---------|-------|------|---------|
| `playwright-core` | Orchestrator | ~5MB | CDP client (no bundled browsers) |
| `generic-pool` | Orchestrator | ~30KB | Context pooling |
| `@browserbasehq/stagehand` | Orchestrator | ~varies | Natural language browser automation |
| `@playwright/mcp` | Agent container | ~varies | MCP server for direct browser tools |
| `pixelmatch` | Orchestrator | ~50KB | Visual diff |

## Milestones

### Milestone 1: Connectivity
- Docker network creation + sidecar management in `container-runtime.ts`
- Playwright client connecting to sidecar
- `generic-pool` replacing state-machine-only session manager
- Test: create/close browser contexts programmatically

### Milestone 2: Agent Access
- Playwright MCP installed in agent container + MCP config
- Stagehand bridge + 3 IPC tool handlers
- Trust engine entries for all browser tools
- Container runner: `--network nanoclaw` + `BROWSER_CDP_URL` env
- Container skill: `container/skills/browser/SKILL.md`
- Test: agent navigates a page and extracts content via both layers

### Milestone 3: Persistence & Security
- OneCLI key loading in profile-crypto
- Storage state export/encrypt on context close
- Storage state decrypt/restore on context create
- Context ownership: orchestrator creates, container connects
- Test: agent logs in, profile saved encrypted, next session resumes

### Milestone 4: Full Automation
- Visual diff via pixelmatch
- Network interception via `page.route()`
- Scheduled browser checks via event router
- Error handling: sidecar crash recovery, OOM, corruption
- Test: agent watches a page for changes and notifies

## Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| CDP client library | Playwright (via Stagehand + Playwright MCP) | Matches sidecar, TypeScript-native |
| Resource pooling | `generic-pool` | Battle-proven (2M+ downloads/week), zero deps |
| Memory management | Docker `mem_limit` + pool max | Reliable cgroup limits vs unreliable `os.freemem()` |
| Container networking | Shared Docker network `nanoclaw` | Portable, proper DNS, no host.docker.internal dependency |
| Encryption key | Single master key via OneCLI vault | Simple, consistent with existing credential pattern |
| Trust model | Hybrid: session-level read, per-action write | Balances speed (reads) and safety (writes) |
| Browser automation | Dual-layer (Playwright MCP + Stagehand) | Cost-efficient for known sites, autonomous for unknown |
| Visual diffing | `pixelmatch` | Used by Playwright itself, zero deps, 3M downloads/week |
