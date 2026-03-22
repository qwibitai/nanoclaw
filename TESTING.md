# NanoClaw E2E Testing Infrastructure - Comprehensive Audit

## Executive Summary

NanoClaw has a **mature, comprehensive testing infrastructure** already in place with:
- **6,460 total lines** of test code across 17 test files
- **Full E2E testing system** (`e2e.test.ts`) that simulates messages through the entire pipeline
- **Message simulation mechanisms** using fake channels and process mocks
- **Well-established test patterns** (mocking, fixtures, assertions)
- **Vitest configuration** with support for multiple test types

---

## Test Infrastructure Overview

### 1. Vitest Configuration

**File:** `vitest.config.ts`

```typescript
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
  },
});
```

**Key Properties:**
- Includes tests from both `src/` and `setup/` directories
- Uses TypeScript with `.test.ts` naming convention
- Supports live reloading with `npm run test:watch`

**Available Commands:**
- `npm run test` - Run all tests once
- `npm run test:watch` - Watch mode with live reload
- Coverage support via `@vitest/coverage-v8` (installed as dev dependency)

---

## Test Files Overview (17 Total - 6,460 lines)

| File | Lines | Purpose |
|------|-------|---------|
| **e2e.test.ts** | 439 | ⭐ Full pipeline: message → container → reply |
| **group-queue.test.ts** | 1,240 | Concurrency limits and queue sequencing |
| **db.test.ts** | 484 | Message storage and retrieval |
| **x-ipc.test.ts** | 990 | IPC task processing |
| **ipc-auth.test.ts** | 706 | IPC authentication |
| **x-health.test.ts** | 659 | Health checks |
| **remote-control.test.ts** | 397 | Remote control sessions |
| **formatting.test.ts** | 256 | Message formatting |
| **routing.test.ts** | 279 | Message routing |
| **sender-allowlist.test.ts** | 216 | Authorization |
| **container-runner.test.ts** | 211 | Container execution |
| **credential-proxy.test.ts** | 192 | Credential handling |
| **container-runtime.test.ts** | 149 | Container runtime |
| **task-scheduler.test.ts** | 129 | Scheduled tasks |
| **telegram.test.ts** | 32 KB | Telegram channel tests |
| **channels/registry.test.ts** | 43 | Channel registration |
| **group-folder.test.ts** | 43 | Group folder validation |
| **ipc-watcher.test.ts** | 41 | Directory watching |
| **timezone.test.ts** | 29 | Timezone handling |

---

## Message Simulation Mechanisms

### 1. Database-Backed Message Storage

**In-Memory SQLite Setup:**
```typescript
// Fresh database for each test
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

// Store test messages
storeMessage({
  id: 'msg-1',
  chat_jid: 'tg:123',
  sender: 'user1@example.com',
  sender_name: 'Alice',
  content: '@Andy hello',
  timestamp: '2025-06-01T10:00:00.000Z',
  is_from_me: false,
  is_bot_message: false,
});

// Retrieve messages for processing
const messages = getMessagesSince('tg:123', '', 'Andy');
```

### 2. Fake Channel Implementation

**Pattern for Message Sending Interception:**
```typescript
const channel = {
  name: 'test-channel',
  connect: vi.fn(async () => {}),
  sendMessage: vi.fn(async () => {}),  // Spy on outbound messages
  isConnected: vi.fn(() => true),
  ownsJid: vi.fn((jid: string) => jid === TEST_CHAT_JID),
  disconnect: vi.fn(async () => {}),
  setTyping: vi.fn(async () => {}),     // Spy on typing notifications
};

// Assert on outbound messages
expect(channel.sendMessage).toHaveBeenCalledWith(
  TEST_CHAT_JID,
  'The answer is 4',
  'msg-trigger-1' // reply to message ID
);
```

### 3. Fake Process for Container Simulation

**Pattern for Simulating Container Execution:**
```typescript
// Create fake process
const proc = new EventEmitter();
proc.stdin = new PassThrough();
proc.stdout = new PassThrough();
proc.stderr = new PassThrough();
proc.kill = vi.fn();
proc.pid = 99999;

// Mock spawn to return fake process
vi.mock('child_process', () => ({
  spawn: vi.fn(() => proc),
}));

// Simulate container output
function emitOutput(proc, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// Simulate container lifecycle
await vi.advanceTimersByTimeAsync(10);  // Let spawn happen
emitOutput(proc, {
  status: 'success',
  result: 'The answer is 4',
  newSessionId: 'session-001',
});
await vi.advanceTimersByTimeAsync(10);  // Let parsing happen
proc.emit('close', 0);                  // Simulate clean exit
```

### 4. Context Factories for Channel-Specific Tests

**Telegram Message Context:**
```typescript
function createTextCtx(overrides: {
  chatId?: number;
  text: string;
  fromId?: number;
  firstName?: string;
  messageId?: number;
}) {
  return {
    chat: {
      id: overrides.chatId ?? 100200300,
      type: 'group',
      title: 'Test Group',
    },
    from: {
      id: overrides.fromId ?? 99001,
      first_name: overrides.firstName ?? 'Alice',
      username: 'alice_user',
    },
    message: {
      text: overrides.text,
      date: Math.floor(Date.now() / 1000),
      message_id: overrides.messageId ?? 1,
    },
    me: { username: 'andy_ai_bot' },
    reply: vi.fn(),
  };
}

// Trigger message handlers
async function triggerTextMessage(ctx: ReturnType<typeof createTextCtx>) {
  const handlers = currentBot().filterHandlers.get('message:text') || [];
  for (const h of handlers) await h(ctx);
}
```

---

## Core E2E Test (`e2e.test.ts`)

**Location:** `src/e2e.test.ts` (439 lines)

**Purpose:** Full integration test exercising the complete message pipeline:
- Message receive → Database storage → Container processing → Reply routing

**System Boundaries Mocked:**
- `config.js` (test paths, short timeouts)
- `logger.js` (silent)
- `fs` (IPC dirs, group folders)
- `child_process.spawn` (fake container process)
- Channel implementation (`sendMessage`, `setTyping`)

**Real Components Tested:**
- SQLite database operations
- Container runner logic
- Message formatting and routing
- Output parsing

**Test Cases:**

1. **`processes a triggered message and sends reply to channel`**
   - Simulates: Message store → container execution → reply sent
   - Verifies: Output status, sent message content, reply ID

2. **`formats multiple pending messages into XML prompt`**
   - Tests: Multi-message grouping and XML formatting
   - Verifies: All messages present, correct sender attribution

3. **`strips <internal> tags from agent response`**
   - Tests: Response formatting and tag removal
   - Verifies: Clean output without internal reasoning

4. **`handles container error without sending reply`**
   - Tests: Error path (exit code 1, no output)
   - Verifies: No messages sent on failure

5. **`container timeout triggers error path`**
   - Tests: FIRST_OUTPUT_TIMEOUT behavior
   - Verifies: Process killed, error returned

---

## Test Execution

### Running Tests

```bash
npm run test          # Run all tests once
npm run test:watch   # Watch mode with live reload
npm run test -- --coverage  # With coverage report
```

### Key Patterns Used

| Pattern | Purpose | Example |
|---------|---------|---------|
| `_initTestDatabase()` | Fresh SQLite per test | `beforeEach(() => _initTestDatabase());` |
| `createMessage()` | Simulate inbound messages | `storeMessage(createMessage({ content: '@Andy hello' }));` |
| `createChannel()` | Fake channel for assertions | `expect(channel.sendMessage).toHaveBeenCalled();` |
| `createFakeProcess()` | Simulate container execution | `emitOutput(proc, { status: 'success', result: 'answer' });` |
| `vi.useFakeTimers()` | Time control | `await vi.advanceTimersByTimeAsync(3000);` |
| `vi.mock()` | System boundary mocking | `vi.mock('./config.js', () => ({ ... }));` |
| `vi.spyOn()` | Observe real implementations | `spyOn(fs, 'writeFileSync')` |

---

## Mocking Strategy

### ✅ What IS Mocked

1. **Configuration** (`config.js`) - Test-specific paths, timeouts, limits
2. **External I/O** (`fs`, `child_process`, `logger`) - Prevent side effects
3. **External Services** (`Grammy` for Telegram) - Intercept API calls
4. **Channels** - Fake implementations for testing routing

### ✅ What is NOT Mocked

1. **Database** (`better-sqlite3`) - Real in-memory SQLite with schema
2. **Message Formatting** - Real XML generation
3. **Container Runner Logic** - Real parsing and lifecycle management
4. **Routing Logic** - Real message routing and filtering

---

## Test Data Constants

```typescript
// Test JIDs
const TEST_CHAT_JID = 'tg:123';              // Telegram chat
const WHATSAPP_GROUP_JID = '12345678@g.us'; // WhatsApp group
const WHATSAPP_DM_JID = '12345678@s.whatsapp.net'; // WhatsApp DM

// Timestamps
'2025-06-01T10:00:00.000Z' // ISO format
Math.floor(Date.now() / 1000) // Unix timestamp (Telegram)

// Assistant config
const ASSISTANT_NAME = 'Andy';
const TRIGGER_PATTERN = /^@Andy\b/i;

// Output markers
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
```

---

## How to Add New E2E Tests

### 1. Use existing helpers from `e2e.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { _initTestDatabase, storeMessage, storeChatMetadata } from './db.js';

describe('My new feature', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();
    storeChatMetadata(TEST_CHAT_JID, '2025-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does something', async () => {
    // Store message
    storeMessage(createMessage({
      id: 'msg-test-1',
      content: '@Andy my request',
    }));

    // Run pipeline
    const { output, sentMessages } = await runPipeline(...);

    // Assert
    expect(output.status).toBe('success');
    expect(sentMessages).toHaveLength(1);
  });
});
```

### 2. Mock system boundaries consistently:

```typescript
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_TIMEOUT: 5000,
  DATA_DIR: '/tmp/nanoclaw-test-data',
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
```

### 3. Control time for async tests:

```typescript
it('respects timeout', async () => {
  const promise = doSomethingAsync();
  
  // Advance fake timers
  await vi.advanceTimersByTimeAsync(3000);
  
  // Check result
  const result = await promise;
  expect(result.error).toContain('timed out');
});
```

---

## Key Files Reference

- **Test entry point:** `vitest.config.ts`
- **Main E2E test:** `src/e2e.test.ts`
- **Test database:** `src/db.ts` (exports `_initTestDatabase()`)
- **Container simulation:** `src/container-runner.test.ts`
- **Channel simulation:** `src/channels/telegram.test.ts`
- **Queue testing:** `src/group-queue.test.ts`

---

## Gaps and Opportunities

Potential areas for expansion:

1. **Frontend/UI Testing** - No browser-based E2E tests (Playwright installed but unused)
2. **Real Channel Integration** - No tests against actual WhatsApp/Telegram APIs
3. **Load Testing** - No stress tests for concurrent message processing
4. **Database Migration** - No tests for schema evolution
5. **Multi-Group Isolation** - Limited tests for group-to-group isolation
6. **Credential Handling** - Limited tests for OAuth/token management

---

## Conclusion

NanoClaw has **production-ready E2E testing infrastructure** with:

✅ Full message-to-reply simulation capability
✅ Database-backed message storage for tests
✅ Fake channel implementations for all platforms
✅ Container process simulation with output validation
✅ Time control for timeout testing
✅ Concurrency limit validation
✅ Clean mock boundaries (mock I/O, keep logic)
✅ Easy to extend with new test patterns

**Recommendation:** Use existing patterns as templates for new integration tests rather than starting from scratch.
