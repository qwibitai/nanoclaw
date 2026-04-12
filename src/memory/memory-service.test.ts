import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR, MEMORY_VECTOR_DIMENSIONS } from '../core/config.js';
import {
  EmbeddingProvider,
  OpenAIEmbeddingClient,
} from './memory-embeddings.js';
import { MemoryService } from './memory-service.js';
import { MemoryStore } from './memory-store.js';

const tempRoots: string[] = [];
const tempGroups: string[] = [];
const tempKnowledgeDirs: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  for (const groupDir of tempGroups.splice(0)) {
    fs.rmSync(groupDir, { recursive: true, force: true });
  }
  for (const dir of tempKnowledgeDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeService(): MemoryService {
  const embeddings = {
    isEnabled: () => true,
    validateConfiguration: () => undefined,
    embedMany: async (texts: string[]) =>
      texts.map((text) => vectorForText(text, MEMORY_VECTOR_DIMENSIONS)),
    embedOne: async (text: string) =>
      vectorForText(text, MEMORY_VECTOR_DIMENSIONS),
  } satisfies EmbeddingProvider;
  return makeServiceWithEmbeddings(embeddings);
}

function makeServiceWithEmbeddings(
  embeddings: EmbeddingProvider,
): MemoryService {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-svc-'));
  tempRoots.push(root);
  return new MemoryService(
    new MemoryStore(path.join(root, 'memory.db')),
    embeddings,
  );
}

function makeStoreOnly(): MemoryStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-memory-svc-'));
  tempRoots.push(root);
  return new MemoryStore(path.join(root, 'memory.db'));
}

function vectorForText(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  let seed = 0;
  for (const ch of text) seed = (seed * 31 + ch.charCodeAt(0)) % dimensions;
  vector[seed] = 1;
  return vector;
}

describe('MemoryService', () => {
  it('requires embeddings in no-fallback mode', () => {
    expect(
      () =>
        new MemoryService(
          makeStoreOnly(),
          new OpenAIEmbeddingClient(null, 'text-embedding-3-large'),
        ),
    ).toThrow(/OPENAI_API_KEY is required/);
  });

  it('blocks non-main global writes', async () => {
    const service = makeService();

    await expect(
      service.saveMemory(
        {
          scope: 'global',
          key: 'policy',
          value: 'always ask before deploy',
        },
        { isMain: false, groupFolder: 'team' },
      ),
    ).rejects.toThrow(/global memory writes/);
  });

  it('extracts preference facts during reflection', async () => {
    const service = makeService();

    await service.reflectAfterTurn({
      groupFolder: 'team',
      isMain: false,
      prompt: 'I prefer concise responses and call me Ravi.',
      result: 'Understood. I will keep it concise.',
    });

    const context = await service.buildMemoryContext(
      'keep concise responses',
      'team',
      false,
    );
    expect(context.facts.some((fact) => fact.kind === 'preference')).toBe(true);
  });

  it('skips recall embedding search for noise queries', async () => {
    let embedOneCalls = 0;
    const embeddings = {
      isEnabled: () => true,
      validateConfiguration: () => undefined,
      embedMany: async (texts: string[]) =>
        texts.map((text) => vectorForText(text, MEMORY_VECTOR_DIMENSIONS)),
      embedOne: async (text: string) => {
        embedOneCalls += 1;
        return vectorForText(text, MEMORY_VECTOR_DIMENSIONS);
      },
    } satisfies EmbeddingProvider;
    const service = makeServiceWithEmbeddings(embeddings);

    await service.saveMemory(
      {
        key: 'owner_name',
        value: 'Ravi',
      },
      { isMain: false, groupFolder: 'team' },
    );
    embedOneCalls = 0;
    service.saveProcedure(
      {
        title: 'Deploy checklist',
        body: 'run build, run tests, then deploy',
      },
      { isMain: false, groupFolder: 'team' },
    );

    const context = await service.buildMemoryContext('hi', 'team', false);
    expect(embedOneCalls).toBe(0);
    expect(context.facts.length).toBeGreaterThan(0);
    expect(context.procedures.length).toBeGreaterThan(0);
    expect(context.snippets).toHaveLength(0);
    expect(context.block).not.toContain('Recall Snippets:');
  });

  it('runs recall embedding search for substantive queries', async () => {
    let embedOneCalls = 0;
    const embeddings = {
      isEnabled: () => true,
      validateConfiguration: () => undefined,
      embedMany: async (texts: string[]) =>
        texts.map((text) => vectorForText(text, MEMORY_VECTOR_DIMENSIONS)),
      embedOne: async (text: string) => {
        embedOneCalls += 1;
        return vectorForText(text, MEMORY_VECTOR_DIMENSIONS);
      },
    } satisfies EmbeddingProvider;
    const service = makeServiceWithEmbeddings(embeddings);

    await service.buildMemoryContext(
      'what did we decide about release readiness?',
      'team',
      false,
    );
    expect(embedOneCalls).toBe(1);
  });

  it('renders recall snippets with source metadata and created date', async () => {
    const service = makeService();
    (
      service as unknown as { search: (input: unknown) => Promise<unknown> }
    ).search = async () => [
      {
        id: 'chunk-1',
        source_type: 'local_doc',
        source_path: '/tmp/docs/deploy-guide.md',
        text: 'blue green deploy checklist for release readiness',
        scope: 'group' as const,
        group_folder: 'team',
        created_at: '2026-03-15T10:00:00.000Z',
        lexical_score: 0.5,
        vector_score: 0.4,
        fused_score: 0.5,
      },
    ];

    const context = await service.buildMemoryContext(
      'blue green deploy checklist',
      'team',
      false,
    );

    expect(context.block).toContain('Recall Snippets:');
    expect(context.block).toMatch(
      /\[local_doc:deploy-guide\.md \d{4}-\d{2}-\d{2}\]/,
    );
    expect(context.block).not.toContain('/tmp/docs/deploy-guide.md');
  });

  it('ignores non-main group_folder overrides on writes', async () => {
    const service = makeService();

    const saved = await service.saveMemory(
      {
        group_folder: 'other-team',
        key: 'workflow',
        value: 'run tests first',
      },
      { isMain: false, groupFolder: 'team' },
    );

    expect(saved.group_folder).toBe('team');
  });

  it('deduplicates saveMemory by key within scope and group', async () => {
    const service = makeService();

    const first = await service.saveMemory(
      {
        key: 'deployment_policy',
        value: 'run build first',
        kind: 'fact',
        source: 'test',
      },
      { isMain: false, groupFolder: 'team' },
    );
    const second = await service.saveMemory(
      {
        key: 'deployment_policy',
        value: 'run build and tests',
        kind: 'correction',
        source: 'reflection',
      },
      { isMain: false, groupFolder: 'team' },
    );

    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version + 1);
    expect(second.value).toBe('run build and tests');
    expect(second.kind).toBe('correction');
    expect(second.source).toBe('reflection');
    const store = (service as unknown as { store: MemoryStore }).store;
    expect(store.listTopItems('group', 'team', 10)).toHaveLength(1);
  });

  it('deduplicates semantically similar facts on save', async () => {
    const embeddings = {
      isEnabled: () => true,
      validateConfiguration: () => undefined,
      embedMany: async (texts: string[]) =>
        texts.map(() =>
          vectorForText('semantic-same', MEMORY_VECTOR_DIMENSIONS),
        ),
      embedOne: async () =>
        vectorForText('semantic-same', MEMORY_VECTOR_DIMENSIONS),
    } satisfies EmbeddingProvider;
    const service = makeServiceWithEmbeddings(embeddings);

    const first = await service.saveMemory(
      {
        key: 'preference:concise-responses',
        value: 'Ravi prefers concise responses',
        kind: 'preference',
      },
      { isMain: false, groupFolder: 'team' },
    );
    const second = await service.saveMemory(
      {
        key: 'preference:brief-answers',
        value: 'Ravi likes brief answers',
        kind: 'preference',
      },
      { isMain: false, groupFolder: 'team' },
    );

    expect(second.id).toBe(first.id);
    const store = (service as unknown as { store: MemoryStore }).store;
    expect(store.listTopItems('group', 'team', 10)).toHaveLength(1);
  });

  it('blocks non-main cross-group memory patches', async () => {
    const service = makeService();

    const saved = await service.saveMemory(
      {
        key: 'workflow',
        value: 'run tests',
        group_folder: 'other-team',
      },
      { isMain: true, groupFolder: 'main' },
    );

    expect(() =>
      service.patchMemory(
        {
          id: saved.id,
          expected_version: saved.version,
          value: 'run tests and lint',
        },
        { isMain: false, groupFolder: 'team' },
      ),
    ).toThrow(/caller group/);
  });

  it('blocks non-main global memory patches', async () => {
    const service = makeService();

    const saved = await service.saveMemory(
      {
        scope: 'global',
        key: 'global-policy',
        value: 'always validate runtime',
      },
      { isMain: true, groupFolder: 'main' },
    );

    expect(() =>
      service.patchMemory(
        {
          id: saved.id,
          expected_version: saved.version,
          value: 'always validate runtime first',
        },
        { isMain: false, groupFolder: 'team' },
      ),
    ).toThrow(/global memory writes/);
  });

  it('rejects user-scoped procedures', () => {
    const service = makeService();

    expect(() =>
      service.saveProcedure(
        {
          scope: 'user',
          title: 'My private flow',
          body: 'step 1\nstep 2\nstep 3',
        },
        { isMain: false, groupFolder: 'team' },
      ),
    ).toThrow(/user-scoped procedures/);
  });

  it('ingests only group CLAUDE.md from group-local docs', async () => {
    const service = makeService();
    const groupFolder = `memory-ingest-${Date.now()}`;
    const groupDir = path.join(GROUPS_DIR, groupFolder);
    tempGroups.push(groupDir);
    fs.mkdirSync(path.join(groupDir, 'conversations'), { recursive: true });
    fs.writeFileSync(
      path.join(groupDir, 'CLAUDE.md'),
      '# Runtime context\nUse concise responses.',
    );
    fs.writeFileSync(path.join(groupDir, 'memories.md'), 'old local memory');
    fs.writeFileSync(path.join(groupDir, 'user-context.md'), 'stale persona');
    fs.writeFileSync(
      path.join(groupDir, 'conversations', 'old.md'),
      '# Old conversation',
    );

    await service.ingestGroupSources(groupFolder);

    const store = (service as unknown as { store: MemoryStore }).store;
    expect(
      store.listSourceChunks('claude_md', `claude:${groupFolder}`).length,
    ).toBeGreaterThan(0);
    expect(
      store.listSourceChunks('local_doc', `doc:${groupFolder}:memories.md`)
        .length,
    ).toBe(0);
    expect(
      store.listSourceChunks('local_doc', `doc:${groupFolder}:user-context.md`)
        .length,
    ).toBe(0);
    expect(
      store.listSourceChunks(
        'conversation',
        `conversation:${groupFolder}:old.md`,
      ).length,
    ).toBe(0);
  });

  it('ingests global knowledge docs from provided directory', async () => {
    const service = makeService();
    const knowledgeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-knowledge-'),
    );
    tempKnowledgeDirs.push(knowledgeDir);
    fs.writeFileSync(
      path.join(knowledgeDir, 'deploy-guide.md'),
      '# Deploy guide\nUse blue green deployment with health checks.',
    );

    await service.ingestGlobalKnowledge(knowledgeDir);

    const store = (service as unknown as { store: MemoryStore }).store;
    expect(
      store.listSourceChunks('knowledge_doc', 'knowledge_doc:deploy-guide.md')
        .length,
    ).toBeGreaterThan(0);
  });

  // --- Adversarial: containsSensitiveMaterial false positive ---

  it('should not treat "tokenizer" as sensitive material when extracting facts', async () => {
    // Bug: containsSensitiveMaterial uses regex /api[_-]?key|token|password|secret|oauth/i
    // Due to operator precedence, `token` is a standalone alternative (not part of `api_key_token`).
    // So "We use a tokenizer for NLP" matches `token` → returns true → facts skipped.
    // The regex should be /\b(api[_-]?key|token|password|secret|oauth)\b/i or similar
    // to avoid matching substrings like "tokenizer", "secretary", etc.
    const service = makeService();

    await service.reflectAfterTurn({
      groupFolder: 'team',
      isMain: false,
      prompt:
        'I prefer using the tokenizer from HuggingFace for all NLP tasks.',
      result: 'Noted, I will use the HuggingFace tokenizer.',
    });

    const context = await service.buildMemoryContext(
      'tokenizer preference',
      'team',
      false,
    );
    // The preference fact about tokenizer should be extracted, not skipped
    expect(context.facts.some((fact) => fact.kind === 'preference')).toBe(true);
  });

  it('should not treat "secretary" as sensitive material when extracting facts', async () => {
    // Same regex bug: "secret" matches inside "secretary"
    const service = makeService();

    await service.reflectAfterTurn({
      groupFolder: 'team',
      isMain: false,
      prompt: 'I prefer sending reports to the secretary before meetings.',
      result: 'Got it, will send reports to the secretary.',
    });

    const context = await service.buildMemoryContext(
      'secretary preference',
      'team',
      false,
    );
    expect(context.facts.some((fact) => fact.kind === 'preference')).toBe(true);
  });

  it('should not treat "authentication" as sensitive material (contains no real secrets)', async () => {
    // The word "password" might appear in discussion about password policies without
    // containing actual passwords. But this regex also catches "passport" discussions.
    const service = makeService();

    await service.reflectAfterTurn({
      groupFolder: 'team',
      isMain: false,
      prompt:
        'We use OAuth2 for authentication. Our convention is to always run integration tests.',
      result: 'Understood. The team convention is OAuth2 auth and integration tests.',
    });

    const context = await service.buildMemoryContext(
      'authentication convention',
      'team',
      false,
    );
    // "oauth" in "OAuth2" triggers the sensitive material filter, blocking legitimate facts
    expect(context.facts.length).toBeGreaterThan(0);
  });

  // --- Adversarial: extractProcedure false negative on "error" in instructional text ---

  it('should extract procedure from error-resolution workflow', async () => {
    // Bug: extractProcedure rejects any result containing "error", "failed", "cannot", etc.
    // via `/\b(can't|cannot|unable|failed|error)\b/i.test(result)`.
    // This means a legitimate instructional procedure about resolving errors is rejected.
    // E.g., "Here's how to fix the deployment error: 1. check logs 2. fix config 3. redeploy"
    // is skipped because it contains the word "error".
    const service = makeService();

    await service.reflectAfterTurn({
      groupFolder: 'team',
      isMain: false,
      prompt: 'How do I fix the deployment error?',
      result: [
        'Here is how to resolve the deployment error:',
        '1. Check the application logs for the root cause',
        '2. Fix the configuration in the deployment manifest',
        '3. Run the integration test suite locally',
        '4. Redeploy using the staging pipeline first',
        '5. Monitor the health endpoint for ten minutes',
      ].join('\n'),
    });

    const context = await service.buildMemoryContext(
      'deployment error procedure',
      'team',
      false,
    );
    // The procedure should be extracted despite containing the word "error"
    expect(context.procedures.length).toBeGreaterThan(0);
  });
});
