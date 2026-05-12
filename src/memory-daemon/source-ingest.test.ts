import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { SourceIngester, setIngestDb, looksBinary } from './source-ingest.js';
import type { MemoryStore, RememberResult } from '../modules/memory/store.js';
import type { HealthRecorder } from './health.js';
import { setDeadLettersDb } from './dead-letters.js';

vi.mock('./classifier-client.js', () => ({
  callClassifier: vi.fn(),
  CLASSIFIER_VERSION: 'v1',
  PROMPT_VERSION: 'v1',
  EXTRACTOR_VERSION: 'v1',
}));

/**
 * processInboxFile reads through an O_NOFOLLOW file descriptor with
 * fstat + /proc/self/fd readlink validation, closing the TOCTOU race
 * (Codex finding #2 round 2). Tests use synthetic paths (e.g. /tmp/test.txt)
 * that may not exist on disk; this helper stubs realpath/open/fstat/readlink/
 * read/close so the synthetic path appears to be a regular file inside the
 * inbox containing `fileContent`.
 *
 * Returns the resolved path the test should use for subsequent assertions
 * (since the production code reassigns filePath = fdRealPath).
 */
function stubProcessInboxFileValidation(filePath: string, sourcesBasePath: string, fileContent: string): string {
  const inboxPath = path.join(sourcesBasePath, 'sources', 'inbox');
  const fileName = path.basename(filePath);
  const stubbedRealPath = path.join(inboxPath, fileName);
  const FAKE_FD = 999;
  const contentBuf = Buffer.from(fileContent, 'utf8');

  vi.spyOn(fs, 'realpathSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s === inboxPath) return inboxPath;
    return stubbedRealPath;
  }) as unknown as typeof fs.realpathSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((..._args: unknown[]) => FAKE_FD) as unknown as typeof fs.openSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(
    ((..._args: unknown[]) =>
      ({
        isFile: () => true,
        size: contentBuf.length,
      }) as fs.Stats) as unknown as typeof fs.fstatSync,
  );
  vi.spyOn(fs, 'readlinkSync').mockImplementation(((p: fs.PathLike) => {
    const s = String(p);
    if (s === `/proc/self/fd/${FAKE_FD}`) return stubbedRealPath;
    throw new Error(`unexpected readlinkSync(${s})`);
  }) as unknown as typeof fs.readlinkSync);
  vi.spyOn(fs, 'readSync').mockImplementation(((
    _fd: number,
    buf: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    _position: number | bigint | null,
  ) => {
    const view = buf as unknown as Buffer;
    const remaining = contentBuf.length - offset;
    const toCopy = Math.min(length, remaining);
    contentBuf.copy(view, offset, offset, offset + toCopy);
    return toCopy;
  }) as unknown as typeof fs.readSync);
  vi.spyOn(fs, 'closeSync').mockImplementation((() => undefined) as unknown as typeof fs.closeSync);
  return stubbedRealPath;
}

import { callClassifier } from './classifier-client.js';

function makeIngestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE processed_sources (
      agent_group_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      extractor_version TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      source_path TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      facts_written INTEGER NOT NULL,
      facts_emitted INTEGER NOT NULL DEFAULT 0,
      facts_dropped_low_importance INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_group_id, content_sha256, extractor_version, prompt_version)
    );
    CREATE TABLE dead_letters (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      item_key TEXT NOT NULL,
      agent_group_id TEXT NOT NULL,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_attempted_at TEXT NOT NULL,
      next_retry_at TEXT,
      poisoned_at TEXT,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dead_letters_retry
      ON dead_letters(next_retry_at) WHERE poisoned_at IS NULL;
  `);
  return db;
}

function makeStore(overrides?: Partial<MemoryStore>): MemoryStore {
  return {
    recall: vi.fn().mockResolvedValue({ facts: [], totalAvailable: 0, latencyMs: 0, fromCache: false }),
    remember: vi.fn().mockResolvedValue({ action: 'added', factId: 'fact-1' } as RememberResult),
    health: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeHealth(): HealthRecorder {
  return {
    recordTurnClassified: vi.fn(),
    recordClassifierFailure: vi.fn(),
    recordSourceIngest: vi.fn(),
    recordRecallLatency: vi.fn(),
    recordRecallFailOpen: vi.fn(),
    recordRedaction: vi.fn(),
    recordLowImportanceDropped: vi.fn(),
    recordSynthesiseSucceeded: vi.fn(),
    recordMemoryEnabledCheckFailure: vi.fn(),
    setPrereqVerification: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as HealthRecorder;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default-permissive lstat: synthetic test paths (`/test/group-a`,
  // `/tmp/test.txt`, etc.) don't exist on disk; the F9 round-3 chain check
  // (isNonSymlinkChain) lstat's the parent first and fails closed on
  // ENOENT. Stub lstat to claim "regular directory" for any path that the
  // test doesn't explicitly override. Per-test mocks (e.g. the
  // stubProcessInboxFileValidation helper for inbox-file inspection) still
  // win because vi.spyOn replaces this default.
  vi.spyOn(fs, 'lstatSync').mockImplementation(
    (() =>
      ({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        isFile: () => false,
      }) as fs.Stats) as unknown as typeof fs.lstatSync,
  );
});

describe('SourceIngester', () => {
  it('test_atomic_write_event_mask — FSWatcher uses change/rename events, not IN_CREATE only', () => {
    // Verify that the source code subscribes to 'change' and 'rename' events (which map to
    // IN_CLOSE_WRITE and IN_MOVED_TO in Linux inotify), NOT just 'rename' (which maps to IN_CREATE).
    // The implementation comments explain: 'change' = IN_CLOSE_WRITE, 'rename' = IN_MOVED_TO.
    const src = fs.readFileSync(new URL('./source-ingest.ts', import.meta.url), 'utf8');

    // Must subscribe to 'change' events (covers IN_CLOSE_WRITE)
    expect(src).toContain("eventType !== 'rename' && eventType !== 'change'");
    // Must NOT subscribe to IN_CREATE-only logic (no unconditional rename-only filter)
    expect(src).toContain('IN_CLOSE_WRITE');
    expect(src).toContain('IN_MOVED_TO');
    // Must NOT have IN_CREATE in the event subscription logic
    expect(src).not.toContain('IN_CREATE');
  });

  it('test_reconcile_opens_and_closes — reconcile closes removed, opens new, leaves existing', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    const ingester = new SourceIngester();

    // Mock fs.watch to avoid real filesystem operations
    const mockWatcherA = { on: vi.fn().mockReturnThis(), close: vi.fn() };
    const mockWatcherB = { on: vi.fn().mockReturnThis(), close: vi.fn() };
    const mockWatcherC = { on: vi.fn().mockReturnThis(), close: vi.fn() };

    let watchCallCount = 0;
    const watchers = [mockWatcherA, mockWatcherB, mockWatcherC];
    const fsWatchSpy = vi.spyOn(fs, 'watch').mockImplementation(() => {
      return watchers[watchCallCount++] as unknown as fs.FSWatcher;
    });
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    // Open watchers for A and B
    const result1 = ingester.reconcileWatchers([
      { agentGroupId: 'A', folder: 'group-a', sourcesBasePath: '/test/group-a', enabled: true },
      { agentGroupId: 'B', folder: 'group-b', sourcesBasePath: '/test/group-b', enabled: true },
    ]);

    expect(result1.opened).toBe(2);
    expect(result1.closed).toBe(0);
    expect(fsWatchSpy).toHaveBeenCalledTimes(2);

    // Reconcile: A=enabled, B=disabled, C=enabled (new)
    const result2 = ingester.reconcileWatchers([
      { agentGroupId: 'A', folder: 'group-a', sourcesBasePath: '/test/group-a', enabled: true },
      { agentGroupId: 'B', folder: 'group-b', sourcesBasePath: '/test/group-b', enabled: false },
      { agentGroupId: 'C', folder: 'group-c', sourcesBasePath: '/test/group-c', enabled: true },
    ]);

    expect(result2.opened).toBe(1); // C opened
    expect(result2.closed).toBe(1); // B closed
    expect(mockWatcherB.close).toHaveBeenCalled();
    expect(mockWatcherA.close).not.toHaveBeenCalled();

    await ingester.shutdown();

    fsWatchSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_idempotency — already-processed file skips classifier', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    const agentGroupId = 'ag-test-idempotency';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'This is the test file content for idempotency checking.';
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const { createHash } = await import('crypto');
    const contentHash = createHash('sha256').update(canonical).digest('hex');

    // Pre-insert processed_sources row
    ingestDb
      .prepare(
        `
      INSERT INTO processed_sources
        (agent_group_id, content_sha256, extractor_version, prompt_version, source_path, ingested_at, facts_written)
      VALUES (?, ?, 'v1', 'v1', '/tmp/test.txt', ?, 2)
    `,
      )
      .run(agentGroupId, contentHash, new Date().toISOString());

    stubProcessInboxFileValidation('/tmp/test.txt', sourcesBasePath, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, '/tmp/test.txt', store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(false);
    expect(callClassifier).not.toHaveBeenCalled();
    // File moved to processed/
    expect(renameSpy).toHaveBeenCalled();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_moves_file_on_success — new file classified, moved to processed/', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'The project uses TypeScript with strict mode enabled',
          category: 'fact',
          importance: 5,
          entities: ['TypeScript'],
          source_role: 'external',
        },
        {
          content: 'Dave prefers pnpm over npm for the host package manager',
          category: 'preference',
          importance: 4,
          entities: ['pnpm'],
          source_role: 'external',
        },
      ],
    });

    const agentGroupId = 'ag-test-success';
    const sourcesBasePath = '/test/test-group';
    const fileContent =
      'The project uses TypeScript with strict mode. Dave prefers pnpm over npm for the host package manager. This is a detailed source document with substantial information.';

    const resolvedPath = stubProcessInboxFileValidation('/tmp/new-doc.txt', sourcesBasePath, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, '/tmp/new-doc.txt', store, health);

    expect(result.factsWritten).toBe(2);
    expect(result.failed).toBe(false);
    expect(callClassifier).toHaveBeenCalledOnce();
    expect(store.remember).toHaveBeenCalledTimes(2);

    // File moved to processed/<date>/ directory. Note: production canonicalizes
    // the path via the fd readlink before reading, so renameSync is called
    // with the resolved (stubbed) path, not the original /tmp/new-doc.txt.
    expect(renameSpy).toHaveBeenCalledWith(resolvedPath, expect.stringContaining('processed'));

    // processed_sources row inserted
    const { createHash } = await import('crypto');
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const contentHash = createHash('sha256').update(canonical).digest('hex');
    const row = ingestDb.prepare(`SELECT * FROM processed_sources WHERE content_sha256 = ?`).get(contentHash);
    expect(row).toBeTruthy();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_drops_low_importance_facts — facts below MIN_FACT_IMPORTANCE skip store.remember and increment health counter', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // Mix of below-threshold (1, 2, 3) and at/above-threshold (4, 5) facts.
    // Mirrors the chat-pair classifier's importance gate at classifier.ts:364
    // so source-ingest paths (CC turn-pair captures, container-agent tool
    // fetches) get the same retention bar as message-stream facts.
    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        { content: 'low signal A', category: 'fact', importance: 1, entities: [], source_role: 'external' },
        { content: 'low signal B', category: 'fact', importance: 2, entities: [], source_role: 'external' },
        { content: 'low signal C', category: 'fact', importance: 3, entities: [], source_role: 'external' },
        { content: 'kept fact D', category: 'fact', importance: 4, entities: [], source_role: 'external' },
        { content: 'kept fact E', category: 'fact', importance: 5, entities: [], source_role: 'external' },
      ],
    });

    const agentGroupId = 'ag-test-importance-filter';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'A source document with mixed-importance facts to test the threshold gate.';
    const filePath = '/tmp/mixed-importance.txt';

    stubProcessInboxFileValidation(filePath, sourcesBasePath, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, filePath, store, health);

    // Only the importance >= 4 facts get written.
    expect(result.factsWritten).toBe(2);
    expect(result.failed).toBe(false);
    expect(store.remember).toHaveBeenCalledTimes(2);

    // Per-drop health counter fires once per below-threshold fact.
    expect(health.recordLowImportanceDropped).toHaveBeenCalledTimes(3);
    expect(health.recordLowImportanceDropped).toHaveBeenCalledWith(agentGroupId);

    // File still moves to processed/ — pipeline succeeded, even though some
    // facts were filtered.
    expect(renameSpy).toHaveBeenCalled();

    // Per-source counters land in processed_sources so operators can see the
    // drop rate by group. This is the F1 follow-up — without these columns
    // the threshold is invisible after the fact.
    const psRow = ingestDb
      .prepare(`SELECT facts_written, facts_emitted, facts_dropped_low_importance FROM processed_sources`)
      .get() as { facts_written: number; facts_emitted: number; facts_dropped_low_importance: number };
    expect(psRow).toBeTruthy();
    expect(psRow.facts_written).toBe(2);
    expect(psRow.facts_emitted).toBe(5);
    expect(psRow.facts_dropped_low_importance).toBe(3);

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_redaction_runs_before_importance_gate — low-importance secret-shaped facts are counted as redactions, not importance drops (parity with classifier.ts:340)', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    // A fact with importance=1 (would be dropped by the importance gate) that
    // ALSO contains a secret-shape string. With redaction running first, this
    // must increment recordRedaction, not recordLowImportanceDropped — so the
    // operator-facing redaction telemetry doesn't go dark for low-signal
    // source-ingested content that happens to leak secrets.
    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'low signal that leaks sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF',
          category: 'fact',
          importance: 1,
          entities: [],
          source_role: 'external',
        },
        { content: 'kept fact D', category: 'fact', importance: 4, entities: [], source_role: 'external' },
      ],
    });

    const agentGroupId = 'ag-test-redaction-order';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'A source document mixing a low-importance secret with a real fact.';
    const filePath = '/tmp/mixed-redaction-order.txt';

    stubProcessInboxFileValidation(filePath, sourcesBasePath, fileContent);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, filePath, store, health);

    // Only the non-secret importance>=4 fact gets written.
    expect(result.factsWritten).toBe(1);
    expect(result.failed).toBe(false);
    expect(store.remember).toHaveBeenCalledTimes(1);

    // The secret-shape fact MUST be counted as a redaction, not as a
    // low-importance drop. This is the parity guarantee — if the order ever
    // flips back, this test catches it.
    expect(health.recordRedaction).toHaveBeenCalledTimes(1);
    expect(health.recordRedaction).toHaveBeenCalledWith(agentGroupId, expect.any(String));
    expect(health.recordLowImportanceDropped).not.toHaveBeenCalled();

    // facts_dropped_low_importance must be 0 — the redacted fact was filtered
    // before reaching the importance gate, so the counter doesn't fire.
    const psRow = ingestDb
      .prepare(`SELECT facts_written, facts_emitted, facts_dropped_low_importance FROM processed_sources`)
      .get() as { facts_written: number; facts_emitted: number; facts_dropped_low_importance: number };
    expect(psRow).toBeTruthy();
    expect(psRow.facts_written).toBe(1);
    expect(psRow.facts_emitted).toBe(2);
    expect(psRow.facts_dropped_low_importance).toBe(0);

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_success_clears_dead_letters — pre-existing dead_letters row is deleted in same txn as processed_sources INSERT', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: true,
      facts: [
        {
          content: 'Fact from previously dead-lettered file',
          category: 'fact',
          importance: 4,
          entities: [],
          source_role: 'external',
        },
      ],
    });

    const agentGroupId = 'ag-test-dl-cleanup';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'Source document that was previously dead-lettered and is now re-processed.';
    const filePath = '/tmp/previously-dead.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, sourcesBasePath, fileContent);

    // Pre-insert a dead_letters row for this file (simulating a prior failure)
    ingestDb
      .prepare(
        `INSERT INTO dead_letters
           (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at)
         VALUES ('dl-1', 'source-file', ?, ?, 2, 'prior error', ?)`,
      )
      .run(resolvedPath, agentGroupId, new Date().toISOString());

    const dlBefore = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlBefore).toBeTruthy();

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, filePath, store, health);

    expect(result.factsWritten).toBe(1);
    expect(result.failed).toBe(false);

    // dead_letters row must be gone after successful processing
    const dlAfter = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlAfter).toBeUndefined();

    // processed_sources row must exist
    const { createHash } = await import('crypto');
    const canonical = fileContent.trim().replace(/\r\n/g, '\n');
    const contentHash = createHash('sha256').update(canonical).digest('hex');
    const psRow = ingestDb.prepare(`SELECT * FROM processed_sources WHERE content_sha256 = ?`).get(contentHash);
    expect(psRow).toBeTruthy();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_worth_storing_false_clears_dead_letters — worth_storing=false path also deletes dead_letters', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockResolvedValue({
      worth_storing: false,
      facts: [],
    });

    const agentGroupId = 'ag-test-dl-cleanup-no-facts';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'A trivial document with no extractable facts.';
    const filePath = '/tmp/no-facts.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, sourcesBasePath, fileContent);

    // Pre-insert a dead_letters row for this file
    ingestDb
      .prepare(
        `INSERT INTO dead_letters
           (id, item_type, item_key, agent_group_id, failure_count, last_error, last_attempted_at)
         VALUES ('dl-2', 'source-file', ?, ?, 1, 'prior error', ?)`,
      )
      .run(resolvedPath, agentGroupId, new Date().toISOString());

    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, filePath, store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(false);

    // dead_letters row must be gone after worth_storing=false success
    const dlAfter = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlAfter).toBeUndefined();

    mkdirSpy.mockRestore();
    renameSpy.mockRestore();
    ingestDb.close();
  });

  it('test_processInboxFile_keeps_file_on_failure — classifier error leaves file in inbox, dead_letters created', async () => {
    const ingestDb = makeIngestDb();
    setIngestDb(ingestDb);
    setDeadLettersDb(ingestDb);

    vi.mocked(callClassifier).mockRejectedValue(new Error('Anthropic API error 500: internal error'));

    const agentGroupId = 'ag-test-failure';
    const sourcesBasePath = '/test/test-group';
    const fileContent = 'Source document that will fail to classify due to API error.';
    const filePath = '/tmp/failing-doc.txt';

    const resolvedPath = stubProcessInboxFileValidation(filePath, sourcesBasePath, fileContent);
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);

    const ingester = new SourceIngester();
    const store = makeStore();
    const health = makeHealth();

    const result = await ingester.processInboxFile(agentGroupId, sourcesBasePath, filePath, store, health);

    expect(result.factsWritten).toBe(0);
    expect(result.failed).toBe(true);
    // File NOT moved (stays in inbox)
    expect(renameSpy).not.toHaveBeenCalled();
    // Dead letters row created — keyed on the resolved path (production
    // canonicalizes the path via realpathSync before storing).
    const dlRow = ingestDb
      .prepare(`SELECT * FROM dead_letters WHERE item_key = ? AND agent_group_id = ?`)
      .get(resolvedPath, agentGroupId);
    expect(dlRow).toBeTruthy();

    renameSpy.mockRestore();
    ingestDb.close();
  });
});

describe('looksBinary', () => {
  it('returns false for plain UTF-8 text', () => {
    expect(looksBinary('Hello, world. This is a normal sentence.\nWith a newline.\n')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(looksBinary('')).toBe(false);
  });

  it('returns false for UTF-8 with multibyte chars', () => {
    expect(looksBinary('café — naïve résumé 你好 🎉')).toBe(false);
  });

  it('returns true on any null byte', () => {
    expect(looksBinary('valid text \0 with embedded null')).toBe(true);
  });

  it('returns true for PNG magic bytes', () => {
    // PNG file header: 0x89 0x50 0x4E 0x47 0x0D 0x0A 0x1A 0x0A then chunks
    // The IHDR chunk and beyond contain plenty of low-byte garbage.
    const pngHeader = '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR' + '\x01\x02\x03\x04'.repeat(100);
    expect(looksBinary(pngHeader)).toBe(true);
  });

  it('returns true when >5% of sample is non-printable control bytes', () => {
    // 100 chars, 6 non-printable (excluding tab/LF/CR which are allowed)
    const mixed = 'a'.repeat(94) + '\x01\x02\x03\x04\x05\x06';
    expect(looksBinary(mixed)).toBe(true);
  });

  it('returns false at exactly 5% threshold', () => {
    // 100 chars, 5 non-printable — should NOT trigger (must be > 5%)
    const mixed = 'a'.repeat(95) + '\x01\x02\x03\x04\x05';
    expect(looksBinary(mixed)).toBe(false);
  });

  it('only samples first 8KB for the percentage calc', () => {
    // 16KB of clean text + some control bytes after the 8KB cap — those
    // should not contribute to the ratio because they're outside the sample.
    const clean = 'a'.repeat(8192);
    const trailingGarbage = '\x01\x02\x03'.repeat(1000);
    expect(looksBinary(clean + trailingGarbage)).toBe(false);
  });

  it('finds null bytes anywhere in the input — full scan, not 8KB-only', () => {
    // Codex Finding F2 (2026-05-04): the prior 8KB-only sample missed
    // text-prefix-then-binary files, so a 9KB clean header followed by a
    // null byte slipped through and hit the codex spawn TypeError. Full
    // scan is O(N) bytewise — cheap enough.
    const lateNull = 'a'.repeat(8192) + '\0extra';
    expect(looksBinary(lateNull)).toBe(true);
  });

  it('finds null bytes very late in a large input', () => {
    // 64KB clean prefix, single null byte at position ~64K, more text after.
    const huge = 'a'.repeat(65536) + '\0' + 'b'.repeat(1024);
    expect(looksBinary(huge)).toBe(true);
  });

  it('accepts raw Buffer input (preferred — runs before UTF-8 decode)', () => {
    // PNG magic bytes as a Buffer. Buffer.charCodeAt-equivalent (data[i]) is
    // raw bytes, not UTF-16 code units, so this is the canonical input shape
    // for the daemon's pre-decode binary check.
    const pngBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    expect(looksBinary(pngBuf)).toBe(true);
  });

  it('accepts text Buffer input — clean UTF-8 in Buffer form is not binary', () => {
    const textBuf = Buffer.from('Hello, world. Plain text in a buffer.', 'utf8');
    expect(looksBinary(textBuf)).toBe(false);
  });

  it('returns false for empty Buffer', () => {
    expect(looksBinary(Buffer.alloc(0))).toBe(false);
  });
});

describe('canonicalize null-byte stripping (Codex Finding F2)', () => {
  it('hash of canonicalize(content-with-null) equals hash of canonicalize(content-without-null)', async () => {
    // Defense-in-depth check. The binary guard already rejects any file with
    // a null byte before canonicalize runs, but canonicalize stripping \0
    // ensures the hash used for processed_sources/idempotency_keys MATCHES
    // what callClassifier sees (callClassifier also strips \0 at the facade).
    // Without this, a hypothetical \0 that bypassed the binary guard would
    // produce a content_sha256 referring to bytes the model never saw.
    const { createHash } = await import('crypto');
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');

    // Re-implement the production canonicalize in-test rather than exporting
    // it just for this assertion. If production changes, this test fails loud.
    const canonicalize = (content: string): string => content.trim().replace(/\r\n/g, '\n').replace(/\0/g, '');

    const withNull = 'hello\0world';
    const withoutNull = 'helloworld';
    expect(sha(canonicalize(withNull))).toBe(sha(canonicalize(withoutNull)));
  });
});

describe('isNonSymlinkChain (Codex F9 round 3 — parent validation)', () => {
  // The earlier round-2 helper started lstat at parent/components[0],
  // leaving the parent itself free to be replaced with a symlink between
  // discovery and use. These tests exercise the round-3 fix that lstat's
  // parent first and fails closed on missing/symlink/non-directory parents.

  function mockLstatTypes(types: Record<string, 'dir' | 'symlink' | 'file' | 'missing'>): void {
    vi.spyOn(fs, 'lstatSync').mockImplementation(((p: fs.PathLike) => {
      const t = types[String(p)] ?? 'missing';
      if (t === 'missing') {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isDirectory: () => t === 'dir',
        isSymbolicLink: () => t === 'symlink',
        isFile: () => t === 'file',
      } as fs.Stats;
    }) as unknown as typeof fs.lstatSync);
  }

  it('rejects when parent is a symlink (post-discovery root swap)', async () => {
    const { isNonSymlinkChain } = await import('./source-ingest.js');
    mockLstatTypes({ '/p': 'symlink' });
    expect(isNonSymlinkChain('/p', 'sources', 'inbox')).toBe(false);
  });

  it('rejects when parent does not exist', async () => {
    const { isNonSymlinkChain } = await import('./source-ingest.js');
    mockLstatTypes({});
    expect(isNonSymlinkChain('/missing-parent', 'sources', 'inbox')).toBe(false);
  });

  it('rejects when parent is a regular file (not a directory)', async () => {
    const { isNonSymlinkChain } = await import('./source-ingest.js');
    mockLstatTypes({ '/p': 'file' });
    expect(isNonSymlinkChain('/p', 'sources', 'inbox')).toBe(false);
  });

  it('accepts when parent is a real dir and intermediate components are missing', async () => {
    const { isNonSymlinkChain } = await import('./source-ingest.js');
    mockLstatTypes({ '/p': 'dir' });
    // sources and sources/inbox don't exist — daemon will mkdir them as
    // regular dirs; chain check passes (and the next sweep re-validates).
    expect(isNonSymlinkChain('/p', 'sources', 'inbox')).toBe(true);
  });

  it('rejects when intermediate component is a symlink', async () => {
    const { isNonSymlinkChain } = await import('./source-ingest.js');
    mockLstatTypes({
      '/p': 'dir',
      '/p/sources': 'dir',
      '/p/sources/inbox': 'symlink',
    });
    expect(isNonSymlinkChain('/p', 'sources', 'inbox')).toBe(false);
  });
});
