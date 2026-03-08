/**
 * End-to-end pipeline test.
 *
 * Tests the full flow: ingest Things items → create fleeting notes →
 * build daily note section → parse decisions → route → verify integrity.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseFrontmatter } from './daily-note.js';
import { runPipeline, _resetPipelineForTests } from './index.js';
import { runIntegrityChecks } from './integrity.js';
import { clearRegistryCache } from './registry.js';
import { parseDecisions, processDecisions } from './route.js';
import { collectUnprocessedNotes } from './daily-note.js';

// Mock the things CLI completion
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

let tmpDir: string;
let vaultPath: string;
let thingsDbPath: string;

function createThingsDb(
  items: Array<Record<string, unknown>>,
): string {
  const dbPath = path.join(tmpDir, 'things.sqlite');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE TMTask (
      uuid TEXT PRIMARY KEY,
      title TEXT,
      notes TEXT,
      creationDate REAL,
      type INTEGER DEFAULT 0,
      status INTEGER DEFAULT 0,
      trashed INTEGER DEFAULT 0,
      todayIndex INTEGER,
      project TEXT,
      heading TEXT
    )
  `);
  const insertWithToday = db.prepare(
    'INSERT INTO TMTask (uuid, title, notes, creationDate, type, status, trashed, todayIndex) VALUES (?, ?, ?, ?, 0, 0, 0, ?)',
  );
  const insertWithoutToday = db.prepare(
    'INSERT INTO TMTask (uuid, title, notes, creationDate, type, status, trashed) VALUES (?, ?, ?, ?, 0, 0, 0)',
  );
  for (const item of items) {
    if (item.todayIndex === null || item.todayIndex === undefined) {
      insertWithoutToday.run(
        item.uuid,
        item.title,
        item.notes || null,
        item.creationDate,
      );
    } else {
      insertWithToday.run(
        item.uuid,
        item.title,
        item.notes || null,
        item.creationDate,
        item.todayIndex,
      );
    }
  }
  db.close();
  return dbPath;
}

function createRegistry(vaultDir: string): void {
  const registryDir = path.join(vaultDir, '1. Projects');
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, 'registry.md'),
    `# Project Registry

## Networking
- **aliases:** networking, people
- **vault:** \`2. Areas/Networking/\`
- **status:** active
- **routing:** @networking, @people, Pedro, Adam

## Chores
- **aliases:** chores, personal
- **vault:** \`1. Projects/Chores/\`
- **status:** active
- **routing:** @chores, @personal, insurance, pills

## NanoClaw
- **aliases:** nanoclaw, claw
- **vault:** \`1. Projects/AI Assistant/\`
- **status:** active
- **routing:** @nanoclaw, @claw
`,
  );
}

function createDailyNote(vaultDir: string): string {
  const now = new Date();
  const year = String(now.getFullYear());
  const monthNum = String(now.getMonth() + 1).padStart(2, '0');
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const monthName = months[now.getMonth()];
  const dayNum = String(now.getDate()).padStart(2, '0');
  const days = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
  ];
  const dayName = days[now.getDay()];

  const monthDir = path.join(
    vaultDir,
    '0a. Daily Notes',
    year,
    `${monthNum}-${monthName}`,
  );
  fs.mkdirSync(monthDir, { recursive: true });
  const filePath = path.join(
    monthDir,
    `${year}-${monthNum}-${dayNum}-${dayName}.md`,
  );
  fs.writeFileSync(filePath, `# ${year}-${monthNum}-${dayNum}\n\nDaily note content.\n`);
  return filePath;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-test-'));
  vaultPath = path.join(tmpDir, 'vault');
  fs.mkdirSync(vaultPath, { recursive: true });
  createRegistry(vaultPath);
  clearRegistryCache();
  _resetPipelineForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('end-to-end pipeline', () => {
  it('ingests Things items and builds daily note section', async () => {
    // Setup: Things DB with items in Today
    thingsDbPath = createThingsDb([
      {
        uuid: 'pedro-uuid',
        title: 'Reply to Pedro',
        notes: 'About the workshop next week',
        creationDate: 1772604800, // ~2026-03-02
        todayIndex: 0,
      },
      {
        uuid: 'insurance-uuid',
        title: 'Resubmit insurance claim',
        notes: '',
        creationDate: 1772604800,
        todayIndex: 1,
      },
      {
        uuid: 'claw-uuid',
        title: '@nanoclaw fix the sync',
        notes: 'The fleeting notes pipeline has a bug',
        creationDate: 1772604800,
        todayIndex: 2,
      },
    ]);

    // Create daily note for today
    const dailyNotePath = createDailyNote(vaultPath);

    // Run pipeline
    const result = await runPipeline(
      vaultPath,
      thingsDbPath,
      'test-token',
    );

    // Verify ingestion
    expect(result.ingest.created).toHaveLength(3);
    expect(result.ingest.created.map((n) => n.title)).toContain('Reply to Pedro');
    expect(result.ingest.created.map((n) => n.title)).toContain('Resubmit insurance claim');
    expect(result.ingest.created.map((n) => n.title)).toContain('@nanoclaw fix the sync');

    // Verify project detection
    const pedro = result.ingest.created.find(
      (n) => n.title === 'Reply to Pedro',
    );
    expect(pedro?.project).toBe('Networking');

    const insurance = result.ingest.created.find(
      (n) => n.title === 'Resubmit insurance claim',
    );
    expect(insurance?.project).toBe('Chores');

    const claw = result.ingest.created.find(
      (n) => n.title === '@nanoclaw fix the sync',
    );
    expect(claw?.project).toBe('NanoClaw');

    // Verify fleeting note files exist
    for (const note of result.ingest.created) {
      const absPath = path.join(vaultPath, note.path);
      expect(fs.existsSync(absPath)).toBe(true);
      const content = fs.readFileSync(absPath, 'utf-8');
      expect(content).toContain('status: raw');
      expect(content).toContain(`# ${note.title}`);
    }

    // Verify daily note was updated
    expect(result.dailyNoteUpdated).toBe(true);
    expect(result.unprocessedCount).toBe(3);

    const dailyContent = fs.readFileSync(dailyNotePath, 'utf-8');
    expect(dailyContent).toContain('<!-- fleeting-start -->');
    expect(dailyContent).toContain('<!-- fleeting-end -->');
    expect(dailyContent).toContain('Unprocessed (3 from things)');
    expect(dailyContent).toContain('**Reply to Pedro**');
    expect(dailyContent).toContain('**Resubmit insurance claim**');
    expect(dailyContent).toContain('|f-note]]');
  });

  it('is idempotent — re-running does not duplicate', async () => {
    thingsDbPath = createThingsDb([
      {
        uuid: 'u1',
        title: 'Test item',
        creationDate: 1772604800,
        todayIndex: 0,
      },
    ]);
    createDailyNote(vaultPath);

    // First run
    const result1 = await runPipeline(vaultPath, thingsDbPath, 'token');
    expect(result1.ingest.created).toHaveLength(1);

    // Second run — same items should be deduplicated
    const result2 = await runPipeline(vaultPath, thingsDbPath, 'token');
    expect(result2.ingest.created).toHaveLength(0);
    expect(result2.ingest.skipped).toHaveLength(1);

    // Daily note should still have exactly 1 unprocessed
    expect(result2.unprocessedCount).toBe(1);
  });

  it('handles empty Things Today', async () => {
    thingsDbPath = createThingsDb([]);
    createDailyNote(vaultPath);

    const result = await runPipeline(vaultPath, thingsDbPath, 'token');
    expect(result.ingest.created).toHaveLength(0);
    expect(result.unprocessedCount).toBe(0);
    expect(result.dailyNoteUpdated).toBe(true);
  });

  it('handles missing daily note gracefully', async () => {
    thingsDbPath = createThingsDb([
      {
        uuid: 'u1',
        title: 'Test',
        creationDate: 1772604800,
        todayIndex: 0,
      },
    ]);
    // No daily note created

    const result = await runPipeline(vaultPath, thingsDbPath, 'token');
    expect(result.ingest.created).toHaveLength(1);
    expect(result.dailyNoteUpdated).toBe(false);
  });

  it('full cycle: ingest → daily note → simulate accept → route → verify', async () => {
    // Stage 1: Ingest
    thingsDbPath = createThingsDb([
      {
        uuid: 'pedro-uuid',
        title: 'Reply to Pedro',
        notes: 'Workshop follow-up',
        creationDate: 1772604800,
        todayIndex: 0,
      },
    ]);
    const dailyNotePath = createDailyNote(vaultPath);

    const pipelineResult = await runPipeline(
      vaultPath,
      thingsDbPath,
      'test-token',
    );
    expect(pipelineResult.ingest.created).toHaveLength(1);

    // Stage 2: Read the daily note that was generated
    let dailyContent = fs.readFileSync(dailyNotePath, 'utf-8');
    expect(dailyContent).toContain('**Reply to Pedro**');

    // Stage 3: Simulate user accepting the item
    // Replace "- [ ] Accept" with "- [x] Accept"
    dailyContent = dailyContent.replace('- [ ] Accept', '- [x] Accept');
    fs.writeFileSync(dailyNotePath, dailyContent);

    // Parse and process decisions
    const notes = collectUnprocessedNotes(vaultPath);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Reply to Pedro');

    const routingResult = processDecisions(
      vaultPath,
      dailyContent,
      notes,
    );
    expect(routingResult.routed).toHaveLength(1);
    expect(routingResult.errors).toHaveLength(0);
    expect(routingResult.routed[0].action).toBe('accept');

    // Verify destination file was created
    const destPath = routingResult.routed[0].destinationPath;
    expect(destPath).toBeDefined();
    const destAbsPath = path.join(vaultPath, destPath!);
    expect(fs.existsSync(destAbsPath)).toBe(true);

    const destContent = fs.readFileSync(destAbsPath, 'utf-8');
    expect(destContent).toContain('# Reply to Pedro');
    expect(destContent).toContain('source: fleeting');

    // Verify fleeting note was updated
    const fleetingPath = path.join(vaultPath, notes[0].path);
    const fleetingContent = fs.readFileSync(fleetingPath, 'utf-8');
    expect(fleetingContent).toContain('status: completed');
    expect(fleetingContent).toContain('converted_to:');

    // Stage 4: Verify integrity after routing
    const integrity = runIntegrityChecks(vaultPath, {
      checkRaw: true,
    });
    // Should have no raw remaining (the one note was completed)
    const rawIssues = integrity.issues.filter(
      (i) => i.type === 'raw-remaining',
    );
    expect(rawIssues).toHaveLength(0);
  });

  it('full cycle: ingest → daily note → simulate retire → verify', async () => {
    thingsDbPath = createThingsDb([
      {
        uuid: 'test-uuid',
        title: 'test',
        notes: '',
        creationDate: 1772604800,
        todayIndex: 0,
      },
    ]);
    const dailyNotePath = createDailyNote(vaultPath);

    await runPipeline(vaultPath, thingsDbPath, 'test-token');

    // Simulate user retiring the item
    let dailyContent = fs.readFileSync(dailyNotePath, 'utf-8');
    dailyContent = dailyContent.replace('- [ ] Retire', '- [x] Retire');
    fs.writeFileSync(dailyNotePath, dailyContent);

    const notes = collectUnprocessedNotes(vaultPath);
    const routingResult = processDecisions(vaultPath, dailyContent, notes);

    expect(routingResult.routed).toHaveLength(1);
    expect(routingResult.routed[0].action).toBe('retire');

    // Verify fleeting note was retired
    const fleetingPath = path.join(vaultPath, notes[0].path);
    const fleetingContent = fs.readFileSync(fleetingPath, 'utf-8');
    expect(fleetingContent).toContain('status: retired');
  });

  it('routing proposal matches expected types', async () => {
    thingsDbPath = createThingsDb([
      // Action item with project → #task
      {
        uuid: 'u1',
        title: 'Reply to Pedro',
        notes: '',
        creationDate: 1772604800,
        todayIndex: 0,
      },
      // URL → literature note
      {
        uuid: 'u2',
        title: 'Read this article',
        notes: 'https://example.com/interesting',
        creationDate: 1772604800,
        todayIndex: 1,
      },
      // Non-action with project → permanent note
      {
        uuid: 'u3',
        title: '@nanoclaw observation about caching',
        notes: 'The cache invalidation strategy seems suboptimal for large vaults.',
        creationDate: 1772604800,
        todayIndex: 2,
      },
    ]);
    const dailyNotePath = createDailyNote(vaultPath);

    await runPipeline(vaultPath, thingsDbPath, 'test-token');

    const dailyContent = fs.readFileSync(dailyNotePath, 'utf-8');

    // Pedro → #task (action verb "reply" + project match "Pedro" → Networking)
    expect(dailyContent).toMatch(/Reply to Pedro.*\n[\s\S]*?#task/);

    // Article → Literature note
    expect(dailyContent).toMatch(/Read this article[\s\S]*?Literature note/);

    // NanoClaw observation → Permanent note
    expect(dailyContent).toMatch(
      /observation about caching[\s\S]*?Permanent note/,
    );
  });

  it('skips ingestion when skipIngest is true', async () => {
    // Create a fleeting note manually
    const noteDir = path.join(vaultPath, 'Fleeting', '2026', '03', '07');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(
      path.join(noteDir, 'manual-note.md'),
      '---\nsource: telegram\ncreated: 2026-03-07\nstatus: raw\n---\n\n# Manual Note\n\nSome content.\n',
    );
    createDailyNote(vaultPath);

    // No Things DB needed since we skip ingestion
    const result = await runPipeline(
      vaultPath,
      '/nonexistent.sqlite',
      'token',
      { skipIngest: true },
    );

    expect(result.ingest.created).toHaveLength(0);
    expect(result.unprocessedCount).toBe(1);
    expect(result.dailyNoteUpdated).toBe(true);
  });

  it('runs integrity checks when requested', async () => {
    thingsDbPath = createThingsDb([]);
    createDailyNote(vaultPath);

    // Create a bad todos.md
    const projectDir = path.join(vaultPath, '1. Projects', 'Test');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, 'todos.md'),
      "```tasks\nfilter by function task.tags.includes('#task')\n```",
    );

    const result = await runPipeline(
      vaultPath,
      thingsDbPath,
      'token',
      { runIntegrity: true },
    );

    expect(result.integrity.passed).toBe(false);
    expect(
      result.integrity.issues.some((i) => i.type === 'wrong-query-filter'),
    ).toBe(true);
  });
});
