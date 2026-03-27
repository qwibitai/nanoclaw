import { describe, it, expect } from 'vitest';
import { RagClient, type RagConfig } from './rag-client.js';

const baseConfig: RagConfig = {
  workingDir: '/tmp/rag-test',
  vaultDir: '/tmp/vault-test',
};

describe('RagClient', () => {
  it('constructs with config', () => {
    const client = new RagClient(baseConfig);
    expect(client).toBeInstanceOf(RagClient);
  });

  it('buildQuery returns original query when no filters', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('What is calculus?');
    expect(result).toBe('What is calculus?');
  });

  it('buildQuery adds metadata filter when filters provided', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('What is calculus?', {
      course: 'MAT101',
      semester: 'Fall 2024',
    });
    expect(result).toContain('[Context:');
    expect(result).toContain('course: MAT101');
    expect(result).toContain('semester: Fall 2024');
    expect(result).toContain('What is calculus?');
  });

  it('buildQuery with empty filters object returns original query', () => {
    const client = new RagClient(baseConfig);
    const result = client.buildQuery('Some question', {});
    expect(result).toBe('[Context: ] Some question');
  });

  it('query returns fallback result when python call fails', async () => {
    const client = new RagClient({
      ...baseConfig,
      pythonBin: 'nonexistent-python-bin-xyz',
    });
    const result = await client.query('What is integration?');
    expect(result.answer).toContain('RAG query failed');
    expect(result.answer).toContain('What is integration?');
    expect(result.sources).toEqual([]);
  });
});
