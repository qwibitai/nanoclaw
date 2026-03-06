import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Shared mock state that tests can configure
let mockItems: Array<{
  uuid: string;
  title: string;
  notes: string | null;
  project_title: string;
  creationDate: number;
}> = [];
let mockGetFn: (uuid: string) => unknown = () => undefined;

vi.mock('better-sqlite3', () => {
  return {
    default: class MockDatabase {
      pragma() {}
      close() {}
      prepare() {
        return {
          all: () => mockItems,
          get: (uuid: string) => mockGetFn(uuid),
        };
      }
    },
  };
});

vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: (err: Error | null) => void) => cb(null)),
}));

import { syncThingsToExocortex } from './things-sync.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'things-sync-test-'));
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

const MOCK_ITEMS = [
  {
    uuid: 'item-1',
    title: 'First task',
    notes: null,
    project_title: 'NanoClaw',
    creationDate: 1709337600,
  },
  {
    uuid: 'item-2',
    title: 'Second task',
    notes: 'Some notes',
    project_title: 'NanoClaw',
    creationDate: 1709337601,
  },
  {
    uuid: 'item-3',
    title: 'Third task',
    notes: null,
    project_title: 'NanoClaw',
    creationDate: 1709337602,
  },
];

describe('syncThingsToExocortex', () => {
  let tmpDir: string;
  let ingestDir: string;
  let configPath: string;
  let inboxPath: string;
  let ingestedPath: string;
  let syncStatePath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    ingestDir = path.join(tmpDir, 'ingest');
    configPath = path.join(ingestDir, '.things_config.json');
    inboxPath = path.join(ingestDir, 'things_inbox.json');
    ingestedPath = path.join(ingestDir, '.things_ingested.json');
    syncStatePath = path.join(ingestDir, '.things_sync_state.json');
    mockItems = MOCK_ITEMS;
    mockGetFn = () => undefined;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes new items to things_inbox.json on first sync', async () => {
    writeJson(configPath, {
      projects: [
        { uuid: 'proj-1', name: 'NanoClaw', ingestedHeadingUuid: 'heading-1' },
      ],
    });

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    const inbox = readJson(inboxPath) as Array<{ uuid: string }>;
    expect(inbox).toHaveLength(3);
    expect(inbox.map((i) => i.uuid)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  it('does not add duplicate items to inbox', async () => {
    writeJson(configPath, {
      projects: [
        { uuid: 'proj-1', name: 'NanoClaw', ingestedHeadingUuid: 'heading-1' },
      ],
    });

    // Pre-populate inbox with item-1
    writeJson(inboxPath, [
      {
        uuid: 'item-1',
        title: 'First task',
        notes: null,
        project_title: 'NanoClaw',
        creationDate: '2024-03-02T00:00:00.000Z',
      },
    ]);

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    const inbox = readJson(inboxPath) as Array<{ uuid: string }>;
    expect(inbox).toHaveLength(3); // 1 existing + 2 new
    const item1Count = inbox.filter((i) => i.uuid === 'item-1').length;
    expect(item1Count).toBe(1);
  });

  it('clears ingested items from inbox queue', async () => {
    writeJson(configPath, {
      projects: [
        { uuid: 'proj-1', name: 'NanoClaw', ingestedHeadingUuid: 'heading-1' },
      ],
    });

    // Inbox has 3 items
    writeJson(inboxPath, [
      { uuid: 'item-1', title: 'First', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
      { uuid: 'item-2', title: 'Second', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
      { uuid: 'item-3', title: 'Third', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
    ]);

    // Agent has marked all 3 as ingested
    writeJson(ingestedPath, ['item-1', 'item-2', 'item-3']);

    // Sync state already has all items (no new items from DB)
    writeJson(syncStatePath, {
      lastSyncUuids: ['item-1', 'item-2', 'item-3'],
      lastSyncTime: '2024-03-02T00:00:00.000Z',
    });

    // Mock DB needs to find items and their projects
    mockGetFn = (uuid: string) => {
      if (['item-1', 'item-2', 'item-3'].includes(uuid)) {
        return { project: 'proj-1' };
      }
      return undefined;
    };

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    // Inbox should be empty — all items were ingested and cleared
    const inbox = readJson(inboxPath) as Array<{ uuid: string }>;
    expect(inbox).toHaveLength(0);

    // Ingested file should be cleared
    const ingested = readJson(ingestedPath) as string[];
    expect(ingested).toHaveLength(0);
  });

  it('only removes ingested items, keeps unprocessed ones', async () => {
    writeJson(configPath, {
      projects: [
        { uuid: 'proj-1', name: 'NanoClaw', ingestedHeadingUuid: 'heading-1' },
      ],
    });

    // Inbox has 3 items
    writeJson(inboxPath, [
      { uuid: 'item-1', title: 'First', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
      { uuid: 'item-2', title: 'Second', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
      { uuid: 'item-3', title: 'Third', notes: null, project_title: 'NanoClaw', creationDate: '2024-03-02T00:00:00.000Z' },
    ]);

    // Agent only ingested item-1 and item-2
    writeJson(ingestedPath, ['item-1', 'item-2']);

    writeJson(syncStatePath, {
      lastSyncUuids: ['item-1', 'item-2', 'item-3'],
      lastSyncTime: '2024-03-02T00:00:00.000Z',
    });

    mockGetFn = (uuid: string) => {
      if (['item-1', 'item-2'].includes(uuid)) {
        return { project: 'proj-1' };
      }
      return undefined;
    };

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    // Only item-3 should remain in inbox
    const inbox = readJson(inboxPath) as Array<{ uuid: string }>;
    expect(inbox).toHaveLength(1);
    expect(inbox[0].uuid).toBe('item-3');
  });

  it('handles no ingested items gracefully', async () => {
    writeJson(configPath, {
      projects: [
        { uuid: 'proj-1', name: 'NanoClaw', ingestedHeadingUuid: 'heading-1' },
      ],
    });

    writeJson(syncStatePath, {
      lastSyncUuids: ['item-1', 'item-2', 'item-3'],
      lastSyncTime: '2024-03-02T00:00:00.000Z',
    });

    writeJson(ingestedPath, []);

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    // Should not crash
  });

  it('skips sync when no projects configured', async () => {
    writeJson(configPath, { projects: [] });

    await syncThingsToExocortex(tmpDir, '/fake/db', 'token');

    expect(fs.existsSync(inboxPath)).toBe(false);
  });
});
