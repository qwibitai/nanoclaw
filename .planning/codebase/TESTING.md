# Testing Patterns

**Analysis Date:** 2026-02-27

## Test Framework

**Runner:**
- Vitest 4.0.18
- Config: `vitest.config.ts`
- Includes: `src/**/*.test.ts`, `skills-engine/**/*.test.ts`

**Assertion Library:**
- Vitest built-in assertions (compatible with Jasmine/Jest)
- Uses `expect()` for all assertions

**Run Commands:**
```bash
npm run test              # Run all tests once
npm run test:watch       # Watch mode (re-run on file changes)
npm run test -- --coverage  # Coverage report (requires @vitest/coverage-v8)
```

## Test File Organization

**Location:**
- Co-located with source: test files live in `src/` alongside implementation
- Pattern: `src/{module}.ts` has test file `src/{module}.test.ts`
- Examples: `src/db.ts` → `src/db.test.ts`, `src/group-queue.ts` → `src/group-queue.test.ts`

**Naming:**
- `{module}.test.ts` (not `.spec.ts`)
- Test suites use `describe()` block names matching the module: `describe('storeMessage', ...)`

**Structure:**
```
src/
├── db.ts
├── db.test.ts
├── container-runner.ts
├── container-runner.test.ts
├── group-queue.ts
├── group-queue.test.ts
└── ...
```

## Test Structure

**Suite Organization:**
```typescript
// From src/db.test.ts
import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(() => {
  _initTestDatabase();  // Per-suite setup
});

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('group@g.us', '2024-01-01T00:00:00.000Z');
    store({
      id: 'msg-1',
      chat_jid: 'group@g.us',
      // ... fields
    });

    const messages = getMessagesSince('group@g.us', '2024-01-01T00:00:00.000Z', 'Andy');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
  });

  it('filters out empty content', () => {
    // ... test implementation
  });
});
```

**Patterns:**

1. **Setup:** `beforeEach()` called per test for clean state
   - Database tests: `_initTestDatabase()` creates fresh in-memory SQLite
   - Queue tests: `vi.useFakeTimers()` for controlled async timing

2. **Teardown:** `afterEach()` cleans up resources
   - `vi.useRealTimers()` to restore real timers after test completes
   - Most tests don't need explicit cleanup (in-memory DBs)

3. **Assertion style:** Multiple `expect()` per test is normal
   - Test name describes the scenario, assertions verify multiple aspects
   - Example: test "stores is_from_me flag" verifies both storage and retrieval

## Mocking

**Framework:** Vitest `vi` mock utilities

**Patterns:**
```typescript
// From src/container-runner.test.ts
vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  // ... other config values
}));

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs with selective overrides
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(() => ''),
    },
  };
});

// Use mocked function in test
const processMessages = vi.fn(async (groupJid: string) => {
  activeCount++;
  await new Promise<void>((resolve) => completionCallbacks.push(resolve));
  activeCount--;
  return true;
});
```

**What to Mock:**
- External modules (fs, child_process, config): use `vi.mock()`
- Functions passed to tested code: use `vi.fn()` to track calls
- Timers for async tests: `vi.useFakeTimers()` / `vi.useRealTimers()`
- Dependencies in object parameters: pass mocked implementations to functions

**What NOT to Mock:**
- In-memory databases: use real in-memory SQLite (initialized fresh in `beforeEach`)
- Core algorithms: test the real implementation, not mocked
- String/number utilities: test the real implementation

**Fake Process Objects:**
From `src/container-runner.test.ts`, creating controllable fake child process:
```typescript
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

// Then in test:
fakeProc = createFakeProcess();
vi.mock('child_process', async () => ({
  spawn: vi.fn(() => fakeProc),
}));
```

## Fixtures and Factories

**Test Data:**
Helper functions for creating test records. From `src/db.test.ts`:
```typescript
// Helper to store a message
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}
```

**Location:**
- Inline within test files, near top after imports
- No separate fixtures directory; keep helpers close to usage

**Data Setup:**
- Use named test data constants for clarity: `'group@g.us'`, `'user@s.whatsapp.net'`, `'tg:123456789'`
- Timestamps use ISO format: `'2024-01-01T00:00:00.000Z'`
- Build realistic object literals with all required fields

## Coverage

**Requirements:**
- No explicit coverage target enforced
- Coverage tool available: `@vitest/coverage-v8` installed
- Can run: `npm run test -- --coverage`

**View Coverage:**
```bash
npm run test -- --coverage   # Generates coverage report
```

## Test Types

**Unit Tests:**
- Scope: Individual functions and modules
- Approach: Isolated with dependencies mocked
- Examples:
  - `src/db.test.ts`: Tests database operations (storeMessage, getMessagesSince, etc.)
  - `src/group-queue.test.ts`: Tests queue concurrency logic in isolation
  - `src/routing.test.ts`: Tests JID ownership patterns and group selection logic

**Integration Tests:**
- Scope: Multiple modules working together
- Approach: Uses real in-memory database, fakes external APIs
- Example: `src/container-runner.test.ts` tests container setup with mocked spawn but real FS operations

**E2E Tests:**
- Framework: Not used in this codebase
- No end-to-end tests present; application requires container runtime and messaging channels to fully test

## Common Patterns

**Async Testing:**
```typescript
// From src/group-queue.test.ts
beforeEach(() => {
  vi.useFakeTimers();  // Necessary for .advanceTimersByTimeAsync()
  queue = new GroupQueue();
});

afterEach(() => {
  vi.useRealTimers();  // Always restore
});

it('respects global concurrency limit', async () => {
  const processMessages = vi.fn(async (groupJid: string) => {
    activeCount++;
    // Block until released
    await new Promise<void>((resolve) => completionCallbacks.push(resolve));
    activeCount--;
    return true;
  });

  queue.setProcessMessagesFn(processMessages);
  queue.enqueueMessageCheck('group1@g.us');
  queue.enqueueMessageCheck('group2@g.us');
  queue.enqueueMessageCheck('group3@g.us');

  // Advance fake timers to let promises settle
  await vi.advanceTimersByTimeAsync(10);

  // Verify behavior
  expect(maxActive).toBe(2);  // MAX_CONCURRENT_CONTAINERS = 2
});
```

**Error Testing:**
```typescript
// From src/task-scheduler.test.ts
it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
  createTask({
    id: 'task-invalid-folder',
    group_folder: '../../outside',  // Invalid path
    // ... other fields
  });

  startSchedulerLoop({
    // ... deps
  });

  await vi.advanceTimersByTimeAsync(10);

  // Verify error was handled gracefully
  const task = getTaskById('task-invalid-folder');
  expect(task?.status).toBe('paused');  // Should pause instead of crash
});
```

**Test Isolation:**
- Each test gets fresh state via `beforeEach()`
- No shared mutable state between tests
- Example: `beforeEach(() => { _initTestDatabase(); _setRegisteredGroups({}); })`

**Fake Timers for Async:**
- Used heavily for testing scheduler and queue logic
- Allows advancing time without waiting: `await vi.advanceTimersByTimeAsync(100)`
- Always pair with `beforeEach(vi.useFakeTimers())` and `afterEach(vi.useRealTimers())`

---

*Testing analysis: 2026-02-27*
