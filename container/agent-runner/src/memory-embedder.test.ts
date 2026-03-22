import { describe, it, expect } from 'vitest';
import { getVectorDimensions, formatEmbeddingProviderError } from './memory-embedder.js';

describe('getVectorDimensions', () => {
  it('returns override when provided', () => {
    expect(getVectorDimensions('text-embedding-3-small', 512)).toBe(512);
  });

  it('returns known model dimensions', () => {
    expect(getVectorDimensions('text-embedding-3-small')).toBe(1536);
    expect(getVectorDimensions('text-embedding-3-large')).toBe(3072);
    expect(getVectorDimensions('gemini-embedding-001')).toBe(3072);
    expect(getVectorDimensions('nomic-embed-text')).toBe(768);
    expect(getVectorDimensions('jina-embeddings-v5-text-small')).toBe(1024);
  });

  it('throws for unknown model without override', () => {
    expect(() => getVectorDimensions('unknown-model')).toThrow(
      /Unsupported embedding model/,
    );
  });

  it('ignores zero override', () => {
    expect(getVectorDimensions('text-embedding-3-small', 0)).toBe(1536);
  });

  it('ignores negative override', () => {
    expect(getVectorDimensions('text-embedding-3-small', -100)).toBe(1536);
  });
});

describe('formatEmbeddingProviderError', () => {
  it('formats auth errors with hint', () => {
    const error = new Error('401 Unauthorized');
    (error as any).status = 401;
    const result = formatEmbeddingProviderError(error, {
      baseURL: 'https://api.jina.ai/v1',
      model: 'jina-embeddings-v5-text-small',
    });
    expect(result).toContain('authentication failed');
    expect(result).toContain('Jina');
  });

  it('formats network errors', () => {
    const error = new Error('ECONNREFUSED');
    (error as any).code = 'ECONNREFUSED';
    const result = formatEmbeddingProviderError(error, {
      baseURL: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
    });
    expect(result).toContain('unreachable');
    // Provider label comes from baseURL pattern matching
    expect(result).toContain('localhost:11434');
  });

  it('formats generic errors', () => {
    const error = new Error('Something weird happened');
    const result = formatEmbeddingProviderError(error, {
      model: 'text-embedding-3-small',
    });
    expect(result).toContain('Something weird happened');
    expect(result).toContain('Failed to generate embedding');
  });

  it('does not double-wrap already-formatted messages', () => {
    const error = new Error('Embedding provider authentication failed (401)');
    const result = formatEmbeddingProviderError(error, {
      model: 'test',
    });
    expect(result).toBe('Embedding provider authentication failed (401)');
  });

  it('identifies Ollama from baseURL', () => {
    const error = new Error('timeout');
    const result = formatEmbeddingProviderError(error, {
      baseURL: 'http://localhost:11434/v1',
      model: 'nomic-embed-text',
    });
    expect(result).toContain('Ollama');
  });

  it('uses batch prefix for batch mode', () => {
    const error = new Error('some error');
    const result = formatEmbeddingProviderError(error, {
      model: 'test',
      mode: 'batch',
    });
    expect(result).toContain('batch embeddings');
  });
});
