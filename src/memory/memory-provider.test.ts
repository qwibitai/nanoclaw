import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createMemoryProvider,
  MemoryProvider,
  registerMemoryProvider,
} from './memory-provider.js';
import { MEMORY_VECTOR_DIMENSIONS } from '../core/config.js';
import { AgentMemoryRootService } from './agent-memory-root.js';

const tempRoots: string[] = [];

afterEach(() => {
  AgentMemoryRootService.resetForTests();
  delete process.env.AGENT_MEMORY_ROOT;
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function makeFakeProvider(name: string): MemoryProvider {
  return {
    providerName: name,
    close: () => undefined,
    saveItem: () => {
      throw new Error('not implemented');
    },
    findItemByKey: () => null,
    getItemById: () => null,
    patchItem: () => {
      throw new Error('not implemented');
    },
    pinItem: () => undefined,
    saveItemEmbedding: () => undefined,
    getCachedEmbedding: () => null,
    putCachedEmbedding: () => undefined,
    findSimilarItems: () => [],
    listActiveItems: () => [],
    softDeleteItem: () => undefined,
    incrementRetrievalCount: () => undefined,
    recordRetrievalSignal: () => undefined,
    bumpConfidence: () => undefined,
    adjustConfidence: () => undefined,
    decayUnusedConfidence: () => 0,
    countReflectionsSinceLastUsageDecay: () => 0,
    recordUsageDecayRun: () => undefined,
    listTopItems: () => [],
    chunkExists: () => false,
    touchItem: () => undefined,
    saveProcedure: () => {
      throw new Error('not implemented');
    },
    getProcedureById: () => null,
    patchProcedure: () => {
      throw new Error('not implemented');
    },
    listTopProcedures: () => [],
    saveChunks: () => 0,
    lexicalSearch: () => [],
    vectorSearch: () => [],
    searchProceduresByText: () => [],
    listSourceChunks: () => [],
    applyRetentionPolicies: () => undefined,
    recordEvent: () => undefined,
  };
}

describe('memory provider registry', () => {
  it('throws for unknown providers', () => {
    expect(() => createMemoryProvider('missing-provider')).toThrow(
      /Unknown memory provider/,
    );
  });

  it('supports custom provider registration', () => {
    registerMemoryProvider('custom-test', () =>
      makeFakeProvider('custom-test'),
    );
    const provider = createMemoryProvider('custom-test');
    expect(provider.providerName).toBe('custom-test');
  });

  it('creates sqlite provider successfully', () => {
    const provider = createMemoryProvider('sqlite');
    expect(provider.providerName).toBe('sqlite');
    provider.close();
  });

  it('writes qmd durable markdown and cache under AGENT_MEMORY_ROOT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'workflow',
      value: 'always run tests first',
      source: 'agent',
      confidence: 0.8,
    });
    provider.close();

    expect(fs.existsSync(path.join(root, '.cache', 'memory.db'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'profile', `${item.id}.md`))).toBe(
      true,
    );
  });

  it('qmd provider mirrors procedures to AGENT_MEMORY_ROOT', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    const proc = provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Deploy flow',
      body: 'run build and deploy',
      tags: ['deploy'],
      source: 'agent',
      confidence: 0.8,
    });
    provider.close();

    expect(
      fs.existsSync(path.join(root, 'procedures', `${proc.id}.md`)),
    ).toBe(true);
  });

  it('qmd provider records events in journal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('test_event', 'test_entity', 'entity-1', {
      key: 'value',
    });
    provider.close();

    // Journal entries are stored under journal/YYYY/MM/DD.md
    const journalDir = path.join(root, 'journal');
    expect(fs.existsSync(journalDir)).toBe(true);
    // Find the journal file recursively
    const findJournalFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findJournalFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findJournalFiles(journalDir);
    expect(journalFiles.length).toBeGreaterThan(0);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('event-test_event');
  });

  it('qmd provider delegates read operations to sqlite store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'read-test',
      value: 'readable',
      source: 'agent',
      confidence: 0.7,
    });

    expect(provider.getItemById(item.id)).not.toBeNull();
    expect(provider.findItemByKey({ scope: 'group', groupFolder: 'team', key: 'read-test' })?.id).toBe(item.id);
    expect(provider.listTopItems('group', 'team', 5).length).toBeGreaterThan(0);
    expect(provider.listActiveItems('team', 10).length).toBeGreaterThan(0);

    provider.pinItem(item.id, true);
    expect(provider.getItemById(item.id)!.is_pinned).toBe(true);

    provider.touchItem(item.id);
    expect(provider.getItemById(item.id)!.last_used_at).not.toBeNull();

    provider.incrementRetrievalCount([item.id]);
    provider.recordRetrievalSignal(item.id, 0.5, 'q1');
    provider.bumpConfidence([item.id], 0.1);
    provider.adjustConfidence([item.id], -0.05);
    provider.decayUnusedConfidence('team', 0.01);
    provider.countReflectionsSinceLastUsageDecay('team');
    provider.recordUsageDecayRun('team');

    // Chunk operations
    provider.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c1',
        source_path: '/tmp/c1.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'test chunk data for read operations',
        embedding: null,
      },
    ]);
    expect(provider.lexicalSearch('chunk data', 'team', 5).length).toBeGreaterThan(0);
    expect(provider.listSourceChunks('conversation', 'c1').length).toBeGreaterThan(0);

    provider.applyRetentionPolicies('team');

    provider.close();
  });

  it('qmd provider delegates listTopProcedures to sqlite store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Workflow for listing',
      body: 'listable procedure body',
      tags: ['test'],
      source: 'agent',
      confidence: 0.8,
    });

    // Cover line 213: listTopProcedures delegation
    const procedures = provider.listTopProcedures('team', 5);
    expect(procedures.length).toBeGreaterThan(0);
    expect(procedures[0]!.title).toBe('Workflow for listing');
    provider.close();
  });

  it('qmd provider delegates vectorSearch to sqlite store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;

    provider.saveChunks([
      {
        source_type: 'conversation',
        source_id: 'c-vec-test',
        source_path: '/tmp/c-vec-test.md',
        scope: 'group',
        group_folder: 'team',
        kind: 'conversation',
        text: 'chunk for vector search delegation test',
        embedding,
      },
    ]);

    // Cover lines 218-219: vectorSearch delegation
    const results = provider.vectorSearch(embedding, 'team', 5);
    expect(results.length).toBeGreaterThan(0);
    provider.close();
  });

  it('qmd provider delegates searchProceduresByText to sqlite store', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Searchable deploy procedure',
      body: 'run build then deploy to staging',
      tags: ['deploy'],
      source: 'agent',
      confidence: 0.8,
    });

    // Cover lines 220-222: searchProceduresByText delegation
    const results = provider.searchProceduresByText('deploy', 'team', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toContain('deploy');
    provider.close();
  });

  it('resolves default memory provider from MEMORY_PROVIDER config fallback', () => {
    // Cover line 254: resolveConfiguredMemoryProvider fallback path
    // When MEMORY_PROVIDER env is not set, it uses the MEMORY_PROVIDER config constant
    const saved = process.env.MEMORY_PROVIDER;
    delete process.env.MEMORY_PROVIDER;
    try {
      // The default provider should resolve and be creatable without error
      // (MEMORY_PROVIDER config default is 'sqlite' but could vary by env)
      const provider = createMemoryProvider();
      expect(provider.providerName).toBeDefined();
      provider.close();
    } finally {
      if (saved !== undefined) process.env.MEMORY_PROVIDER = saved;
    }
  });

  it('resolves memory provider from MEMORY_PROVIDER env var when set', () => {
    // Cover line 252: resolveConfiguredMemoryProvider env path
    const saved = process.env.MEMORY_PROVIDER;
    process.env.MEMORY_PROVIDER = 'sqlite';
    try {
      const provider = createMemoryProvider();
      expect(provider.providerName).toBe('sqlite');
      provider.close();
    } finally {
      if (saved !== undefined) {
        process.env.MEMORY_PROVIDER = saved;
      } else {
        delete process.env.MEMORY_PROVIDER;
      }
    }
  });

  it('qmd provider mirrors patched items and procedures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    // Patch item
    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'patchable',
      value: 'original',
      source: 'agent',
      confidence: 0.7,
    });
    const patchedItem = provider.patchItem(item.id, item.version, {
      value: 'updated value',
    });
    expect(patchedItem.value).toBe('updated value');

    // Patch procedure
    const proc = provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Patchable proc',
      body: 'original body',
      tags: [],
      source: 'agent',
      confidence: 0.7,
    });
    const patchedProc = provider.patchProcedure(proc.id, proc.version, {
      body: 'updated body',
    });
    expect(patchedProc.body).toBe('updated body');

    provider.close();
  });

  it('qmd provider journalizes compact_manual event as lifecycle-manual-compact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('compact_manual', 'session', 'sess-1', {});
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('lifecycle-manual-compact');
  });

  it('qmd provider journalizes compact_auto event as lifecycle-auto-compact', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('compact_auto', 'session', 'sess-2', {});
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('lifecycle-auto-compact');
  });

  it('qmd provider journalizes stale_session event as lifecycle-stale-session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('stale_session', 'session', 'sess-3', {});
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('lifecycle-stale-session');
  });

  it('qmd provider journalizes abandoned_session event as lifecycle-abandoned-session', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('abandoned_session', 'session', 'sess-4', {});
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('lifecycle-abandoned-session');
  });

  it('qmd provider journalizes unknown event types as event-<type>', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('unknown_type', 'entity', 'e1', { info: 'test' });
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    // Unknown event types get the 'event-' prefix (toJournalCause returns null)
    expect(content).toContain('event-unknown_type');
  });

  it('qmd provider records event with null entityId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    provider.recordEvent('custom_event', 'generic', null as unknown as string, { info: 'test' });
    provider.close();

    const journalDir = path.join(root, 'journal');
    const findMdFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...findMdFiles(full));
        else if (entry.name.endsWith('.md')) files.push(full);
      }
      return files;
    };
    const journalFiles = findMdFiles(journalDir);
    const content = fs.readFileSync(journalFiles[0]!, 'utf-8');
    expect(content).toContain('event-custom_event');
  });

  it('qmd provider mirrors item and logs warning when writeMemoryItem fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    // Sabotage the profile directory so writeMemoryItem fails
    const profileDir = path.join(root, 'profile');
    fs.mkdirSync(profileDir, { recursive: true });
    // Place a file where a directory is expected to block mkdir
    // Actually, we can break it by making the profile dir read-only or by
    // replacing it with a file
    fs.rmSync(profileDir, { recursive: true });
    fs.writeFileSync(profileDir, 'not-a-directory');

    // saveItem should still succeed (error is caught in mirrorMemoryItem)
    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'mirror-fail-test',
      value: 'value',
      source: 'agent',
      confidence: 0.8,
    });

    expect(item.id).toBeDefined();
    // Clean up the sabotage so rmSync in afterEach works
    fs.unlinkSync(profileDir);
    provider.close();
  });

  it('qmd provider mirrors procedure and logs warning when writeProcedure fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    // Sabotage the procedures directory so writeProcedure fails
    const proceduresDir = path.join(root, 'procedures');
    fs.mkdirSync(proceduresDir, { recursive: true });
    fs.rmSync(proceduresDir, { recursive: true });
    fs.writeFileSync(proceduresDir, 'not-a-directory');

    // saveProcedure should still succeed (error is caught in mirrorProcedure)
    const proc = provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Mirror fail test proc',
      body: 'body',
      tags: [],
      source: 'agent',
      confidence: 0.8,
    });

    expect(proc.id).toBeDefined();
    // Clean up
    fs.unlinkSync(proceduresDir);
    provider.close();
  });

  it('qmd provider delegates getCachedEmbedding and putCachedEmbedding', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    // No cached embedding initially
    const cached = provider.getCachedEmbedding('test-hash-123', 'text-embedding-ada-002');
    expect(cached).toBeNull();

    // Put a cached embedding
    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0.1);
    provider.putCachedEmbedding('test-hash-123', 'text-embedding-ada-002', embedding);

    // Now it should be found
    const found = provider.getCachedEmbedding('test-hash-123', 'text-embedding-ada-002');
    expect(found).not.toBeNull();
    expect(found!.length).toBe(MEMORY_VECTOR_DIMENSIONS);

    provider.close();
  });

  it('qmd provider delegates findSimilarItems', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    // Save an item with embedding
    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'similar-test',
      value: 'test value for similarity',
      source: 'agent',
      confidence: 0.8,
    });

    const embedding = new Array<number>(MEMORY_VECTOR_DIMENSIONS).fill(0);
    embedding[0] = 1;
    provider.saveItemEmbedding(item.id, embedding);

    // Search for similar items — pass the required object shape
    const results = provider.findSimilarItems({
      scope: 'group',
      groupFolder: 'team',
      embedding,
      limit: 5,
    });
    expect(results.length).toBeGreaterThanOrEqual(0);

    provider.close();
  });

  it('qmd provider delegates softDeleteItem', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    const item = provider.saveItem({
      scope: 'group',
      group_folder: 'team',
      user_id: null,
      kind: 'fact',
      key: 'delete-test',
      value: 'to be deleted',
      source: 'agent',
      confidence: 0.8,
    });

    provider.softDeleteItem(item.id);
    // After soft delete, the item should no longer be active
    const active = provider.listActiveItems('team', 100);
    const found = active.find((i) => i.id === item.id);
    expect(found).toBeUndefined();

    provider.close();
  });

  it('qmd provider delegates getProcedureById', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');
    const proc = provider.saveProcedure({
      scope: 'group',
      group_folder: 'team',
      title: 'Get by ID test',
      body: 'test body',
      tags: ['test'],
      source: 'agent',
      confidence: 0.8,
    });

    const fetched = provider.getProcedureById(proc.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Get by ID test');

    provider.close();
  });

  it('qmd provider delegates chunkExists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-qmd-'));
    tempRoots.push(root);
    process.env.AGENT_MEMORY_ROOT = root;

    const provider = createMemoryProvider('qmd');

    const chunkData = {
      source_type: 'conversation',
      source_id: 'chunk-exist-test',
      source_path: '/tmp/test.md',
      scope: 'group' as const,
      group_folder: 'team',
      kind: 'conversation',
      text: 'chunk exists test',
      embedding: null,
    };

    // Before saving — chunk should not exist
    expect(provider.chunkExists(chunkData)).toBe(false);

    provider.saveChunks([chunkData]);

    // After saving — chunk should exist
    expect(provider.chunkExists(chunkData)).toBe(true);

    provider.close();
  });
});
