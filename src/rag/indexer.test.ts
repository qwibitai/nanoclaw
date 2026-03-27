import { describe, it, expect } from 'vitest';
import { RagIndexer } from './indexer.js';
import { RagClient } from './rag-client.js';

describe('RagIndexer', () => {
  it('constructs properly with vaultDir and ragClient', () => {
    const client = new RagClient({
      workingDir: '/tmp/rag-test',
      vaultDir: '/tmp/vault-test',
    });
    const indexer = new RagIndexer('/tmp/vault-test', client);
    expect(indexer).toBeInstanceOf(RagIndexer);
  });

  it('stop does nothing when watcher is not started', async () => {
    const client = new RagClient({
      workingDir: '/tmp/rag-test',
      vaultDir: '/tmp/vault-test',
    });
    const indexer = new RagIndexer('/tmp/vault-test', client);
    await expect(indexer.stop()).resolves.toBeUndefined();
  });
});
