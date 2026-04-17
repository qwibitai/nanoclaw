/**
 * Smoke test for Track C: embedding availability gate + Qdrant round-trip.
 * Requires OPENAI_API_KEY and QDRANT_URL in the environment.
 * DB writes go to worktree/store/messages.db (isolated from production).
 * Qdrant writes go to the shared nanoclaw_knowledge collection, tagged with
 * groupId=smoke-group/domain=smoke-test for cleanup.
 */
import { isEmbeddingAvailable, embedText } from '../src/llm/utility.js';
import { initDatabase } from '../src/db.js';
import {
  initKnowledgeStore,
  ensureQdrantCollection,
  storeFactWithVector,
  queryFactsSemantic,
  queryFacts,
  deleteFact,
} from '../src/memory/knowledge-store.js';

async function main() {
  console.log('[smoke] QDRANT_URL:', process.env.QDRANT_URL || '(unset)');
  console.log('[smoke] isEmbeddingAvailable:', isEmbeddingAvailable());

  console.log('[smoke] 1. embedText without key → null');
  const keyBackup = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const nullVec = await embedText('hello');
  console.log('  ->', nullVec === null ? 'null (PASS)' : 'NOT null (FAIL)');
  if (keyBackup) process.env.OPENAI_API_KEY = keyBackup;

  console.log('[smoke] 2. embedText with key → real vector');
  const vec = await embedText('hello world');
  console.log(
    '  ->',
    Array.isArray(vec) ? `length=${vec.length} first=${vec[0].toFixed(4)}` : 'FAILED',
  );
  if (!Array.isArray(vec) || vec.length !== 1536) {
    throw new Error('expected 1536-dim vector');
  }

  console.log('[smoke] 3. initDatabase + initKnowledgeStore + ensureQdrantCollection');
  initDatabase();
  initKnowledgeStore();
  await ensureQdrantCollection();

  console.log('[smoke] 4. storeFactWithVector — writes FTS5 + Qdrant');
  await storeFactWithVector({
    text: 'The giraffe has an unusually long neck for reaching high leaves',
    domain: 'smoke-test',
    groupId: 'smoke-group',
    source: 'smoke',
  });
  await storeFactWithVector({
    text: 'Penguins cannot fly but are excellent swimmers',
    domain: 'smoke-test',
    groupId: 'smoke-group',
    source: 'smoke',
  });
  await storeFactWithVector({
    text: 'Rust is a systems programming language with strong safety guarantees',
    domain: 'smoke-test',
    groupId: 'smoke-group',
    source: 'smoke',
  });
  console.log('  -> 3 facts written');

  console.log('[smoke] 5. queryFactsSemantic — semantic search');
  const results = await queryFactsSemantic('tall African animal', {
    groupId: 'smoke-group',
    limit: 3,
  });
  console.log('  -> top result:', results[0]?.text);
  if (!results[0]?.text?.toLowerCase().includes('giraffe')) {
    console.log(
      '  !! expected giraffe-related top result; got:',
      results.map((r) => r.text),
    );
    throw new Error('semantic search did not return expected top result');
  }
  console.log('  -> semantic ranking PASS');

  console.log('[smoke] 6. FTS5 still works for exact token search');
  const fts = queryFacts('Rust', { groupId: 'smoke-group' });
  console.log('  -> fts match:', fts[0]?.text);
  if (!fts[0]?.text?.includes('Rust')) {
    throw new Error('FTS5 match failed');
  }

  console.log('[smoke] 7. cleanup - delete smoke facts from SQLite');
  const all = queryFacts('', { groupId: 'smoke-group', limit: 100 });
  for (const f of all) deleteFact(f.rowid);
  console.log(`  -> deleted ${all.length} facts`);

  console.log('[smoke] ALL CHECKS PASSED');
}

main().catch((err) => {
  console.error('[smoke] FAILED', err);
  process.exit(1);
});
