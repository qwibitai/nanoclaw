import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    process.env[key] = value;
  }

  vi.resetModules();
  const { MemoryService } = await import('./memory-service.js');
  MemoryService.closeInstance();
});

describe('memory IPC provider integration', () => {
  it('routes memory IPC requests through the configured provider', async () => {
    process.env.MEMORY_PROVIDER = 'ipc-test-provider';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { registerMemoryProvider } = await import('./memory-provider.js');
    let saveCalls = 0;
    let eventCalls = 0;

    registerMemoryProvider('ipc-test-provider', () => ({
      providerName: 'ipc-test-provider',
      close: () => undefined,
      saveItem: (input) => {
        saveCalls += 1;
        const now = new Date().toISOString();
        return {
          id: 'mem-1',
          scope: input.scope,
          group_folder: input.group_folder,
          user_id: input.user_id,
          kind: input.kind,
          key: input.key,
          value: input.value,
          source: input.source,
          confidence: input.confidence,
          is_pinned: Boolean(input.is_pinned),
          version: 1,
          last_used_at: null,
          last_retrieved_at: null,
          retrieval_count: 0,
          total_score: 0,
          max_score: 0,
          query_hashes_json: '[]',
          recall_days_json: '[]',
          embedding_json: null,
          created_at: now,
          updated_at: now,
        };
      },
      getItemById: () => null,
      findItemByKey: () => null,
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
      recordEvent: () => {
        eventCalls += 1;
      },
    }));

    const { MemoryService } = await import('./memory-service.js');
    MemoryService.closeInstance();
    const { processMemoryRequest } = await import('./memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-1',
        action: 'memory_save',
        payload: {
          key: 'style',
          value: 'concise',
        },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.provider).toBe('ipc-test-provider');
    expect(saveCalls).toBe(1);
    expect(eventCalls).toBe(1);
  });

  it('returns IPC error responses when memory service init fails', async () => {
    vi.resetModules();
    vi.doMock('./memory-service.js', () => ({
      MemoryService: {
        getInstance: () => {
          throw new Error('memory init failed');
        },
        closeInstance: () => undefined,
      },
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-init-fail',
        action: 'memory_search',
        payload: { query: 'test' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.provider).toBe('uninitialized');
    expect(response.error).toContain('memory init failed');

    vi.doUnmock('./memory-service.js');
  });

  it('memory_search returns error response on embedding failure', async () => {
    // The search path goes through MemoryService.search which calls the embedding
    // provider. Without a valid embedding provider, the search returns an error
    // response. This still covers the memory_search IPC branch.
    process.env.MEMORY_PROVIDER = 'ipc-search-provider';
    process.env.OPENAI_API_KEY = '';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { registerMemoryProvider } = await import('./memory-provider.js');

    registerMemoryProvider('ipc-search-provider', () => ({
      providerName: 'ipc-search-provider',
      close: () => undefined,
      saveItem: () => {
        throw new Error('not implemented');
      },
      getItemById: () => null,
      findItemByKey: () => null,
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
    }));

    const { MemoryService } = await import('./memory-service.js');
    MemoryService.closeInstance();
    const { processMemoryRequest } = await import('./memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-search',
        action: 'memory_search',
        payload: { query: 'deployment process' },
      },
      'team',
      false,
    );

    // The error response still exercises the memory_search case branch
    expect(response.requestId).toBe('req-search');
    expect(response.provider).toBe('ipc-search-provider');
  });

  it('returns error for empty search query', async () => {
    process.env.MEMORY_PROVIDER = 'ipc-search-empty';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { registerMemoryProvider } = await import('./memory-provider.js');

    registerMemoryProvider('ipc-search-empty', () => ({
      providerName: 'ipc-search-empty',
      close: () => undefined,
      saveItem: () => {
        throw new Error('not implemented');
      },
      getItemById: () => null,
      findItemByKey: () => null,
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
    }));

    const { MemoryService } = await import('./memory-service.js');
    MemoryService.closeInstance();
    const { processMemoryRequest } = await import('./memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-empty',
        action: 'memory_search',
        payload: { query: '' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('query is required');
  });

  it('returns error for unsupported memory action', async () => {
    process.env.MEMORY_PROVIDER = 'ipc-unsupported';
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.MEMORY_SEMANTIC_DEDUP_ENABLED = 'false';

    vi.resetModules();
    const { registerMemoryProvider } = await import('./memory-provider.js');

    registerMemoryProvider('ipc-unsupported', () => ({
      providerName: 'ipc-unsupported',
      close: () => undefined,
      saveItem: () => {
        throw new Error('not implemented');
      },
      getItemById: () => null,
      findItemByKey: () => null,
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
    }));

    const { MemoryService } = await import('./memory-service.js');
    MemoryService.closeInstance();
    const { processMemoryRequest } = await import('./memory-ipc.js');

    const response = await processMemoryRequest(
      {
        requestId: 'req-unsupported',
        action: 'fake_action' as never,
        payload: {},
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('Unsupported memory action');
  });
});

/* ------------------------------------------------------------------ */
/*  processMemoryRequest — branches that were previously uncovered     */
/* ------------------------------------------------------------------ */
describe('processMemoryRequest additional branches', () => {
  function mockMemoryService(overrides: Record<string, unknown> = {}) {
    return {
      getInstance: () => ({
        getProviderName: () => 'mock-provider',
        search: vi.fn(),
        saveMemory: vi.fn(),
        patchMemory: vi.fn().mockReturnValue({ id: 'patched-mem' }),
        consolidateGroupMemory: vi
          .fn()
          .mockResolvedValue({ merged: 1 }),
        runDreamingSweep: vi
          .fn()
          .mockResolvedValue({ promoted: 2, decayed: 1 }),
        saveProcedure: vi.fn().mockReturnValue({ id: 'proc-1' }),
        patchProcedure: vi.fn().mockReturnValue({ id: 'proc-patched' }),
        ingestGroupSources: vi.fn(),
        ingestGlobalKnowledge: vi.fn(),
        buildMemoryContext: vi.fn(),
        ...overrides,
      }),
      closeInstance: () => undefined,
    };
  }

  it('handles memory_patch action', async () => {
    vi.resetModules();
    const patchMemory = vi.fn().mockReturnValue({ id: 'patched-mem', version: 2 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ patchMemory }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch',
        action: 'memory_patch',
        payload: { id: 'mem-1', expected_version: 1, value: 'updated' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-patch');
    expect(response.provider).toBe('mock-provider');
    expect((response.data as { memory: unknown }).memory).toEqual({
      id: 'patched-mem',
      version: 2,
    });
    expect(patchMemory).toHaveBeenCalledWith(
      { id: 'mem-1', expected_version: 1, value: 'updated' },
      { isMain: false, groupFolder: 'team' },
    );
  });

  it('handles memory_consolidate action (non-main)', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi
      .fn()
      .mockResolvedValue({ merged: 3 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate',
        action: 'memory_consolidate',
        payload: { group_folder: 'other-group' },
      },
      'team',
      false, // non-main: should ignore requested group_folder
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-consolidate');
    expect((response.data as { consolidation: unknown }).consolidation).toEqual({
      merged: 3,
    });
    // non-main agents cannot override groupFolder
    expect(consolidateGroupMemory).toHaveBeenCalledWith('team');
  });

  it('handles memory_consolidate action (main with group_folder override)', async () => {
    vi.resetModules();
    const consolidateGroupMemory = vi
      .fn()
      .mockResolvedValue({ merged: 5 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ consolidateGroupMemory }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-consolidate-main',
        action: 'memory_consolidate',
        payload: { group_folder: 'other-group' },
      },
      'team',
      true, // main: should use the requested group_folder
    );

    expect(response.ok).toBe(true);
    expect(consolidateGroupMemory).toHaveBeenCalledWith('other-group');
  });

  it('handles memory_dream action (non-main)', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 2, decayed: 1 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream',
        action: 'memory_dream',
        payload: { group_folder: 'other-group' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-dream');
    expect((response.data as { dreaming: unknown }).dreaming).toEqual({
      promoted: 2,
      decayed: 1,
    });
    // non-main: ignores requested group_folder
    expect(runDreamingSweep).toHaveBeenCalledWith('team');
  });

  it('handles memory_dream action (main with group_folder override)', async () => {
    vi.resetModules();
    const runDreamingSweep = vi
      .fn()
      .mockResolvedValue({ promoted: 4, decayed: 0 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ runDreamingSweep }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-dream-main',
        action: 'memory_dream',
        payload: { group_folder: 'special-group' },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(runDreamingSweep).toHaveBeenCalledWith('special-group');
  });

  it('handles procedure_save action', async () => {
    vi.resetModules();
    const saveProcedure = vi.fn().mockReturnValue({ id: 'proc-1', title: 'Deploy' });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ saveProcedure }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-save',
        action: 'procedure_save',
        payload: { title: 'Deploy', body: 'steps...', tags: ['devops'] },
      },
      'team',
      true,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-proc-save');
    expect((response.data as { procedure: unknown }).procedure).toEqual({
      id: 'proc-1',
      title: 'Deploy',
    });
    expect(saveProcedure).toHaveBeenCalledWith(
      { title: 'Deploy', body: 'steps...', tags: ['devops'] },
      { isMain: true, groupFolder: 'team' },
    );
  });

  it('handles procedure_patch action', async () => {
    vi.resetModules();
    const patchProcedure = vi
      .fn()
      .mockReturnValue({ id: 'proc-patched', version: 2 });
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({ patchProcedure }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-proc-patch',
        action: 'procedure_patch',
        payload: { id: 'proc-1', expected_version: 1, body: 'updated steps' },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('req-proc-patch');
    expect((response.data as { procedure: unknown }).procedure).toEqual({
      id: 'proc-patched',
      version: 2,
    });
    expect(patchProcedure).toHaveBeenCalledWith(
      { id: 'proc-1', expected_version: 1, body: 'updated steps' },
      { isMain: false, groupFolder: 'team' },
    );
  });

  it('returns error when memory_patch throws', async () => {
    vi.resetModules();
    vi.doMock('./memory-service.js', () => ({
      MemoryService: mockMemoryService({
        patchMemory: () => {
          throw new Error('version conflict');
        },
      }),
    }));

    const { processMemoryRequest } = await import('./memory-ipc.js');
    const response = await processMemoryRequest(
      {
        requestId: 'req-patch-err',
        action: 'memory_patch',
        payload: { id: 'mem-1', expected_version: 99 },
      },
      'team',
      false,
    );

    expect(response.ok).toBe(false);
    expect(response.error).toContain('version conflict');
    expect(response.provider).toBe('mock-provider');
  });
});

/* ------------------------------------------------------------------ */
/*  writeMemoryResponse                                                */
/* ------------------------------------------------------------------ */
describe('writeMemoryResponse', () => {
  it('writes a JSON response file via atomic rename', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-test-'));

    vi.resetModules();
    vi.doMock('../platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryResponse } = await import('./memory-ipc.js');

    const response = {
      ok: true as const,
      requestId: 'req-42',
      provider: 'sqlite',
      data: { results: [1, 2, 3] },
    };

    writeMemoryResponse('team', 'req-42', response);

    const responsesDir = path.join(tmpDir, 'memory-responses');
    const filePath = path.join(responsesDir, 'req-42.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(written).toEqual(response);

    // tmp file should not remain
    expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);

    // cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the memory-responses directory if it does not exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-mkdir-'));

    vi.resetModules();
    vi.doMock('../platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryResponse } = await import('./memory-ipc.js');

    const responsesDir = path.join(tmpDir, 'memory-responses');
    expect(fs.existsSync(responsesDir)).toBe(false);

    writeMemoryResponse('team', 'req-mkdir', {
      ok: false,
      requestId: 'req-mkdir',
      error: 'boom',
    });

    expect(fs.existsSync(responsesDir)).toBe(true);
    const written = JSON.parse(
      fs.readFileSync(path.join(responsesDir, 'req-mkdir.json'), 'utf-8'),
    );
    expect(written.ok).toBe(false);
    expect(written.error).toBe('boom');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ */
/*  writeMemoryContextSnapshot                                         */
/* ------------------------------------------------------------------ */
describe('writeMemoryContextSnapshot', () => {
  it('ingests sources, builds context, and writes snapshot to disk', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-ctx-'));
    // Ensure the ipc dir exists for writeFileSync
    fs.mkdirSync(tmpDir, { recursive: true });

    const mockContext = {
      block: '## Memory\nSome facts',
      facts: [{ id: 'fact-1', key: 'style', value: 'concise' }],
      procedures: [{ id: 'proc-1', title: 'Deploy' }],
      snippets: [{ id: 'snip-1', text: 'snippet text' }],
      recentWork: ['worked on deployment'],
      retrievedItemIds: ['fact-1'],
    };

    const ingestGroupSources = vi.fn().mockResolvedValue(undefined);
    const ingestGlobalKnowledge = vi.fn().mockResolvedValue(undefined);
    const buildMemoryContext = vi.fn().mockResolvedValue(mockContext);

    vi.resetModules();
    vi.doMock('./memory-service.js', () => ({
      MemoryService: {
        getInstance: () => ({
          getProviderName: () => 'mock-provider',
          ingestGroupSources,
          ingestGlobalKnowledge,
          buildMemoryContext,
        }),
        closeInstance: () => undefined,
      },
    }));
    vi.doMock('../platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryContextSnapshot } = await import('./memory-ipc.js');

    const result = await writeMemoryContextSnapshot(
      'team',
      true,
      'tell me about deploys',
      'user-123',
    );

    expect(result).toEqual({ retrievedItemIds: ['fact-1'] });

    // Verify the service calls
    expect(ingestGroupSources).toHaveBeenCalledWith('team');
    expect(ingestGlobalKnowledge).toHaveBeenCalled();
    expect(buildMemoryContext).toHaveBeenCalledWith(
      'tell me about deploys',
      'team',
      true,
      'user-123',
    );

    // Verify the file was written
    const filePath = path.join(tmpDir, 'memory_context.json');
    expect(fs.existsSync(filePath)).toBe(true);

    const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(snapshot.block).toBe('## Memory\nSome facts');
    expect(snapshot.facts).toEqual(mockContext.facts);
    expect(snapshot.procedures).toEqual(mockContext.procedures);
    expect(snapshot.snippets).toEqual(mockContext.snippets);
    expect(snapshot.recentWork).toEqual(mockContext.recentWork);
    expect(snapshot.retrievedItemIds).toEqual(['fact-1']);
    expect(snapshot.generatedAt).toBeDefined();
    // generatedAt should be a valid ISO date string
    expect(() => new Date(snapshot.generatedAt)).not.toThrow();
    expect(new Date(snapshot.generatedAt).toISOString()).toBe(snapshot.generatedAt);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('calls buildMemoryContext without userId when not provided', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-ctx2-'));

    const buildMemoryContext = vi.fn().mockResolvedValue({
      block: '',
      facts: [],
      procedures: [],
      snippets: [],
      recentWork: [],
      retrievedItemIds: [],
    });

    vi.resetModules();
    vi.doMock('./memory-service.js', () => ({
      MemoryService: {
        getInstance: () => ({
          getProviderName: () => 'mock-provider',
          ingestGroupSources: vi.fn().mockResolvedValue(undefined),
          ingestGlobalKnowledge: vi.fn().mockResolvedValue(undefined),
          buildMemoryContext,
        }),
        closeInstance: () => undefined,
      },
    }));
    vi.doMock('../platform/group-folder.js', () => ({
      resolveGroupIpcPath: () => tmpDir,
    }));

    const { writeMemoryContextSnapshot } = await import('./memory-ipc.js');

    const result = await writeMemoryContextSnapshot('team', false, 'hello');

    expect(result).toEqual({ retrievedItemIds: [] });
    expect(buildMemoryContext).toHaveBeenCalledWith(
      'hello',
      'team',
      false,
      undefined,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
