import { afterEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_EMBED_BATCH_SIZE } from '../core/config.js';

import {
  createEmbeddingProvider,
  EmbeddingProvider,
  OpenAIEmbeddingClient,
  registerEmbeddingProvider,
} from './memory-embeddings.js';

describe('memory embedding providers', () => {
  it('creates openai provider from factory', () => {
    const provider = createEmbeddingProvider('openai');
    expect(provider).toBeInstanceOf(OpenAIEmbeddingClient);
  });

  it('throws for unknown provider name', () => {
    expect(() => createEmbeddingProvider('does-not-exist')).toThrow(
      /Unknown memory embedding provider/,
    );
  });

  it('supports registering additional providers', async () => {
    const providerName = `test-provider-${Date.now()}`;
    registerEmbeddingProvider(
      providerName,
      () =>
        ({
          isEnabled: () => true,
          validateConfiguration: () => undefined,
          embedMany: async (texts: string[]) =>
            texts.map(() => [0.1, 0.2, 0.3, 0.4]),
          embedOne: async () => [0.1, 0.2, 0.3, 0.4],
        }) satisfies EmbeddingProvider,
    );

    const provider = createEmbeddingProvider(providerName);
    expect(await provider.embedOne('hello')).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

/* -------------------------------------------------------------------------- */
/*  OpenAIEmbeddingClient unit tests                                          */
/* -------------------------------------------------------------------------- */

describe('OpenAIEmbeddingClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /* ---- isEnabled --------------------------------------------------------- */

  describe('isEnabled()', () => {
    it('returns false when no API key', () => {
      const client = new OpenAIEmbeddingClient(null as unknown as string, 'text-embedding-test');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when API key is empty/whitespace', () => {
      const client = new OpenAIEmbeddingClient('  ', 'text-embedding-test');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when model is empty', () => {
      const client = new OpenAIEmbeddingClient('test-key', '');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns false when model is whitespace-only', () => {
      const client = new OpenAIEmbeddingClient('test-key', '   ');
      expect(client.isEnabled()).toBe(false);
    });

    it('returns true when both key and model are set', () => {
      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      expect(client.isEnabled()).toBe(true);
    });
  });

  /* ---- validateConfiguration --------------------------------------------- */

  describe('validateConfiguration()', () => {
    it('throws when API key is missing', () => {
      const client = new OpenAIEmbeddingClient(null as unknown as string, 'text-embedding-test');
      expect(() => client.validateConfiguration()).toThrow(
        'OPENAI_API_KEY is required for memory embeddings',
      );
    });

    it('throws when API key is empty', () => {
      const client = new OpenAIEmbeddingClient('', 'text-embedding-test');
      expect(() => client.validateConfiguration()).toThrow(
        'OPENAI_API_KEY is required for memory embeddings',
      );
    });

    it('throws when model is empty', () => {
      const client = new OpenAIEmbeddingClient('test-key', '');
      expect(() => client.validateConfiguration()).toThrow(
        'MEMORY_EMBED_MODEL is required for memory embeddings',
      );
    });

    it('throws when model does not contain "embedding"', () => {
      const client = new OpenAIEmbeddingClient('test-key', 'gpt-4o');
      expect(() => client.validateConfiguration()).toThrow(
        /MEMORY_EMBED_MODEL must reference an embedding model, got "gpt-4o"/,
      );
    });

    it('succeeds with valid configuration', () => {
      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      expect(() => client.validateConfiguration()).not.toThrow();
    });

    it('accepts model name with "embedding" in any case', () => {
      const client = new OpenAIEmbeddingClient('test-key', 'Text-Embedding-3-large');
      expect(() => client.validateConfiguration()).not.toThrow();
    });
  });

  /* ---- embedMany --------------------------------------------------------- */

  describe('embedMany()', () => {
    function mockFetchOk(data: Array<{ embedding: number[] }>) {
      return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data }),
      } as Response);
    }

    it('sends correct request and returns embeddings', async () => {
      const vectors = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];
      const fetchSpy = mockFetchOk(vectors.map((v) => ({ embedding: v })));

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      const result = await client.embedMany(['hello', 'world']);

      expect(result).toEqual(vectors);
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.openai.com/v1/embeddings',
        expect.objectContaining({
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'text-embedding-test',
            input: ['hello', 'world'],
          }),
        }),
      );
    });

    it('throws on non-ok HTTP response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
      } as Response);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        /embedding request failed \(429\): rate limited/,
      );
    });

    it('throws on response size mismatch', async () => {
      // Request 2 texts but return only 1 embedding
      mockFetchOk([{ embedding: [0.1, 0.2] }]);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      await expect(client.embedMany(['hello', 'world'])).rejects.toThrow(
        /embedding response size mismatch: expected 2, got 1/,
      );
    });

    it('throws when data field is missing', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: null }),
      } as Response);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        /embedding response size mismatch/,
      );
    });

    it('throws on invalid embedding vector (empty array)', async () => {
      mockFetchOk([{ embedding: [] }]);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        'embedding response contained invalid embedding vector',
      );
    });

    it('throws on invalid embedding vector (not an array)', async () => {
      mockFetchOk([{ embedding: 'not-an-array' as unknown as number[] }]);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      await expect(client.embedMany(['hello'])).rejects.toThrow(
        'embedding response contained invalid embedding vector',
      );
    });

    it('batches requests according to MEMORY_EMBED_BATCH_SIZE', async () => {
      // Create enough texts to require multiple batches
      const textCount = MEMORY_EMBED_BATCH_SIZE + 3;
      const texts = Array.from({ length: textCount }, (_, i) => `text-${i}`);
      const expectedBatches = Math.ceil(textCount / MEMORY_EMBED_BATCH_SIZE);

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
        async (_url, init) => {
          const body = JSON.parse((init as RequestInit).body as string);
          const batchInput = body.input as string[];
          return {
            ok: true,
            json: async () => ({
              data: batchInput.map((_, idx) => ({
                embedding: [idx * 0.1, idx * 0.2],
              })),
            }),
          } as Response;
        },
      );

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      const result = await client.embedMany(texts);

      expect(fetchSpy).toHaveBeenCalledTimes(expectedBatches);
      expect(result).toHaveLength(textCount);

      // Verify first batch size
      const firstCallBody = JSON.parse(
        (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
      );
      expect(firstCallBody.input).toHaveLength(MEMORY_EMBED_BATCH_SIZE);

      // Verify second (remainder) batch size
      const secondCallBody = JSON.parse(
        (fetchSpy.mock.calls[1]![1] as RequestInit).body as string,
      );
      expect(secondCallBody.input).toHaveLength(3);
    });

    it('handles empty input array', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      const result = await client.embedMany([]);

      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  /* ---- embedOne ---------------------------------------------------------- */

  describe('embedOne()', () => {
    it('delegates to embedMany and returns first result', async () => {
      const vector = [0.1, 0.2, 0.3, 0.4];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: vector }] }),
      } as Response);

      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      const result = await client.embedOne('hello');

      expect(result).toEqual(vector);
    });

    it('throws when embedMany returns empty result', async () => {
      // This shouldn't happen in practice (embedMany validates sizes),
      // but tests the safety check at line 96-98.
      const client = new OpenAIEmbeddingClient('test-key', 'text-embedding-test');
      vi.spyOn(client, 'embedMany').mockResolvedValue([]);

      await expect(client.embedOne('hello')).rejects.toThrow(
        'embedding response was empty',
      );
    });
  });
});
