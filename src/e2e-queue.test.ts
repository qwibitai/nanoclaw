/**
 * E2E Queue Integration Test: Multi-Group Concurrency with Priority Scheduling
 *
 * Tests the FULL message pipeline through GroupQueue:
 *   store message -> enqueueMessageCheck -> processGroupMessages -> container -> reply
 *
 * Unlike e2e.test.ts (which calls runContainerAgent directly), this test exercises
 * the queue's priority scheduling, soft-reserved slot, idle preemption, and
 * concurrent multi-group processing.
 *
 * Mocks at system boundaries only:
 *   - child_process.spawn (fake container process per group)
 *   - fs (IPC dirs, group folders)
 *   - config (test paths, short timeouts)
 *   - container-runtime (docker commands)
 *   - credential-proxy (auth detection)
 *   - logger (silent)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// --- Sentinel markers (must match container-runner.ts) ---
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

// --- Mocks at system boundaries ---

vi.mock('./config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  CONTAINER_IMAGE: 'nanoclaw-agent:latest',
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  CONTAINER_TIMEOUT: 60000,
  CREDENTIAL_PROXY_PORT: 3001,
  DATA_DIR: '/tmp/nanoclaw-e2e-queue-data',
  FIRST_OUTPUT_TIMEOUT: 5000,
  GROUPS_DIR: '/tmp/nanoclaw-e2e-queue-groups',
  IDLE_TIMEOUT: 2000,
  STORE_DIR: '/tmp/nanoclaw-e2e-queue-store',
  TIMEZONE: 'UTC',
  TRIGGER_PATTERN: /^@Andy\b/i,
  MAX_CONCURRENT_CONTAINERS: 3,
  POLL_INTERVAL: 2000,
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
      cpSync: vi.fn(),
      renameSync: vi.fn(),
    },
  };
});

vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
  loadMountAllowlist: vi.fn(() => null),
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./credential-proxy.js', () => ({
  detectAuthMode: vi.fn(() => 'api-key'),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  CONTAINER_HOST_GATEWAY: 'host.docker.internal',
  PROXY_BIND_HOST: '0.0.0.0',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((host: string, container: string) => [
    '-v',
    `${host}:${container}:ro`,
  ]),
  stopContainer: vi.fn((name: string) => `docker stop ${name}`),
  ensureContainerRuntimeRunning: vi.fn(),
  cleanupOrphans: vi.fn(),
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({ groups: {}, logDenied: false })),
  shouldDropMessage: vi.fn(() => false),
}));

// --- Fake process factory ---

interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
  killed: boolean;
  pid: number;
}

function createFakeProcess(pid = 99999): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  proc.killed = false;
  proc.pid = pid;
  return proc;
}

function emitOutput(
  proc: FakeProcess,
  output: { status: string; result: string | null; newSessionId?: string },
) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

// Track spawned processes per container name
const spawnedProcesses = new Map<string, FakeProcess>();
let spawnOrder: string[] = [];

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      // Extract container name from args: ['run', '-i', '--rm', '--name', 'nanoclaw-xxx', ...]
      const nameIdx = args.indexOf('--name');
      const containerName =
        nameIdx !== -1 ? args[nameIdx + 1] : `unknown-${Date.now()}`;
      const proc = createFakeProcess(Math.floor(Math.random() * 100000));
      spawnedProcesses.set(containerName, proc);
      spawnOrder.push(containerName);
      return proc;
    }),
    exec: vi.fn(
      (_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
        if (cb) cb(null);
        return new EventEmitter();
      },
    ),
  };
});

// --- Imports (after mocks) ---

import {
  _initTestDatabase,
  storeMessage,
  storeChatMetadata,
  setRegisteredGroup,
  setRouterState,
  setSession,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { runContainerAgent } from './container-runner.js';
import { formatMessages } from './router.js';
import { getMessagesSince } from './db.js';
import type { NewMessage, RegisteredGroup, Channel } from './types.js';

// --- Test fixtures ---

const MAIN_JID = 'tg:main-100';
const GROUP_A_JID = 'tg:group-a-200';
const GROUP_B_JID = 'tg:group-b-300';
const GROUP_C_JID = 'tg:group-c-400';
const ASSISTANT_NAME = 'Andy';

const mainGroup: RegisteredGroup = {
  name: 'Main Group',
  folder: 'main',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
  isMain: true,
};

const groupA: RegisteredGroup = {
  name: 'Group A',
  folder: 'group-a',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
};

const groupB: RegisteredGroup = {
  name: 'Group B',
  folder: 'group-b',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
};

const groupC: RegisteredGroup = {
  name: 'Group C',
  folder: 'group-c',
  trigger: '@Andy',
  added_at: '2025-01-01T00:00:00.000Z',
};

const allGroups: Record<string, RegisteredGroup> = {
  [MAIN_JID]: mainGroup,
  [GROUP_A_JID]: groupA,
  [GROUP_B_JID]: groupB,
  [GROUP_C_JID]: groupC,
};

let msgCounter = 0;

function createMessage(
  chatJid: string,
  content: string,
  overrides: Partial<NewMessage> = {},
): NewMessage {
  msgCounter++;
  return {
    id: `msg-${msgCounter}`,
    chat_jid: chatJid,
    sender: 'user1@example.com',
    sender_name: 'Alice',
    content,
    timestamp: new Date(Date.now() + msgCounter).toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function createChannel(): Channel & {
  sendMessage: ReturnType<typeof vi.fn>;
  setTyping: ReturnType<typeof vi.fn>;
  sentTo: Map<string, string[]>;
} {
  const sentTo = new Map<string, string[]>();
  return {
    name: 'test-channel',
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async (jid: string, text: string) => {
      const existing = sentTo.get(jid) || [];
      existing.push(text);
      sentTo.set(jid, existing);
    }),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(async () => {}),
    setTyping: vi.fn(async () => {}),
    sentTo,
  };
}

// --- Full pipeline orchestration ---
// Replicates processGroupMessages from index.ts but wired to our test fixtures

function buildProcessMessagesFn(
  registeredGroups: Record<string, RegisteredGroup>,
  channel: ReturnType<typeof createChannel>,
  queue: GroupQueue,
  lastAgentTimestamp: Record<string, string>,
) {
  return async (chatJid: string): Promise<boolean> => {
    const group = registeredGroups[chatJid];
    if (!group) return true;

    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const missedMessages = getMessagesSince(
      chatJid,
      sinceTimestamp,
      ASSISTANT_NAME,
    );
    if (missedMessages.length === 0) return true;

    const prompt = formatMessages(missedMessages, 'UTC');
    const lastMessageId = missedMessages[0].id;
    const isMain = group.isMain === true;

    // Advance cursor
    lastAgentTimestamp[chatJid] =
      missedMessages[missedMessages.length - 1].timestamp;

    let hadError = false;

    await channel.setTyping(chatJid, true);

    const output = await runContainerAgent(
      group,
      {
        prompt,
        groupFolder: group.folder,
        chatJid,
        isMain,
      },
      (proc, containerName) => {
        queue.registerProcess(
          chatJid,
          proc,
          containerName,
          group.folder,
          'message',
        );
      },
      async (result) => {
        if (result.result) {
          const text =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const cleaned = text
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (cleaned) {
            await channel.setTyping(chatJid, false);
            await channel.sendMessage(chatJid, cleaned, lastMessageId);
          }
        }
        if (result.status === 'success') {
          queue.notifyIdle(chatJid);
        }
        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    await channel.setTyping(chatJid, false);

    return output.status !== 'error' && !hadError;
  };
}

// Helper: find the process spawned for a group by looking at container names
function findProcessForGroup(groupFolder: string): FakeProcess | undefined {
  for (const [name, proc] of spawnedProcesses) {
    if (name.includes(groupFolder)) return proc;
  }
  return undefined;
}

// Helper: get the Nth spawned process
function getSpawnedProcess(index: number): FakeProcess | undefined {
  const name = spawnOrder[index];
  return name ? spawnedProcesses.get(name) : undefined;
}

// Helper: complete a group's container with a response
async function completeContainer(
  groupFolder: string,
  response: string,
  sessionId = 'session-001',
) {
  const proc = findProcessForGroup(groupFolder);
  if (!proc) throw new Error(`No container found for ${groupFolder}`);
  emitOutput(proc, {
    status: 'success',
    result: response,
    newSessionId: sessionId,
  });
  await vi.advanceTimersByTimeAsync(10);
  proc.emit('close', 0);
  await vi.advanceTimersByTimeAsync(10);
}

// Helper: fail a group's container
async function failContainer(groupFolder: string) {
  const proc = findProcessForGroup(groupFolder);
  if (!proc) throw new Error(`No container found for ${groupFolder}`);
  proc.emit('close', 1);
  await vi.advanceTimersByTimeAsync(10);
}

// --- Tests ---

describe('E2E Queue: Multi-Group Concurrency with Priority', () => {
  let queue: GroupQueue;
  let channel: ReturnType<typeof createChannel>;
  let lastAgentTimestamp: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers();
    _initTestDatabase();

    // Reset tracking
    spawnedProcesses.clear();
    spawnOrder = [];
    msgCounter = 0;

    // Set up DB with chat metadata for all groups
    for (const [jid, group] of Object.entries(allGroups)) {
      storeChatMetadata(
        jid,
        '2025-01-01T00:00:00.000Z',
        group.name,
        'telegram',
        true,
      );
      setRegisteredGroup(jid, group);
    }

    // Create queue and channel
    queue = new GroupQueue();
    queue.setMainGroup(MAIN_JID);
    channel = createChannel();
    lastAgentTimestamp = {};

    const processMessages = buildProcessMessagesFn(
      allGroups,
      channel,
      queue,
      lastAgentTimestamp,
    );
    queue.setProcessMessagesFn(processMessages);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Basic pipeline ─────────────────────────────────────────────────

  it('single group message flows through full pipeline: store -> queue -> container -> reply', async () => {
    storeMessage(createMessage(MAIN_JID, 'Hello, what is 2+2?'));

    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Container should have been spawned
    expect(spawnOrder.length).toBe(1);
    expect(spawnOrder[0]).toContain('main');

    // Complete the container
    await completeContainer('main', 'The answer is 4');

    // Channel should have received the reply
    expect(channel.sentTo.get(MAIN_JID)).toEqual(['The answer is 4']);
  });

  // ── Concurrent multi-group ─────────────────────────────────────────

  it('processes messages from multiple groups concurrently', async () => {
    // Store messages in 3 groups
    storeMessage(createMessage(MAIN_JID, 'Main task'));
    storeMessage(createMessage(GROUP_A_JID, '@Andy Group A task'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy Group B task'));

    // Enqueue all 3 (MAX_CONCURRENT = 3, all should start)
    queue.enqueueMessageCheck(MAIN_JID);
    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    await vi.advanceTimersByTimeAsync(50);

    // All 3 containers should be spawned
    expect(spawnOrder.length).toBe(3);

    // Complete them all
    await completeContainer('main', 'Main done');
    await completeContainer('group-a', 'A done');
    await completeContainer('group-b', 'B done');

    expect(channel.sentTo.get(MAIN_JID)).toEqual(['Main done']);
    expect(channel.sentTo.get(GROUP_A_JID)).toEqual(['A done']);
    expect(channel.sentTo.get(GROUP_B_JID)).toEqual(['B done']);
  });

  // ── Priority: main gets slot first ─────────────────────────────────

  it('main group starts before other groups when all are waiting', async () => {
    // Fill all 3 slots with existing work
    storeMessage(createMessage(GROUP_A_JID, '@Andy Fill slot 1'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy Fill slot 2'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy Fill slot 3'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnOrder.length).toBe(3);
    const initialSpawnCount = spawnOrder.length;

    // Now queue main and another group -- both should be waiting
    storeMessage(createMessage(MAIN_JID, 'Urgent main task'));
    storeMessage(createMessage(GROUP_A_JID, '@Andy Another A task'));

    queue.enqueueMessageCheck(MAIN_JID);
    queue.enqueueMessageCheck(GROUP_A_JID); // A already has active, so this sets pendingMessages
    await vi.advanceTimersByTimeAsync(50);

    // No new containers yet -- all slots full
    expect(spawnOrder.length).toBe(initialSpawnCount);

    // Free one slot by completing Group C
    await completeContainer('group-c', 'C done');

    // Main should have started (priority 0), not Group A's next message
    const newSpawns = spawnOrder.slice(initialSpawnCount);
    expect(newSpawns.length).toBeGreaterThanOrEqual(1);
    expect(newSpawns[0]).toContain('main');
  });

  // ── Soft reserve ───────────────────────────────────────────────────

  it('soft reserve: non-main uses all slots when main has no pending work', async () => {
    // Main has no messages -- non-main should be able to fill all 3 slots
    storeMessage(createMessage(GROUP_A_JID, '@Andy A task'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B task'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C task'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    // All 3 should have started -- soft reserve is released
    expect(spawnOrder.length).toBe(3);

    // Cleanup
    await completeContainer('group-a', 'A');
    await completeContainer('group-b', 'B');
    await completeContainer('group-c', 'C');
  });

  // ── Idle preemption ────────────────────────────────────────────────

  it('preempts idle non-main container when main message arrives at full capacity', async () => {
    // Fill all 3 slots
    storeMessage(createMessage(GROUP_A_JID, '@Andy A work'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B work'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C work'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnOrder.length).toBe(3);

    // Group A finishes its work -- container becomes idle
    const procA = findProcessForGroup('group-a')!;
    emitOutput(procA, { status: 'success', result: 'A done' });
    await vi.advanceTimersByTimeAsync(10);
    // notifyIdle is called by the output callback (status === 'success')

    // Main message arrives at full capacity
    storeMessage(createMessage(MAIN_JID, 'Urgent from main'));
    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Check that _close was written (preemption signal)
    const fsModule = await import('fs');
    const writeFileSync = vi.mocked(fsModule.default.writeFileSync);
    const closeWrites = writeFileSync.mock.calls.filter(
      (call) =>
        typeof call[0] === 'string' && (call[0] as string).endsWith('_close'),
    );
    expect(closeWrites.length).toBeGreaterThanOrEqual(1);

    // Complete remaining containers
    procA.emit('close', 0);
    await vi.advanceTimersByTimeAsync(50);

    // Main should have been queued and will start once the preempted slot frees
    // (the queue puts main at priority 0 in the waiting queue)
    const mainSpawns = spawnOrder.filter((n) => n.includes('main'));
    expect(mainSpawns.length).toBeGreaterThanOrEqual(1);

    // Cleanup
    for (const proc of spawnedProcesses.values()) {
      if (!proc.killed) {
        emitOutput(proc, { status: 'success', result: 'done' });
        await vi.advanceTimersByTimeAsync(10);
        proc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);
      }
    }
  });

  // ── Task scheduling ────────────────────────────────────────────────

  it('tasks run alongside messages without blocking', async () => {
    // Start a message for main
    storeMessage(createMessage(MAIN_JID, 'Main work'));
    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnOrder.length).toBe(1);

    // Enqueue a task for Group A -- should start in its own slot
    let taskCompleted = false;
    const taskFn = vi.fn(async () => {
      taskCompleted = true;
    });
    queue.enqueueTask(GROUP_A_JID, 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(50);

    // Task should have started (slot available)
    expect(taskFn).toHaveBeenCalledTimes(1);
    expect(taskCompleted).toBe(true);

    // Main container should still be running
    const mainProc = findProcessForGroup('main');
    expect(mainProc).toBeDefined();

    await completeContainer('main', 'Main done');
  });

  it('tasks have lowest priority when competing for slots', async () => {
    // Fill all 3 slots
    storeMessage(createMessage(GROUP_A_JID, '@Andy A'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Queue a task and a main message (both waiting)
    let taskStarted = false;
    queue.enqueueTask(
      GROUP_A_JID,
      'task-low-priority',
      vi.fn(async () => {
        taskStarted = true;
      }),
    );
    storeMessage(createMessage(MAIN_JID, 'High priority main'));
    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Free one slot
    await completeContainer('group-a', 'A done');

    // Main message should start (priority 0), not the task (priority 2)
    const newSpawns = spawnOrder.filter((n) => n.includes('main'));
    expect(newSpawns.length).toBe(1);
    expect(taskStarted).toBe(false);

    // Free another slot -- now task can start
    await completeContainer('group-b', 'B done');
    expect(taskStarted).toBe(true);

    // Cleanup
    await completeContainer('group-c', 'C done');
    await completeContainer('main', 'Main done');
  });

  // ── Multiple messages to same group ────────────────────────────────

  it('queues second message for same group behind active container', async () => {
    storeMessage(createMessage(MAIN_JID, 'First message'));
    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    expect(spawnOrder.length).toBe(1);

    // Second message while container is active
    storeMessage(createMessage(MAIN_JID, 'Second message'));
    queue.enqueueMessageCheck(MAIN_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Should NOT spawn a second container -- queued as pendingMessages
    expect(spawnOrder.length).toBe(1);

    // Complete first -- second should auto-start
    await completeContainer('main', 'First reply');
    await vi.advanceTimersByTimeAsync(100);

    // Second container should be spawned now
    const mainSpawns = spawnOrder.filter((n) => n.includes('main'));
    expect(mainSpawns.length).toBe(2);
  });

  // ── Queue metrics ──────────────────────────────────────────────────

  it('getQueueMetrics reflects correct state during contention', async () => {
    // Fill all 3 slots
    storeMessage(createMessage(GROUP_A_JID, '@Andy A'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    let metrics = queue.getQueueMetrics();
    expect(metrics.activeCount).toBe(3);
    expect(metrics.maxContainers).toBe(3);

    // Queue main (goes to waiting)
    storeMessage(createMessage(MAIN_JID, 'Main waiting'));
    queue.enqueueMessageCheck(MAIN_JID);

    metrics = queue.getQueueMetrics();
    expect(metrics.waitingByPriority.mainMessages).toBe(1);
    expect(metrics.waitingByPriority.messages).toBe(0);
    expect(metrics.waitingByPriority.tasks).toBe(0);

    // Queue a task
    queue.enqueueTask(
      GROUP_A_JID,
      'task-1',
      vi.fn(async () => {}),
    );

    metrics = queue.getQueueMetrics();
    expect(metrics.waitingByPriority.tasks).toBe(1);

    // Cleanup
    await completeContainer('group-a', 'done');
    await completeContainer('group-b', 'done');
    await completeContainer('group-c', 'done');
    await completeContainer('main', 'done');
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('container error frees slot for next group in queue', async () => {
    // Fill all 3 slots
    storeMessage(createMessage(GROUP_A_JID, '@Andy A'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C'));

    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);
    await vi.advanceTimersByTimeAsync(50);

    // Queue main (waiting)
    storeMessage(createMessage(MAIN_JID, 'Main waiting'));
    queue.enqueueMessageCheck(MAIN_JID);

    // Group A's container fails
    await failContainer('group-a');

    // Main should get the freed slot
    await vi.advanceTimersByTimeAsync(100);
    const mainSpawns = spawnOrder.filter((n) => n.includes('main'));
    expect(mainSpawns.length).toBe(1);

    // Cleanup
    await completeContainer('group-b', 'done');
    await completeContainer('group-c', 'done');
    await completeContainer('main', 'done');
  });

  // ── Stress: rapid multi-message burst ──────────────────────────────

  it('handles rapid burst of messages across many groups without exceeding concurrency', async () => {
    // Store messages for all 4 groups simultaneously
    storeMessage(createMessage(MAIN_JID, 'Main burst'));
    storeMessage(createMessage(GROUP_A_JID, '@Andy A burst'));
    storeMessage(createMessage(GROUP_B_JID, '@Andy B burst'));
    storeMessage(createMessage(GROUP_C_JID, '@Andy C burst'));

    // Enqueue all synchronously (simulates rapid poll cycle)
    queue.enqueueMessageCheck(MAIN_JID);
    queue.enqueueMessageCheck(GROUP_A_JID);
    queue.enqueueMessageCheck(GROUP_B_JID);
    queue.enqueueMessageCheck(GROUP_C_JID);

    // IMMEDIATELY check -- no await between enqueues
    // activeCount should never exceed MAX_CONCURRENT_CONTAINERS (3)
    expect(queue['activeCount']).toBeLessThanOrEqual(3);

    await vi.advanceTimersByTimeAsync(50);

    // Only 3 containers spawned (limit = 3)
    expect(spawnOrder.length).toBe(3);

    // Main should be one of the 3 (priority)
    const mainSpawned = spawnOrder.some((n) => n.includes('main'));
    expect(mainSpawned).toBe(true);

    // Complete one -- the 4th group should start
    await completeContainer(
      spawnOrder[0].includes('main') ? 'main' : spawnOrder[0].split('-')[1],
      'done',
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(spawnOrder.length).toBe(4);

    // Cleanup remaining
    for (const proc of spawnedProcesses.values()) {
      if (!proc.killed) {
        emitOutput(proc, { status: 'success', result: 'cleanup' });
        await vi.advanceTimersByTimeAsync(10);
        proc.emit('close', 0);
        await vi.advanceTimersByTimeAsync(10);
      }
    }
  });
});
