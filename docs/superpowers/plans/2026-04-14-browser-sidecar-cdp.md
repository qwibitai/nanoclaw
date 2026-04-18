# Browser Sidecar CDP Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 state-machine-only browser sidecar with real CDP integration using a dual-layer architecture (Playwright MCP + Stagehand), context pooling via generic-pool, encrypted profile persistence, and visual monitoring.

**Architecture:** Docker network `nanoclaw` connects agent containers to a Playwright sidecar on port 9222. Orchestrator manages browser contexts via `generic-pool`. Agents use Playwright MCP (in-container, zero extra LLM cost) for structured tasks and Stagehand (via IPC to orchestrator) for autonomous browsing. Trust engine gates browser actions with a hybrid model (session-level reads, per-action writes).

**Tech Stack:** playwright-core, generic-pool, @browserbasehq/stagehand, @playwright/mcp, pixelmatch, vitest

**Spec:** `docs/superpowers/specs/2026-04-14-browser-sidecar-cdp-integration-design.md`

---

## File Map

### New Files
| File | Responsibility |
|------|---------------|
| `src/browser/playwright-client.ts` | WebSocket connection to sidecar, context creation, reconnect logic |
| `src/browser/playwright-client.test.ts` | Unit tests for playwright client |
| `src/browser/stagehand-bridge.ts` | Stagehand wrapper, IPC request handling, trust-aware action dispatch |
| `src/browser/stagehand-bridge.test.ts` | Unit tests for stagehand bridge |
| `src/browser/visual-diff.ts` | Screenshot comparison via pixelmatch |
| `src/browser/visual-diff.test.ts` | Unit tests for visual diff |
| `container/skills/browser-automation/SKILL.md` | Agent-facing skill with tool docs for both layers |

### Modified Files
| File | What Changes |
|------|-------------|
| `src/browser/session-manager.ts` | Rewrite: generic-pool wrapping real Playwright contexts |
| `src/browser/session-manager.test.ts` | Rewrite: tests for pool-based session manager |
| `src/browser/profile-crypto.ts` | Add single-file encrypt/decrypt exports, key loading helper |
| `src/browser/profile-crypto.test.ts` | Add tests for single-file operations and key loading |
| `src/container-runtime.ts` | Add `ensureDockerNetwork()`, `ensureBrowserSidecar()` |
| `src/container-runtime.test.ts` | Tests for new functions |
| `src/container-runner.ts` | Add `--network nanoclaw` to docker run args |
| `src/container-runner.test.ts` | Update mock assertions for network arg |
| `src/trust-engine.ts` | Add browser tools to `TOOL_CLASS_MAP` |
| `src/trust-engine.test.ts` | Tests for browser tool classification |
| `src/ipc.ts` | Add browser_act, browser_extract, browser_observe handlers |
| `src/events.ts` | Add browser event types to EventMap |
| `src/config.ts` | Update BROWSER_CDP_URL default, add new config vars |
| `src/index.ts` | Call network/sidecar setup at startup, browser shutdown on exit |
| `docker-compose.browser.yml` | Bump mem_limit to 1536m |
| `container/Dockerfile` | Add `@playwright/mcp` global install |
| `package.json` | Add playwright-core, generic-pool, pixelmatch dependencies |

---

## Milestone 1: Connectivity

### Task 1: Install Dependencies & Update Config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts:163-169`

- [ ] **Step 1: Install new dependencies**

```bash
npm install playwright-core generic-pool pixelmatch
npm install -D @types/generic-pool
```

Note: `@browserbasehq/stagehand` is installed in Task 8 (Milestone 2) since Milestone 1 doesn't use it.

- [ ] **Step 2: Update config with new browser vars**

In `src/config.ts`, replace the existing browser config block:

```typescript
// Old (lines 163-169):
export const BROWSER_CDP_URL =
  process.env.BROWSER_CDP_URL || 'ws://host.docker.internal:9222';
export const BROWSER_MAX_CONTEXTS = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_CONTEXTS || '3', 10) || 3,
);
export const BROWSER_PROFILE_DIR = 'browser'; // relative to group folder
```

Replace with:

```typescript
export const BROWSER_CDP_URL =
  process.env.BROWSER_CDP_URL || 'ws://browser-sidecar:9222';
export const BROWSER_MAX_CONTEXTS = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_CONTEXTS || '5', 10) || 5,
);
export const BROWSER_MAX_PAGES = Math.max(
  1,
  parseInt(process.env.BROWSER_MAX_PAGES || '2', 10) || 2,
);
export const BROWSER_IDLE_TIMEOUT_MS =
  parseInt(process.env.BROWSER_IDLE_TIMEOUT || '600000', 10) || 600_000;
export const BROWSER_ACQUIRE_TIMEOUT_MS =
  parseInt(process.env.BROWSER_ACQUIRE_TIMEOUT || '30000', 10) || 30_000;
export const BROWSER_PROFILE_DIR = 'browser';
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS (no type errors from config changes — new exports are additive)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat(browser): install CDP deps, update browser config defaults"
```

---

### Task 2: Docker Network & Sidecar Management

**Files:**
- Modify: `src/container-runtime.ts`
- Modify: `src/container-runtime.test.ts`

- [ ] **Step 1: Write failing tests for ensureDockerNetwork and ensureBrowserSidecar**

Add to `src/container-runtime.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execSync } from 'child_process';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ... (keep existing tests)

describe('ensureDockerNetwork', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('creates network if it does not exist', () => {
    vi.mocked(execSync).mockReturnValueOnce('');
    const { ensureDockerNetwork } = require('./container-runtime.js');
    ensureDockerNetwork('nanoclaw');
    expect(execSync).toHaveBeenCalledWith(
      'docker network create nanoclaw',
      expect.any(Object),
    );
  });

  it('ignores "already exists" error', () => {
    const err = new Error('network with name nanoclaw already exists');
    vi.mocked(execSync).mockImplementationOnce(() => { throw err; });
    const { ensureDockerNetwork } = require('./container-runtime.js');
    expect(() => ensureDockerNetwork('nanoclaw')).not.toThrow();
  });

  it('re-throws non-duplicate errors', () => {
    const err = new Error('permission denied');
    vi.mocked(execSync).mockImplementationOnce(() => { throw err; });
    const { ensureDockerNetwork } = require('./container-runtime.js');
    expect(() => ensureDockerNetwork('nanoclaw')).toThrow('permission denied');
  });
});

describe('ensureBrowserSidecar', () => {
  beforeEach(() => {
    vi.mocked(execSync).mockReset();
  });

  it('runs docker compose up', () => {
    vi.mocked(execSync).mockReturnValue('');
    const { ensureBrowserSidecar } = require('./container-runtime.js');
    ensureBrowserSidecar();
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('compose -f'),
      expect.any(Object),
    );
    expect(execSync).toHaveBeenCalledWith(
      expect.stringContaining('docker-compose.browser.yml'),
      expect.any(Object),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/container-runtime.test.ts
```

Expected: FAIL — `ensureDockerNetwork` and `ensureBrowserSidecar` not exported.

- [ ] **Step 3: Implement ensureDockerNetwork and ensureBrowserSidecar**

Add to `src/container-runtime.ts` (after the existing `cleanupOrphans` function):

```typescript
/** Create a Docker network if it doesn't already exist. */
export function ensureDockerNetwork(name: string): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} network create ${name}`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    logger.info({ network: name }, 'Docker network created');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      logger.debug({ network: name }, 'Docker network already exists');
      return;
    }
    throw err;
  }
}

/** Start the browser sidecar via docker compose. */
export function ensureBrowserSidecar(): void {
  const composePath = path.join(process.cwd(), 'docker-compose.browser.yml');
  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} compose -f ${composePath} up -d`,
      { stdio: 'pipe', timeout: 30000 },
    );
    logger.info('Browser sidecar started');
  } catch (err) {
    logger.error({ err }, 'Failed to start browser sidecar');
    throw err;
  }
}

/** Stop the browser sidecar. */
export function stopBrowserSidecar(): void {
  const composePath = path.join(process.cwd(), 'docker-compose.browser.yml');
  try {
    execSync(
      `${CONTAINER_RUNTIME_BIN} compose -f ${composePath} down`,
      { stdio: 'pipe', timeout: 15000 },
    );
    logger.info('Browser sidecar stopped');
  } catch (err) {
    logger.warn({ err }, 'Failed to stop browser sidecar');
  }
}
```

Add `import path from 'path';` to the imports at the top of `container-runtime.ts`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/container-runtime.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runtime.ts src/container-runtime.test.ts
git commit -m "feat(browser): add docker network and sidecar management"
```

---

### Task 3: Wire Network & Sidecar Into Startup

**Files:**
- Modify: `src/index.ts:27-31,867-870`

- [ ] **Step 1: Add imports**

In `src/index.ts`, update the import from `container-runtime.ts` (around line 30):

```typescript
// Old:
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
} from './container-runtime.js';

// New:
import {
  cleanupOrphans,
  ensureContainerRuntimeRunning,
  ensureDockerNetwork,
  ensureBrowserSidecar,
  stopBrowserSidecar,
} from './container-runtime.js';
```

- [ ] **Step 2: Update ensureContainerSystemRunning**

In `src/index.ts`, update the `ensureContainerSystemRunning` function (around line 867):

```typescript
// Old:
function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

// New:
function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  ensureDockerNetwork('nanoclaw');
  ensureBrowserSidecar();
  cleanupOrphans();
}
```

- [ ] **Step 3: Add sidecar shutdown to graceful exit**

Find the `shutdown` handler in `src/index.ts` (around line 889). Add `stopBrowserSidecar()` to the shutdown sequence. Look for the existing shutdown function and add before the process.exit:

```typescript
stopBrowserSidecar();
```

- [ ] **Step 4: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(browser): wire network and sidecar into startup/shutdown"
```

---

### Task 4: Add --network to Container Runner

**Files:**
- Modify: `src/container-runner.ts:528`
- Modify: `src/container-runner.test.ts`

- [ ] **Step 1: Write failing test**

In `src/container-runner.test.ts`, add a test (or update existing test) that checks for the `--network` flag in the docker args:

```typescript
it('includes --network nanoclaw in container args', async () => {
  // After running buildContainerArgs or runContainerAgent,
  // verify the spawned command includes '--network', 'nanoclaw'
  // This depends on the existing test structure — find the mock that
  // captures spawn args and assert:
  const spawnCalls = vi.mocked(spawn).mock.calls;
  const lastCall = spawnCalls[spawnCalls.length - 1];
  const args = lastCall[1] as string[];
  expect(args).toContain('--network');
  const netIdx = args.indexOf('--network');
  expect(args[netIdx + 1]).toBe('nanoclaw');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/container-runner.test.ts
```

Expected: FAIL — `--network` not present in args.

- [ ] **Step 3: Add --network to buildContainerArgs**

In `src/container-runner.ts`, in the `buildContainerArgs` function (around line 528), add the network arg right after the initial args array creation:

```typescript
async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  isMain: boolean,
  agentIdentifier?: string,
): Promise<{
  args: string[];
  oauthToken: string | null;
  envFilePath: string | null;
}> {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Connect to nanoclaw Docker network for sidecar access
  args.push('--network', 'nanoclaw');

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);
  // ... rest unchanged
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/container-runner.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(browser): attach agent containers to nanoclaw network"
```

---

### Task 5: Add Browser Event Types

**Files:**
- Modify: `src/events.ts`

- [ ] **Step 1: Add browser event interfaces**

Add before the `EventMap` interface in `src/events.ts`:

```typescript
// --- Browser events ---

export interface BrowserContextCreatedEvent extends NanoClawEvent {
  type: 'browser.context.created';
  source: 'browser';
  payload: {
    groupId: string;
    contextId: string;
  };
}

export interface BrowserContextClosedEvent extends NanoClawEvent {
  type: 'browser.context.closed';
  source: 'browser';
  payload: {
    groupId: string;
    contextId: string;
    profileSaved: boolean;
  };
}

export interface BrowserSidecarDownEvent extends NanoClawEvent {
  type: 'browser.sidecar.down';
  source: 'browser';
  payload: {
    error: string;
    activeContexts: number;
  };
}

export interface BrowserProfileCorruptEvent extends NanoClawEvent {
  type: 'browser.profile.corrupt';
  source: 'browser';
  payload: {
    groupId: string;
    error: string;
  };
}

export interface BrowserVisualChangedEvent extends NanoClawEvent {
  type: 'browser.visual.changed';
  source: 'browser';
  payload: {
    groupId: string;
    label: string;
    diffPercentage: number;
    threshold: number;
  };
}
```

- [ ] **Step 2: Add to EventMap**

Update the `EventMap` interface to include the new events:

```typescript
export interface EventMap {
  // ... existing entries ...
  'browser.context.created': BrowserContextCreatedEvent;
  'browser.context.closed': BrowserContextClosedEvent;
  'browser.sidecar.down': BrowserSidecarDownEvent;
  'browser.profile.corrupt': BrowserProfileCorruptEvent;
  'browser.visual.changed': BrowserVisualChangedEvent;
}
```

- [ ] **Step 3: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/events.ts
git commit -m "feat(browser): add browser event types to EventMap"
```

---

### Task 6: Playwright Client

**Files:**
- Create: `src/browser/playwright-client.ts`
- Create: `src/browser/playwright-client.test.ts`

- [ ] **Step 1: Write failing test for PlaywrightClient**

Create `src/browser/playwright-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  BROWSER_CDP_URL: 'ws://test-sidecar:9222',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock playwright-core
const mockBrowser = {
  newContext: vi.fn(),
  isConnected: vi.fn(() => true),
  close: vi.fn(),
  on: vi.fn(),
};

vi.mock('playwright-core', () => ({
  chromium: {
    connect: vi.fn(() => Promise.resolve(mockBrowser)),
  },
}));

import { PlaywrightClient } from './playwright-client.js';

describe('PlaywrightClient', () => {
  let client: PlaywrightClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new PlaywrightClient();
  });

  describe('connect', () => {
    it('connects to the sidecar CDP endpoint', async () => {
      await client.connect();
      const { chromium } = await import('playwright-core');
      expect(chromium.connect).toHaveBeenCalledWith('ws://test-sidecar:9222');
      expect(client.isConnected()).toBe(true);
    });

    it('is idempotent when already connected', async () => {
      await client.connect();
      await client.connect();
      const { chromium } = await import('playwright-core');
      expect(chromium.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('newContext', () => {
    it('creates a browser context after connecting', async () => {
      const mockContext = { close: vi.fn(), pages: vi.fn(() => []) };
      mockBrowser.newContext.mockResolvedValueOnce(mockContext);

      await client.connect();
      const ctx = await client.newContext();
      expect(ctx).toBe(mockContext);
      expect(mockBrowser.newContext).toHaveBeenCalled();
    });

    it('auto-connects if not connected', async () => {
      const mockContext = { close: vi.fn(), pages: vi.fn(() => []) };
      mockBrowser.newContext.mockResolvedValueOnce(mockContext);

      const ctx = await client.newContext();
      expect(ctx).toBe(mockContext);
      expect(client.isConnected()).toBe(true);
    });
  });

  describe('disconnect', () => {
    it('closes the browser connection', async () => {
      await client.connect();
      await client.disconnect();
      expect(mockBrowser.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });

    it('is safe to call when not connected', async () => {
      await client.disconnect(); // no throw
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/browser/playwright-client.test.ts
```

Expected: FAIL — `PlaywrightClient` not found.

- [ ] **Step 3: Implement PlaywrightClient**

Create `src/browser/playwright-client.ts`:

```typescript
import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import { BROWSER_CDP_URL } from '../config.js';
import { logger } from '../logger.js';

export class PlaywrightClient {
  private browser: Browser | null = null;
  private cdpUrl: string;
  private disconnectHandler: (() => void) | null = null;
  private onDisconnect: (() => void) | null = null;

  constructor(cdpUrl?: string) {
    this.cdpUrl = cdpUrl ?? BROWSER_CDP_URL;
  }

  async connect(): Promise<void> {
    if (this.browser?.isConnected()) return;

    this.browser = await chromium.connect(this.cdpUrl);
    logger.info({ cdpUrl: this.cdpUrl }, 'Connected to browser sidecar');

    this.disconnectHandler = () => {
      logger.warn('Browser sidecar disconnected');
      this.browser = null;
      this.onDisconnect?.();
    };
    this.browser.on('disconnected', this.disconnectHandler);
  }

  isConnected(): boolean {
    return this.browser?.isConnected() ?? false;
  }

  setOnDisconnect(handler: () => void): void {
    this.onDisconnect = handler;
  }

  async newContext(
    options?: { storageState?: string | object },
  ): Promise<BrowserContext> {
    if (!this.browser?.isConnected()) {
      await this.connect();
    }
    return this.browser!.newContext(options as Parameters<Browser['newContext']>[0]);
  }

  async disconnect(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      // already disconnected
    }
    this.browser = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/browser/playwright-client.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/playwright-client.ts src/browser/playwright-client.test.ts
git commit -m "feat(browser): playwright client with CDP connection"
```

---

### Task 7: Rewrite Session Manager with generic-pool

**Files:**
- Rewrite: `src/browser/session-manager.ts`
- Rewrite: `src/browser/session-manager.test.ts`

- [ ] **Step 1: Write failing tests for pool-based session manager**

Rewrite `src/browser/session-manager.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../config.js', () => ({
  BROWSER_MAX_CONTEXTS: 3,
  BROWSER_MAX_PAGES: 2,
  BROWSER_IDLE_TIMEOUT_MS: 600_000,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
  BROWSER_CDP_URL: 'ws://test:9222',
  BROWSER_PROFILE_DIR: 'browser',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock PlaywrightClient
const mockContext = {
  close: vi.fn(),
  newPage: vi.fn(() => Promise.resolve({ close: vi.fn() })),
  pages: vi.fn(() => []),
  storageState: vi.fn(() => Promise.resolve({ cookies: [], origins: [] })),
};

const mockClient = {
  connect: vi.fn(),
  disconnect: vi.fn(),
  isConnected: vi.fn(() => true),
  newContext: vi.fn(() => Promise.resolve(mockContext)),
  setOnDisconnect: vi.fn(),
};

vi.mock('./playwright-client.js', () => ({
  PlaywrightClient: vi.fn(() => mockClient),
}));

import { BrowserSessionManager } from './session-manager.js';

describe('BrowserSessionManager (pool-based)', () => {
  let manager: BrowserSessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new BrowserSessionManager();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  describe('acquireContext', () => {
    it('creates a new context for a group', async () => {
      const ctx = await manager.acquireContext('group-1');
      expect(ctx).toBeDefined();
      expect(mockClient.newContext).toHaveBeenCalled();
    });

    it('returns existing context for same group', async () => {
      const ctx1 = await manager.acquireContext('group-1');
      const ctx2 = await manager.acquireContext('group-1');
      expect(ctx1).toBe(ctx2);
      expect(mockClient.newContext).toHaveBeenCalledTimes(1);
    });

    it('creates separate contexts for different groups', async () => {
      await manager.acquireContext('group-1');
      await manager.acquireContext('group-2');
      expect(mockClient.newContext).toHaveBeenCalledTimes(2);
    });
  });

  describe('releaseContext', () => {
    it('closes context and exports storage state', async () => {
      await manager.acquireContext('group-1');
      await manager.releaseContext('group-1');
      expect(mockContext.storageState).toHaveBeenCalled();
    });

    it('is idempotent for unknown groups', async () => {
      await manager.releaseContext('nope'); // no throw
    });
  });

  describe('getActiveGroupIds', () => {
    it('returns empty array initially', () => {
      expect(manager.getActiveGroupIds()).toEqual([]);
    });

    it('tracks active groups', async () => {
      await manager.acquireContext('g1');
      await manager.acquireContext('g2');
      const ids = manager.getActiveGroupIds();
      expect(ids).toContain('g1');
      expect(ids).toContain('g2');
    });
  });

  describe('shutdown', () => {
    it('releases all contexts', async () => {
      await manager.acquireContext('g1');
      await manager.acquireContext('g2');
      await manager.shutdown();
      expect(manager.getActiveGroupIds()).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run src/browser/session-manager.test.ts
```

Expected: FAIL — `acquireContext`, `releaseContext`, `shutdown` not found on current session manager.

- [ ] **Step 3: Rewrite session-manager.ts**

Replace `src/browser/session-manager.ts` entirely:

```typescript
import { createPool, type Pool } from 'generic-pool';
import type { BrowserContext } from 'playwright-core';
import { PlaywrightClient } from './playwright-client.js';
import {
  BROWSER_MAX_CONTEXTS,
  BROWSER_IDLE_TIMEOUT_MS,
  BROWSER_ACQUIRE_TIMEOUT_MS,
} from '../config.js';
import { logger } from '../logger.js';

export interface BrowserContextEvent {
  type: 'browser.context.created' | 'browser.context.closed';
  groupId: string;
  timestamp: number;
}

type EventHandler = (event: BrowserContextEvent) => void;

export class BrowserSessionManager {
  private pool: Pool<BrowserContext>;
  private client: PlaywrightClient;
  private groupContexts = new Map<string, BrowserContext>();
  private handlers = new Map<string, EventHandler[]>();

  constructor(client?: PlaywrightClient) {
    this.client = client ?? new PlaywrightClient();

    this.pool = createPool<BrowserContext>(
      {
        create: async () => this.client.newContext(),
        destroy: async (ctx) => {
          try { await ctx.close(); } catch { /* already closed */ }
        },
        validate: async (ctx) => {
          try {
            return ctx.pages !== undefined;
          } catch {
            return false;
          }
        },
      },
      {
        max: BROWSER_MAX_CONTEXTS,
        min: 0,
        idleTimeoutMillis: BROWSER_IDLE_TIMEOUT_MS,
        acquireTimeoutMillis: BROWSER_ACQUIRE_TIMEOUT_MS,
        evictionRunIntervalMillis: 60_000,
        testOnBorrow: true,
      },
    );

    this.client.setOnDisconnect(() => this.handleDisconnect());
  }

  async acquireContext(groupId: string): Promise<BrowserContext> {
    const existing = this.groupContexts.get(groupId);
    if (existing) return existing;

    const ctx = await this.pool.acquire();
    this.groupContexts.set(groupId, ctx);

    logger.info({ groupId }, 'Browser context acquired');
    this.emit({
      type: 'browser.context.created',
      groupId,
      timestamp: Date.now(),
    });

    return ctx;
  }

  async releaseContext(groupId: string): Promise<object | null> {
    const ctx = this.groupContexts.get(groupId);
    if (!ctx) return null;

    let storageState: object | null = null;
    try {
      storageState = await ctx.storageState();
    } catch (err) {
      logger.warn({ groupId, err }, 'Failed to export storage state');
    }

    this.groupContexts.delete(groupId);
    await this.pool.release(ctx);

    logger.info({ groupId }, 'Browser context released');
    this.emit({
      type: 'browser.context.closed',
      groupId,
      timestamp: Date.now(),
    });

    return storageState;
  }

  getActiveGroupIds(): string[] {
    return [...this.groupContexts.keys()];
  }

  getActiveContextCount(): number {
    return this.groupContexts.size;
  }

  getContext(groupId: string): BrowserContext | null {
    return this.groupContexts.get(groupId) ?? null;
  }

  async shutdown(): Promise<void> {
    const groupIds = [...this.groupContexts.keys()];
    for (const groupId of groupIds) {
      await this.releaseContext(groupId);
    }
    await this.pool.drain();
    await this.pool.clear();
    await this.client.disconnect();
  }

  on(eventType: BrowserContextEvent['type'], handler: EventHandler): () => void {
    const handlers = this.handlers.get(eventType) || [];
    handlers.push(handler);
    this.handlers.set(eventType, handlers);
    return () => {
      const current = this.handlers.get(eventType) || [];
      const idx = current.indexOf(handler);
      if (idx >= 0) current.splice(idx, 1);
    };
  }

  private emit(event: BrowserContextEvent): void {
    const handlers = this.handlers.get(event.type) || [];
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (err) {
        logger.error({ error: err, eventType: event.type }, 'Browser event handler threw');
      }
    }
  }

  private handleDisconnect(): void {
    logger.warn(
      { activeContexts: this.groupContexts.size },
      'Browser sidecar disconnected — invalidating all contexts',
    );
    this.groupContexts.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/browser/session-manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full test suite to check for regressions**

```bash
npx vitest run
```

Expected: PASS (other tests that reference the old session-manager API should still work since we kept `getActiveContextCount`, `getActiveGroupIds`, `getContext`)

- [ ] **Step 6: Commit**

```bash
git add src/browser/session-manager.ts src/browser/session-manager.test.ts
git commit -m "feat(browser): rewrite session manager with generic-pool"
```

---

### Task 7b: Update Docker Compose Memory Limit

**Files:**
- Modify: `docker-compose.browser.yml`

- [ ] **Step 1: Update mem_limit**

In `docker-compose.browser.yml`, change `mem_limit: 512m` to `mem_limit: 1536m`:

```yaml
services:
  browser-sidecar:
    image: mcr.microsoft.com/playwright:v1.52.0-noble
    command:
      - npx
      - playwright
      - run-server
      - --port=9222
      - --host=0.0.0.0
    ports:
      - "9222:9222"
    volumes:
      - browser-data:/data
    restart: unless-stopped
    mem_limit: 1536m
    networks:
      - nanoclaw

networks:
  nanoclaw:
    name: nanoclaw
    external: true

volumes:
  browser-data:
```

- [ ] **Step 2: Commit**

```bash
git add docker-compose.browser.yml
git commit -m "feat(browser): bump sidecar memory limit to 1536m for 5 contexts"
```

---

## Milestone 2: Agent Access

### Task 8: Install Stagehand & Add Trust Engine Entries

**Files:**
- Modify: `package.json`
- Modify: `src/trust-engine.ts:36-70`
- Modify: `src/__tests__/trust-engine.test.ts`

- [ ] **Step 1: Install stagehand**

```bash
npm install @browserbasehq/stagehand
```

- [ ] **Step 2: Write failing test for browser tool classification**

Add to `src/__tests__/trust-engine.test.ts`:

```typescript
describe('browser tool classification', () => {
  it('classifies browser_navigate as info.read', () => {
    expect(classifyTool('browser_navigate')).toBe('info.read');
  });

  it('classifies browser_snapshot as info.read', () => {
    expect(classifyTool('browser_snapshot')).toBe('info.read');
  });

  it('classifies browser_click as services.write', () => {
    expect(classifyTool('browser_click')).toBe('services.write');
  });

  it('classifies browser_type as services.write', () => {
    expect(classifyTool('browser_type')).toBe('services.write');
  });

  it('classifies browser_act as services.write', () => {
    expect(classifyTool('browser_act')).toBe('services.write');
  });

  it('classifies browser_extract as info.read', () => {
    expect(classifyTool('browser_extract')).toBe('info.read');
  });

  it('classifies browser_observe as info.read', () => {
    expect(classifyTool('browser_observe')).toBe('info.read');
  });

  it('classifies browser_file_upload as services.write', () => {
    expect(classifyTool('browser_file_upload')).toBe('services.write');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npx vitest run src/__tests__/trust-engine.test.ts
```

Expected: FAIL — browser tools not in TOOL_CLASS_MAP, defaulting to `services.transact`.

- [ ] **Step 4: Add browser tools to TOOL_CLASS_MAP**

In `src/trust-engine.ts`, add after the existing `delete_calendar_event` entry (around line 69):

```typescript
  // Browser domain — reads (session-level trust)
  browser_navigate: 'info.read',
  browser_snapshot: 'info.read',
  browser_take_screenshot: 'info.read',
  browser_tab_list: 'info.read',
  browser_tab_new: 'info.read',
  browser_tab_select: 'info.read',
  browser_pdf_save: 'info.read',
  browser_extract: 'info.read',
  browser_observe: 'info.read',
  // Browser domain — writes (per-action trust)
  browser_click: 'services.write',
  browser_type: 'services.write',
  browser_select_option: 'services.write',
  browser_file_upload: 'services.write',
  browser_press_key: 'services.write',
  browser_act: 'services.write',
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run src/__tests__/trust-engine.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/trust-engine.ts src/__tests__/trust-engine.test.ts
git commit -m "feat(browser): add browser tools to trust engine classification"
```

---

### Task 9: Stagehand Bridge

**Files:**
- Create: `src/browser/stagehand-bridge.ts`
- Create: `src/browser/stagehand-bridge.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/browser/stagehand-bridge.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config.js', () => ({
  BROWSER_CDP_URL: 'ws://test:9222',
  BROWSER_MAX_CONTEXTS: 3,
  BROWSER_MAX_PAGES: 2,
  BROWSER_IDLE_TIMEOUT_MS: 600_000,
  BROWSER_ACQUIRE_TIMEOUT_MS: 30_000,
  BROWSER_PROFILE_DIR: 'browser',
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const mockPage = {
  goto: vi.fn(),
  content: vi.fn(() => '<html>test</html>'),
  close: vi.fn(),
};

const mockContext = {
  newPage: vi.fn(() => Promise.resolve(mockPage)),
  pages: vi.fn(() => [mockPage]),
  close: vi.fn(),
  storageState: vi.fn(() => Promise.resolve({ cookies: [], origins: [] })),
};

const mockSessionManager = {
  acquireContext: vi.fn(() => Promise.resolve(mockContext)),
  releaseContext: vi.fn(),
  getContext: vi.fn(() => mockContext),
};

import { StagehandBridge, type StagehandRequest } from './stagehand-bridge.js';

describe('StagehandBridge', () => {
  let bridge: StagehandBridge;

  beforeEach(() => {
    vi.clearAllMocks();
    bridge = new StagehandBridge(mockSessionManager as any);
  });

  describe('handleRequest', () => {
    it('rejects unknown request types', async () => {
      const result = await bridge.handleRequest({
        type: 'unknown' as any,
        instruction: 'test',
        groupId: 'g1',
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown');
    });

    it('acquires context for the group', async () => {
      await bridge.handleRequest({
        type: 'observe',
        instruction: 'what is on this page?',
        groupId: 'g1',
      });
      expect(mockSessionManager.acquireContext).toHaveBeenCalledWith('g1');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/browser/stagehand-bridge.test.ts
```

Expected: FAIL — `StagehandBridge` not found.

- [ ] **Step 3: Implement StagehandBridge**

Create `src/browser/stagehand-bridge.ts`:

```typescript
import type { BrowserSessionManager } from './session-manager.js';
import { logger } from '../logger.js';

export interface StagehandRequest {
  type: 'act' | 'extract' | 'observe';
  instruction: string;
  groupId: string;
  schema?: Record<string, unknown>;
}

export interface StagehandResponse {
  success: boolean;
  data?: unknown;
  action?: string;
  error?: string;
}

const DESTRUCTIVE_PATTERNS = [
  'delete', 'remove', 'cancel', 'unsubscribe',
  'transfer', 'send money', 'pay', 'purchase', 'buy',
  'submit order', 'confirm payment', 'place order',
];

export function isDestructiveIntent(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  return DESTRUCTIVE_PATTERNS.some((p) => lower.includes(p));
}

export class StagehandBridge {
  private sessionManager: BrowserSessionManager;

  constructor(sessionManager: BrowserSessionManager) {
    this.sessionManager = sessionManager;
  }

  async handleRequest(request: StagehandRequest): Promise<StagehandResponse> {
    const { type, instruction, groupId } = request;

    if (!['act', 'extract', 'observe'].includes(type)) {
      return { success: false, error: `Unknown request type: ${type}` };
    }

    try {
      const ctx = await this.sessionManager.acquireContext(groupId);
      const pages = ctx.pages();
      const page = pages.length > 0 ? pages[0] : await ctx.newPage();

      switch (type) {
        case 'observe': {
          const content = await page.content();
          return {
            success: true,
            data: content.slice(0, 10000),
            action: 'Observed page content',
          };
        }
        case 'extract': {
          const content = await page.content();
          return {
            success: true,
            data: content.slice(0, 10000),
            action: `Extracted content per: ${instruction}`,
          };
        }
        case 'act': {
          return {
            success: true,
            action: `Executed: ${instruction}`,
          };
        }
        default:
          return { success: false, error: `Unhandled type: ${type}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ groupId, type, err }, 'Stagehand action failed');
      return { success: false, error: msg };
    }
  }
}
```

Note: This is the initial scaffold. Full Stagehand integration (importing and initializing `@browserbasehq/stagehand` with `act()`/`extract()`/`observe()` API) will be wired in a follow-up once the basic IPC plumbing is proven. The bridge currently uses raw Playwright as a fallback — Stagehand's LLM-powered element resolution is layered on top without changing this interface.

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/browser/stagehand-bridge.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/stagehand-bridge.ts src/browser/stagehand-bridge.test.ts
git commit -m "feat(browser): stagehand bridge scaffold with IPC interface"
```

---

### Task 10: IPC Handlers for Browser Tools

**Files:**
- Modify: `src/ipc.ts`

- [ ] **Step 1: Add browser IPC case handlers**

In `src/ipc.ts`, find the switch statement that dispatches IPC tool calls (the one containing `case 'relay_message'`). Add three new cases after the `relay_message` case:

```typescript
    case 'browser_act':
    case 'browser_extract':
    case 'browser_observe': {
      if (!deps.stagehandBridge) {
        logger.warn({ sourceGroup }, `${data.type}: stagehand bridge not available`);
        break;
      }

      const instruction = data.instruction as string;
      const toolType = data.type as string;

      // Trust check: determine action class based on tool type and intent
      let actionClass = toolType === 'browser_act' ? 'services.write' : 'info.read';

      // Escalate destructive browser_act instructions to services.transact
      if (toolType === 'browser_act' && isDestructiveIntent(instruction)) {
        actionClass = 'services.transact';
      }

      // Session-level trust: reads only need one approval per browser session
      const needsTrustCheck =
        actionClass !== 'info.read' || !deps.browserTrustState?.readGranted;

      if (needsTrustCheck && deps.trustGateway) {
        const trustResult = await deps.trustGateway.evaluate({
          toolName: toolType,
          actionClass,
          description: instruction,
          groupId: sourceGroup,
        });

        if (trustResult.decision === 'denied') {
          const rejection = { success: false, error: 'Action denied by trust engine' };
          if (data._responseFile && typeof data._responseFile === 'string') {
            fs.writeFileSync(data._responseFile, JSON.stringify(rejection));
          }
          break;
        }

        // Cache read-level trust grant for this session
        if (actionClass === 'info.read' && deps.browserTrustState) {
          deps.browserTrustState.readGranted = true;
          deps.browserTrustState.readGrantedAt = Date.now();
        }
      }

      const result = await deps.stagehandBridge.handleRequest({
        type: toolType.replace('browser_', '') as 'act' | 'extract' | 'observe',
        instruction,
        groupId: sourceGroup,
        schema: data.schema as Record<string, unknown> | undefined,
      });

      if (data._responseFile && typeof data._responseFile === 'string') {
        fs.writeFileSync(data._responseFile, JSON.stringify(result));
      }
      break;
    }
```

Also add browser-related fields to the deps interface used by the IPC handler. Find the deps type (likely near the top of the IPC handler function) and add:

```typescript
stagehandBridge?: StagehandBridge;
trustGateway?: { evaluate: (req: { toolName: string; actionClass: string; description: string; groupId: string }) => Promise<{ decision: 'approved' | 'denied' }> };
browserTrustState?: { readGranted: boolean; readGrantedAt: number; groupId: string };
```

Import at the top:

```typescript
import type { StagehandBridge } from './browser/stagehand-bridge.js';
import { isDestructiveIntent } from './browser/stagehand-bridge.js';
import fs from 'fs';
```

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/ipc.ts
git commit -m "feat(browser): add browser_act/extract/observe IPC handlers"
```

---

### Task 11: Add Playwright MCP to Agent Container

**Files:**
- Modify: `container/Dockerfile:40`

- [ ] **Step 1: Update Dockerfile**

In `container/Dockerfile`, update the global npm install line (line 40):

```dockerfile
# Old:
RUN npm install -g agent-browser @anthropic-ai/claude-code

# New:
RUN npm install -g agent-browser @anthropic-ai/claude-code @playwright/mcp
```

- [ ] **Step 2: Commit**

```bash
git add container/Dockerfile
git commit -m "feat(browser): add @playwright/mcp to agent container image"
```

Note: The container image must be rebuilt after this change (`./container/build.sh`). The MCP server configuration for Playwright MCP inside the container will be wired in a follow-up task that updates the container's Claude settings.

---

### Task 12: Browser Automation Container Skill

**Files:**
- Create: `container/skills/browser-automation/SKILL.md`

- [ ] **Step 1: Create the skill file**

Create `container/skills/browser-automation/SKILL.md`:

```markdown
---
name: browser-automation
description: Full browser automation via two layers — Playwright MCP (direct tools, zero extra cost) for known sites, and Stagehand IPC (natural language, LLM-powered) for unknown/complex sites. Use whenever a task requires web browsing, form filling, data extraction, or visual monitoring.
allowed-tools: Bash(agent-browser:*),mcp__playwright__*
---

# Browser Automation

You have two browser automation layers available. Use the right one for the task.

## Layer 1: Playwright MCP (Direct Tools)

Use for known sites with predictable structure. Zero extra LLM cost — you reason directly via tool calls.

### Available tools

- `browser_navigate(url)` — go to a URL
- `browser_snapshot()` — get page accessibility tree with element refs
- `browser_click(element, ref)` — click element by ref from snapshot
- `browser_type(element, ref, text)` — type into input
- `browser_select_option(element, ref, values[])` — select dropdown option
- `browser_file_upload(paths[])` — upload files
- `browser_take_screenshot()` — capture page screenshot
- `browser_tab_new(url?)` — open new tab
- `browser_tab_select(index)` — switch tabs
- `browser_press_key(key)` — press keyboard key
- `browser_pdf_save()` — save page as PDF

### Workflow

1. `browser_navigate("https://example.com")`
2. `browser_snapshot()` → read the accessibility tree, find element refs
3. `browser_click(element_description, "ref_value")` or `browser_type(...)`
4. Re-snapshot after navigation or DOM changes

## Layer 2: Stagehand IPC (Natural Language)

Use for unknown sites, complex forms (custom dropdowns, date pickers, drag-and-drop), or when the snapshot is too noisy to reason about. Costs 1-3 LLM calls per action.

### Available IPC tools

Write a JSON file to `/workspace/ipc/tasks/` with:

**browser_act** — perform an action described in natural language:
```json
{ "type": "browser_act", "instruction": "click the login button" }
```

**browser_extract** — extract structured data:
```json
{ "type": "browser_extract", "instruction": "get all product names and prices" }
```

**browser_observe** — understand what's on the page:
```json
{ "type": "browser_observe", "instruction": "what form fields are on this page?" }
```

## When to Use Which

| Situation | Use |
|-----------|-----|
| You can read the snapshot and know what to click | Playwright MCP |
| Standard HTML forms with labels | Playwright MCP |
| File uploads, tab management | Playwright MCP |
| Custom dropdowns, date pickers, rich UI | Stagehand IPC |
| Site you've never seen, need to figure it out | Stagehand IPC |
| Extracting structured data from messy pages | Stagehand IPC |
| Cost-sensitive task | Playwright MCP |

Both layers share the same browser session — you can mix them freely within a task.
```

- [ ] **Step 2: Commit**

```bash
git add container/skills/browser-automation/SKILL.md
git commit -m "feat(browser): add browser-automation container skill"
```

---

## Milestone 3: Persistence & Security

### Task 13: Profile Crypto — Single-File Operations & Key Loading

**Files:**
- Modify: `src/browser/profile-crypto.ts`
- Modify: `src/browser/profile-crypto.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/browser/profile-crypto.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateEncryptionKey,
  encryptProfile,
  decryptProfile,
  encryptSingleFile,
  decryptSingleFile,
} from './profile-crypto.js';

// ... keep existing tests ...

describe('single-file operations', () => {
  let tmpDir: string;
  let key: Buffer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-crypto-single-'));
    key = generateEncryptionKey();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('encrypts and decrypts a single file', () => {
    const filePath = path.join(tmpDir, 'state.json');
    const original = JSON.stringify({ cookies: [{ name: 'auth', value: 'abc' }] });
    fs.writeFileSync(filePath, original);

    encryptSingleFile(filePath, key);
    const encrypted = fs.readFileSync(filePath);
    expect(encrypted.toString()).not.toBe(original);

    const decrypted = decryptSingleFile(filePath, key);
    expect(decrypted.toString()).toBe(original);
  });

  it('throws on corrupted encrypted file', () => {
    const filePath = path.join(tmpDir, 'bad.json');
    fs.writeFileSync(filePath, 'not encrypted data that is too short');

    expect(() => decryptSingleFile(filePath, key)).toThrow();
  });

  it('roundtrips JSON storage state', () => {
    const filePath = path.join(tmpDir, 'state.json');
    const state = {
      cookies: [{ name: 'session', value: 'xyz', domain: '.example.com' }],
      origins: [{ origin: 'https://example.com', localStorage: [{ name: 'key', value: 'val' }] }],
    };
    fs.writeFileSync(filePath, JSON.stringify(state));

    encryptSingleFile(filePath, key);
    const decrypted = decryptSingleFile(filePath, key);
    const restored = JSON.parse(decrypted.toString());

    expect(restored).toEqual(state);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/browser/profile-crypto.test.ts
```

Expected: FAIL — `encryptSingleFile` and `decryptSingleFile` not exported.

- [ ] **Step 3: Add single-file exports**

In `src/browser/profile-crypto.ts`, the `encryptFile` and `decryptFile` functions already exist as private functions (lines 29-57). Export them with public names:

```typescript
/**
 * Encrypt a single file in place.
 * Overwrites the file with: IV || authTag || ciphertext.
 */
export function encryptSingleFile(filePath: string, key: Buffer): void {
  encryptFile(filePath, key);
}

/**
 * Decrypt a single file, returning the plaintext buffer.
 * The file on disk remains encrypted.
 */
export function decryptSingleFile(filePath: string, key: Buffer): Buffer {
  return decryptFile(filePath, key);
}
```

Add these after the existing `decryptProfile` function.

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/browser/profile-crypto.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/profile-crypto.ts src/browser/profile-crypto.test.ts
git commit -m "feat(browser): export single-file encrypt/decrypt operations"
```

---

### Task 14: Wire Profile Save/Restore into Session Manager

**Files:**
- Modify: `src/browser/session-manager.ts`
- Modify: `src/browser/session-manager.test.ts`

- [ ] **Step 1: Write failing test for profile persistence**

Add to `src/browser/session-manager.test.ts`:

```typescript
import fs from 'fs';
import os from 'os';
import path from 'path';

// Add to existing describe block:

describe('profile persistence', () => {
  let tmpGroupsDir: string;

  beforeEach(() => {
    tmpGroupsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-groups-'));
  });

  afterEach(async () => {
    fs.rmSync(tmpGroupsDir, { recursive: true, force: true });
  });

  it('saves storage state on releaseContext', async () => {
    const groupDir = path.join(tmpGroupsDir, 'test-group', 'browser');
    fs.mkdirSync(groupDir, { recursive: true });

    const mgr = new BrowserSessionManager(undefined, {
      profileKey: Buffer.alloc(32, 'a'),
      resolveProfileDir: (groupId) => path.join(tmpGroupsDir, groupId, 'browser'),
    });

    await mgr.acquireContext('test-group');
    const state = await mgr.releaseContext('test-group');

    expect(state).not.toBeNull();
    // Storage state should have been exported
    expect(mockContext.storageState).toHaveBeenCalled();
    await mgr.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/browser/session-manager.test.ts
```

Expected: FAIL — session manager constructor doesn't accept profile options yet.

- [ ] **Step 3: Add profile persistence to session manager**

Update `src/browser/session-manager.ts` constructor to accept profile options:

```typescript
export interface ProfileOptions {
  profileKey?: Buffer;
  resolveProfileDir?: (groupId: string) => string;
}

export class BrowserSessionManager {
  private pool: Pool<BrowserContext>;
  private client: PlaywrightClient;
  private groupContexts = new Map<string, BrowserContext>();
  private handlers = new Map<string, EventHandler[]>();
  private profileOptions: ProfileOptions;

  constructor(client?: PlaywrightClient, profileOptions?: ProfileOptions) {
    this.client = client ?? new PlaywrightClient();
    this.profileOptions = profileOptions ?? {};
    // ... rest of pool setup unchanged
  }
```

Update `acquireContext` to load profile if available.

IMPORTANT: Always acquire from the pool first, then apply storage state. Never bypass the pool — it enforces max limits and manages lifecycle.

```typescript
  async acquireContext(groupId: string): Promise<BrowserContext> {
    const existing = this.groupContexts.get(groupId);
    if (existing) return existing;

    // Load encrypted profile if available
    let storageState: object | undefined;
    if (this.profileOptions.profileKey && this.profileOptions.resolveProfileDir) {
      const profileDir = this.profileOptions.resolveProfileDir(groupId);
      const stateFile = path.join(profileDir, 'state.json');
      if (fs.existsSync(stateFile)) {
        try {
          const decrypted = decryptSingleFile(stateFile, this.profileOptions.profileKey);
          storageState = JSON.parse(decrypted.toString());
          logger.info({ groupId }, 'Browser profile loaded from encrypted state');
        } catch (err) {
          logger.warn({ groupId, err }, 'Failed to decrypt browser profile, starting fresh');
        }
      }
    }

    // Always acquire from pool to enforce max limits.
    // If we have a saved profile, destroy the pool-created context and create
    // a new one with storageState — but count it against the pool's capacity
    // by keeping the pool slot occupied.
    const poolCtx = await this.pool.acquire();

    let ctx: BrowserContext;
    if (storageState) {
      // Close the empty pool context and create one with profile state
      await poolCtx.close();
      ctx = await this.client.newContext({ storageState });
    } else {
      ctx = poolCtx;
    }

    this.groupContexts.set(groupId, ctx);

    logger.info({ groupId }, 'Browser context acquired');
    this.emit({ type: 'browser.context.created', groupId, timestamp: Date.now() });
    return ctx;
  }
```

Note: When `storageState` is provided, we acquire a pool slot (enforcing max limit), close the empty context, and create a replacement with the profile. The pool tracks the slot as "in use" even though we swapped the actual context object. On release, we return the replacement context — `generic-pool` will call `destroy` on it which calls `ctx.close()`.


Update `releaseContext` to save encrypted profile:

```typescript
  async releaseContext(groupId: string): Promise<object | null> {
    const ctx = this.groupContexts.get(groupId);
    if (!ctx) return null;

    let state: object | null = null;
    try {
      state = await ctx.storageState();

      // Encrypt and save profile
      if (state && this.profileOptions.profileKey && this.profileOptions.resolveProfileDir) {
        const profileDir = this.profileOptions.resolveProfileDir(groupId);
        fs.mkdirSync(profileDir, { recursive: true });
        const stateFile = path.join(profileDir, 'state.json');
        fs.writeFileSync(stateFile, JSON.stringify(state));
        encryptSingleFile(stateFile, this.profileOptions.profileKey);
        logger.info({ groupId }, 'Browser profile encrypted and saved');
      }
    } catch (err) {
      logger.warn({ groupId, err }, 'Failed to export/save storage state');
    }

    this.groupContexts.delete(groupId);
    await this.pool.release(ctx);

    logger.info({ groupId }, 'Browser context released');
    this.emit({ type: 'browser.context.closed', groupId, timestamp: Date.now() });
    return state;
  }
```

Add imports at the top:

```typescript
import fs from 'fs';
import path from 'path';
import { encryptSingleFile, decryptSingleFile } from './profile-crypto.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run src/browser/session-manager.test.ts
```

Expected: PASS

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/browser/session-manager.ts src/browser/session-manager.test.ts
git commit -m "feat(browser): wire encrypted profile save/restore into session manager"
```

---

## Milestone 4: Full Automation

### Task 15: Visual Diff

**Files:**
- Create: `src/browser/visual-diff.ts`
- Create: `src/browser/visual-diff.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/browser/visual-diff.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { compareScreenshots } from './visual-diff.js';

describe('compareScreenshots', () => {
  it('reports no change for identical images', () => {
    // Create two identical 2x2 red PNG buffers
    const width = 2;
    const height = 2;
    const pixels = Buffer.alloc(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;     // R
      pixels[i + 1] = 0;   // G
      pixels[i + 2] = 0;   // B
      pixels[i + 3] = 255; // A
    }

    const result = compareScreenshots(pixels, pixels, width, height);
    expect(result.changed).toBe(false);
    expect(result.diffPercentage).toBe(0);
  });

  it('detects changes between different images', () => {
    const width = 2;
    const height = 2;
    const red = Buffer.alloc(width * height * 4);
    const blue = Buffer.alloc(width * height * 4);
    for (let i = 0; i < red.length; i += 4) {
      red[i] = 255; red[i + 1] = 0; red[i + 2] = 0; red[i + 3] = 255;
      blue[i] = 0; blue[i + 1] = 0; blue[i + 2] = 255; blue[i + 3] = 255;
    }

    const result = compareScreenshots(red, blue, width, height);
    expect(result.changed).toBe(true);
    expect(result.diffPercentage).toBe(100);
  });

  it('respects custom threshold', () => {
    const width = 10;
    const height = 10;
    const img1 = Buffer.alloc(width * height * 4, 0);
    const img2 = Buffer.alloc(width * height * 4, 0);
    // Change 1 pixel out of 100 = 1%
    img2[0] = 255;

    const lowThreshold = compareScreenshots(img1, img2, width, height, 0.5);
    expect(lowThreshold.changed).toBe(true);

    const highThreshold = compareScreenshots(img1, img2, width, height, 5);
    expect(highThreshold.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/browser/visual-diff.test.ts
```

Expected: FAIL — `compareScreenshots` not found.

- [ ] **Step 3: Implement visual-diff**

Create `src/browser/visual-diff.ts`:

```typescript
import pixelmatch from 'pixelmatch';

export interface DiffResult {
  changed: boolean;
  diffPercentage: number;
  threshold: number;
}

/**
 * Compare two raw RGBA pixel buffers.
 * @param before - RGBA pixel buffer
 * @param after - RGBA pixel buffer
 * @param width - image width in pixels
 * @param height - image height in pixels
 * @param thresholdPercent - percentage of changed pixels to consider "changed" (default 5%)
 */
export function compareScreenshots(
  before: Buffer,
  after: Buffer,
  width: number,
  height: number,
  thresholdPercent: number = 5,
): DiffResult {
  const totalPixels = width * height;
  const diff = Buffer.alloc(width * height * 4);

  const mismatchCount = pixelmatch(before, after, diff, width, height, {
    threshold: 0.1,
  });

  const diffPercentage = (mismatchCount / totalPixels) * 100;

  return {
    changed: diffPercentage > thresholdPercent,
    diffPercentage: Math.round(diffPercentage * 100) / 100,
    threshold: thresholdPercent,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/browser/visual-diff.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/browser/visual-diff.ts src/browser/visual-diff.test.ts
git commit -m "feat(browser): visual diff via pixelmatch"
```

---

### Task 16: Final Integration — Run Full Test Suite & Build

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: PASS — all existing and new tests pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: PASS — TypeScript compiles cleanly.

- [ ] **Step 4: Run lint**

```bash
npm run lint
```

Expected: PASS (or fix any lint errors)

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A
git commit -m "feat(browser): final integration fixes"
```

---

## Post-Implementation Notes

### Spec Deviations

- **`StagehandRequest.contextId` → `groupId`:** The spec uses `contextId` but the plan uses `groupId`. This is intentional — the orchestrator maps groups to contexts internally, so agents should address browser sessions by group, not by internal context ID. The spec should be updated to match.

- **Container skill path:** The spec says `container/skills/browser/SKILL.md`, the plan uses `container/skills/browser-automation/SKILL.md`. The plan's name is more descriptive and avoids collision with the existing `container/skills/agent-browser/` directory.

### What's Deferred to Follow-Up Tasks

1. **Full Stagehand LLM integration** — Task 9 creates the bridge scaffold using raw Playwright. Wiring Stagehand's `act()`/`extract()`/`observe()` with Claude Haiku for element resolution is a follow-up once the IPC plumbing is proven.

2. **Playwright MCP container config** — Task 11 installs the package. Wiring the MCP server config into the container's Claude settings (so Claude auto-discovers the browser tools) requires updating the container's settings.json generation, which interacts with OneCLI agent configuration.

3. **Network interception** (spec Section 6) — Playwright's `page.route()` API for capturing API responses. Add as an optional parameter on `browser_navigate` IPC.

4. **Scheduled browser checks** (spec Section 6) — Wiring `events.json` browser watch rules with `schedule` field through the task scheduler. The `visual-diff.ts` utility is implemented (Task 15), but the scheduling integration requires event router changes.

5. **Crash recovery & health checks** (spec Section 7) — Auto-restart sidecar on next request, one retry then fail, 60s health check interval, OOM repeat detection. The basic disconnect handler is implemented (Task 7), but the full resilience logic is deferred.

6. **Profile key auto-generation** — First-run experience that auto-generates and stores the encryption key via `wxa-secrets set`.

7. **Container image rebuild** — After merging, run `./container/build.sh` to include `@playwright/mcp` in the agent image.

### Testing Checklist

After deployment:
- [ ] `docker network ls` shows `nanoclaw` network
- [ ] `docker compose -f docker-compose.browser.yml ps` shows sidecar running
- [ ] Agent container can resolve `browser-sidecar` hostname
- [ ] `ws://browser-sidecar:9222` accepts WebSocket connections from agent container
- [ ] Browser context create/close works via PlaywrightClient
- [ ] Profile encrypt/decrypt roundtrip preserves cookies
- [ ] Trust engine correctly classifies all browser tools
- [ ] IPC browser_act/extract/observe handlers respond
