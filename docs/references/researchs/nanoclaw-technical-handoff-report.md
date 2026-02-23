# NanoClaw feature implementation: technical handoff report

**Two major features — OpenClaw-style memory with MongoDB + Redis, and IronClaw security adaptations — can be implemented into NanoClaw's ~2,000-LOC TypeScript agent framework with well-defined architectural boundaries.** This report provides exact code structures, schemas, API contracts, and implementation sequences drawn from the actual source code of OpenClaw, IronClaw, and NanoClaw repositories. The target stack (MongoDB Atlas Vector Search, Redis, GitHub-synced memory files) replaces OpenClaw's SQLite-based approach while preserving its hybrid search quality and pre-compaction memory flush mechanics. NanoClaw's existing container isolation model maps well to IronClaw's security pipeline, though the credential exposure fix requires a network proxy pattern rather than WASM sandboxing.

---

## 1. OpenClaw memory layer adapted for MongoDB and Redis

### How OpenClaw structures persistent memory

OpenClaw (github.com/openclaw/openclaw) organizes memory across three tiers, all within `~/.openclaw/workspace/`. **MEMORY.md** stores curated long-term facts and preferences — it is human-editable, never auto-decayed, and loaded only in the private main session for security. **Daily append-only logs** at `memory/YYYY-MM-DD.md` capture running context; today's and yesterday's logs load at session start, with temporal decay defaulting to a **30-day half-life** (50% relevance at 30 days, ~12.5% at 90 days). **Session transcripts** are stored as `sessions/YYYY-MM-DD-<slug>.md` files, where slugs are LLM-generated descriptive names. Session indexing is opt-in via `experimental.sessionMemory: true` and triggers at 100KB of new data or 50 new messages.

For NanoClaw adaptation, the mapping is direct: each WhatsApp group's `groups/{name}/CLAUDE.md` becomes the equivalent of MEMORY.md. Daily logs go to `groups/{name}/memory/YYYY-MM-DD.md`. Conversation archives (already written by NanoClaw's PreCompact hook at `index.ts:151-191`) serve as session transcripts.

### Vector search: from sqlite-vec to MongoDB Atlas Vector Search

OpenClaw uses **sqlite-vec** with a `chunks_vec` virtual table storing `FLOAT[dimensions]` embeddings queried via `vec_distance_cosine()`. Its embedding provider auto-selection priority is `local → openai → gemini → voyage → mistral → disabled`. The local model is `embeddinggemma-300M-GGUF` (~600MB, via node-llama-cpp); the default remote model is OpenAI's **text-embedding-3-small** at **1536 dimensions**. Chunking uses `chunkMarkdown()` in `src/memory/internal.ts` with a target of **400 tokens** (~1,600 chars at ~4 chars/token) and **80-token overlap** (~320 chars), preserving line boundaries for precise attribution.

For MongoDB, replace the sqlite-vec virtual table with a MongoDB collection using `$vectorSearch`. The recommended schema:

```typescript
interface MemoryChunk {
  _id: ObjectId;
  content: string;                    // chunk text
  embedding: number[];                // 1536-dim float array
  content_hash: string;               // SHA-256 for dedup
  source: {
    file_path: string;
    line_start: number;
    line_end: number;
  };
  group_id: string;                   // multi-tenancy key
  chunk_index: number;
  model: string;                      // embedding model identifier
  created_at: Date;
  updated_at: Date;
  access_count: number;
}
```

Create two Atlas indexes — a vector search index and a text search index:

```json
{
  "name": "memory_vector_index",
  "type": "vectorSearch",
  "definition": {
    "fields": [
      { "type": "vector", "path": "embedding", "numDimensions": 1536, "similarity": "cosine" },
      { "type": "filter", "path": "group_id" },
      { "type": "filter", "path": "source.file_path" }
    ]
  }
}
```

The `$vectorSearch` aggregation must be the **first pipeline stage** and returns scores normalized 0–1 via `{ $meta: "vectorSearchScore" }`. Use `numCandidates` at 10–20× the desired `limit` for good recall. Add a compound unique index on `{ content_hash: 1, group_id: 1 }` for SHA-256 deduplication — identical to OpenClaw's `embedding_cache` table logic where `(provider, model, provider_key, hash(text))` forms the cache key.

### BM25 full-text search: from SQLite FTS5 to Atlas Search

OpenClaw's `chunks_fts` FTS5 virtual table indexes chunk text with BM25 scoring. Its query builder in `hybrid.ts` (lines 23–34) tokenizes the search string and joins with AND logic: `"commit" AND "hash"`. BM25 ranks are converted to 0–1 scores via `textScore = 1 / (1 + max(0, bm25Rank))`.

MongoDB Atlas Search provides **BM25 scoring natively** via the `$search` operator backed by Lucene. The equivalent query:

```javascript
{
  $search: {
    index: "memory_text_index",
    compound: {
      must: [{ text: { query: "search terms", path: "content" } }],
      filter: [{ equals: { path: "group_id", value: "tenant_123" } }]
    }
  }
}
```

Scores are accessed via `{ $meta: "searchScore" }`. Unlike OpenClaw's normalized BM25, Atlas Search scores are unbounded. **Normalize them** using min-max normalization across the result set before fusion, or use MongoDB 8.1+'s native `$scoreFusion` operator which handles normalization automatically.

### Hybrid search fusion: weighted scoring vs Reciprocal Rank Fusion

OpenClaw's `mergeHybridResults()` in `hybrid.ts` (lines 41–70) implements a **70/30 weighted union** — `finalScore = 0.7 × vectorScore + 0.3 × textScore`. Results from either search contribute; a chunk with high vector similarity but zero keyword match is still included. A **candidateMultiplier of 4** over-fetches (requesting 6 results fetches 24 from each search). Each search is wrapped in `.catch(() => [])` for graceful degradation.

IronClaw uses **Reciprocal Rank Fusion (RRF)** with the formula `score = Σ 1/(k + rank)` where k is a constant (standard k=60). OpenClaw's documentation explicitly explains their choice: RRF flattens meaningful score magnitudes (a 0.98 cosine hit and a 0.71 hit become mere ordinal positions), while weighted fusion preserves the signal from high-confidence vector matches. **For conversational memory, weighted fusion is the better default** because semantic similarity scores carry strong signal — a memory about "your favorite coffee is espresso" should rank much higher than one merely mentioning coffee, and the cosine score captures this.

**Recommended implementation for MongoDB**: On MongoDB 8.1+, use the native `$rankFusion` or `$scoreFusion` operators to combine `$vectorSearch` and `$search` pipelines in a single aggregation. For pre-8.1, use `$unionWith` with application-level weighted fusion matching OpenClaw's approach:

```javascript
// Two separate aggregation calls, then merge in application code
const vectorResults = await collection.aggregate([
  { $vectorSearch: { index: "memory_vector_index", path: "embedding",
      queryVector: queryEmbedding, numCandidates: 100, limit: 24,
      filter: { group_id: groupId } } },
  { $project: { content: 1, source: 1, score: { $meta: "vectorSearchScore" } } }
]);

const textResults = await collection.aggregate([
  { $search: { index: "memory_text_index",
      compound: { must: [{ text: { query: searchQuery, path: "content" } }],
        filter: [{ equals: { path: "group_id", value: groupId } }] } } },
  { $limit: 24 },
  { $project: { content: 1, source: 1, score: { $meta: "searchScore" } } }
]);

// Application-level weighted fusion (OpenClaw pattern)
const merged = mergeHybridResults({
  vector: vectorResults, keyword: textResults,
  vectorWeight: 0.7, textWeight: 0.3
});
```

### Pre-compaction memory flush: the critical mechanism

OpenClaw's `memory-flush.ts` implements a pre-compaction flush that runs **before** context summarization. The trigger condition is: `totalTokens >= contextWindow - reserveTokensFloor(20K) - softThresholdTokens(4K)`. For a 200K context window, this fires at **~176K tokens**. The `memoryFlushCompactionCount` tracker (stored in the session entry) ensures the flush runs only **once per compaction cycle** — if `lastFlushAt === compactionCount`, the flush is skipped.

The flush injects a **silent agentic turn** with both a system prompt (`"Session nearing compaction. Store durable memories now."`) and a user prompt (`"Pre-compaction memory flush. Store durable memories now (use memory/YYYY-MM-DD.md)"`). The agent writes important context to disk, then responds with a `SILENT_REPLY_TOKEN` that is dropped before reaching the user. If the workspace is read-only or the flush fails, compaction proceeds anyway — the flush is best-effort.

**NanoClaw integration**: NanoClaw's existing PreCompact hook (`index.ts:151-191`) already archives transcripts to `conversations/{date}.md`. Extend this hook to:

1. Before archiving, inject the OpenClaw-style silent memory flush prompt into the agent context
2. Let the agent write curated facts to `CLAUDE.md` and daily observations to `memory/YYYY-MM-DD.md`
3. Track `memoryFlushCompactionCount` in the SQLite session record (NanoClaw already uses `better-sqlite3`)
4. After the agent's flush write, proceed with the existing transcript archival
5. Trigger a git sync after the flush completes (see Section 3)

The Claude Agent SDK's `PreCompact` hook provides `session_id`, `transcript_path`, `cwd`, and `trigger` (manual or auto). NanoClaw can use the trigger type to adjust flush urgency.

---

## 2. IronClaw security pipeline adapted for containers

### The six-stage security pipeline

IronClaw (github.com/nearai/ironclaw) implements a Rust-based security pipeline motivated by credential leak incidents in OpenClaw. The full request flow is: **WASM sandbox → Allowlist Validator → Leak Scan (request) → Credential Injector → Execute → Leak Scan (response) → Return to WASM**. Each stage has three possible actions: **Block** (reject entirely), **Redact** (mask the secret), or **Warn** (flag but allow).

For NanoClaw, the WASM stages are replaced by the existing container boundary (Apple Container on macOS, Docker on Linux). The adapted pipeline becomes:

```
Container boundary → Allowlist Validator → Leak Scan (request) →
Credential Injector → Execute → Leak Scan (response) → Container boundary
```

### Leak detection: 22 patterns with Aho-Corasick optimization

IronClaw's `LeakDetector` in `src/safety/mod.rs` scans both tool outputs (before reaching the LLM) and LLM responses (before reaching the user). It uses **22 regex patterns** optimized with Aho-Corasick multi-pattern matching for categories including API keys (`sk-`, `sk-or-`, `sk-ant-`), OAuth/Bearer tokens, private keys (RSA/SSH/PGP headers), connection strings (PostgreSQL/MySQL/MongoDB URIs), AWS access keys, PII, and webhook secrets.

For NanoClaw's TypeScript implementation, use the `aho-corasick` npm package or implement pattern matching with compiled RegExp objects. The scan must run at **two points**: on container stdout before forwarding responses to WhatsApp, and on any tool input before the container executes external requests. A TypeScript implementation sketch:

```typescript
interface LeakPattern {
  name: string;
  regex: RegExp;
  action: 'block' | 'redact' | 'warn';
}

const LEAK_PATTERNS: LeakPattern[] = [
  { name: 'anthropic_key', regex: /sk-ant-[a-zA-Z0-9_-]{40,}/, action: 'block' },
  { name: 'openai_key', regex: /sk-[a-zA-Z0-9]{40,}/, action: 'block' },
  { name: 'bearer_token', regex: /Bearer\s+[a-zA-Z0-9_\-.~+\/]+=*/i, action: 'redact' },
  { name: 'private_key', regex: /-----BEGIN\s+(RSA|EC|DSA|OPENSSH)\s+PRIVATE\s+KEY-----/, action: 'block' },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/, action: 'block' },
  { name: 'connection_string', regex: /(?:postgres|mysql|mongodb):\/\/[^:]+:[^@]+@/, action: 'redact' },
  // ... additional patterns
];

function scanForLeaks(content: string): { leaked: boolean; matches: LeakMatch[] } {
  const matches = LEAK_PATTERNS
    .filter(p => p.regex.test(content))
    .map(p => ({ pattern: p.name, action: p.action }));
  return { leaked: matches.some(m => m.action === 'block'), matches };
}
```

### Credential handling: fixing NanoClaw's exposure issue

NanoClaw's `docs/SECURITY.md` documents the problem: *"Anthropic credentials are mounted so that Claude Code can authenticate when the agent runs. However, this means the agent itself can discover these credentials via Bash or file operations."* The credentials file `~/.claude/.credentials.json` is bind-mounted into every container.

IronClaw solves this with **AES-256-GCM encryption** (via `src/secrets/crypto.rs`) and **system keychain integration** — macOS Keychain via `security-framework`, Linux D-Bus Secret Service via `secret-service` crate, with `SECRETS_MASTER_KEY` environment variable as fallback. Secrets are injected at the host boundary; WASM tool code declares credential needs in `capabilities.json` and the host injects them into HTTP requests without exposing raw tokens.

For NanoClaw's container model, the fix follows the pattern documented in Docker's official NanoClaw blog post — a **network proxy** that intercepts API calls:

1. **Host-side proxy**: Run a lightweight HTTP proxy on the host (e.g., using `http-proxy` or `hono`) that listens on a Unix socket or localhost port
2. **Sentinel token**: Mount a dummy credential file into the container with a sentinel value (e.g., `sk-sentinel-nanoclaw-XXXX`)
3. **Proxy intercept**: The proxy intercepts outbound requests from the container, detects the sentinel token in the `Authorization` header, and swaps it for the real Anthropic API key stored securely on the host
4. **Container networking**: Configure the container's `ANTHROPIC_API_BASE` to point to the host proxy instead of `api.anthropic.com`
5. **Encrypt at rest**: Store the real API key encrypted with AES-256-GCM using Node.js `crypto` module, with the master key in the system keychain (use `keytar` npm package for cross-platform keychain access)

```typescript
import * as crypto from 'crypto';

class CredentialVault {
  private algorithm = 'aes-256-gcm';
  
  encrypt(plaintext: string, key: Buffer): { ciphertext: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { ciphertext: encrypted, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
  }
  
  decrypt(encrypted: { ciphertext: string; iv: string; tag: string }, key: Buffer): string {
    const decipher = crypto.createDecipheriv(this.algorithm, key, Buffer.from(encrypted.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'hex'));
    let decrypted = decipher.update(encrypted.ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }
}
```

Additionally, adapt IronClaw's **SafetyLayer sanitizer** for NanoClaw's message pipeline: detect command injection patterns (chained commands, subshells, path traversal) in WhatsApp messages before they reach the container, and scrub dangerous environment variables (`LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`) from the container environment.

---

## 3. GitHub sync with branch-per-group strategy

### Implementation with simple-git

The `simple-git` npm package (v3.31.1, ~6–11M weekly downloads, bundled TypeScript types) wraps git CLI operations. Since NanoClaw is the **sole writer** to memory files, every push should use `--force` to eliminate merge conflicts entirely. The critical architectural constraint: simple-git operates on a **single working directory**, so branch switching serializes sync operations across groups. Use `async-mutex` for concurrency control.

The branch mapping is: main group → `main` branch, all other groups → `memory/<groupId>` branches. Git `push` automatically creates remote branches that don't exist yet. For initial setup, use `--depth 1` shallow clones to minimize disk usage.

```typescript
import { simpleGit, SimpleGit } from 'simple-git';
import { Mutex } from 'async-mutex';

class MemoryGitSync {
  private git: SimpleGit;
  private mutex = new Mutex();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(private repoPath: string, private remoteUrl: string, private mainGroupId: string) {
    this.git = simpleGit({ baseDir: repoPath, maxConcurrentProcesses: 1 });
  }

  async initialize(): Promise<void> {
    const isRepo = await this.git.checkIsRepo().catch(() => false);
    if (!isRepo) {
      await simpleGit().clone(this.remoteUrl, this.repoPath, ['--depth', '1']);
      this.git = simpleGit({ baseDir: this.repoPath, maxConcurrentProcesses: 1 });
    }
    await this.git.addConfig('user.name', 'NanoClaw Bot');
    await this.git.addConfig('user.email', 'bot@nanoclaw.dev');
  }

  async syncGroup(groupId: string): Promise<void> {
    const branch = groupId === this.mainGroupId ? 'main' : `memory/${groupId}`;
    await this.mutex.runExclusive(async () => {
      await this.ensureBranch(branch);
      const status = await this.git.status();
      if (status.files.length === 0) return;
      await this.git.add('.');
      await this.git.commit(`sync: ${groupId} at ${new Date().toISOString()}`);
      await this.git.push('origin', branch, ['--force']);
    });
  }

  startPeriodicSync(getGroupIds: () => string[]): void {
    this.intervalHandle = setInterval(async () => {
      for (const id of getGroupIds()) {
        await this.syncGroup(id).catch(e => console.error(`Sync failed: ${id}`, e));
      }
    }, 600_000); // 10 minutes
  }

  async onConversationEnd(groupId: string): Promise<void> {
    this.syncGroup(groupId).catch(e => console.error(`End-sync failed: ${groupId}`, e));
  }
}
```

Authentication uses a **Personal Access Token embedded in the HTTPS URL**: `https://<token>@github.com/user/repo.git`. Store the token in an environment variable. For production, GitHub App installation tokens (short-lived, ~1 hour) provide better security. Use `git.remote(['set-url', 'origin', newUrl])` to rotate tokens without re-cloning.

### Triggering sync on conversation end

NanoClaw's polling loop in `src/index.ts` processes messages per group. Detect conversation end via inactivity timeout (no new messages for N minutes) or explicit user signal. After the PreCompact hook runs and writes memory files, call `sync.onConversationEnd(groupId)`. Also trigger sync after the memory flush pre-compaction step, ensuring flushed memories are immediately backed up.

---

## 4. Redis as the caching and session state layer

### Key namespace design

All Redis keys follow the pattern `nanoclaw:{groupId}:{type}:{identifier}`. Embeddings are group-independent (same text produces same vector), so they use a global prefix: `nanoclaw:global:embedding:{textHash}`. Use `maxmemory-policy allkeys-lru` for automatic eviction.

```
nanoclaw:{groupId}:memories:{contentHash}    → cached memory chunk (1h TTL)
nanoclaw:{groupId}:search:{queryHash}        → cached search results (5min TTL)
nanoclaw:{groupId}:session:{sessionId}       → session state hash (30min sliding)
nanoclaw:global:embedding:{textHash}          → embedding vector buffer (7d TTL)
nanoclaw:{groupId}:hot                        → sorted set of memory IDs by access count
```

### Embedding cache with binary storage

Store embeddings as binary `Float32Array` buffers in Redis — **3× more compact** than JSON string representation. For 1536-dim float32 embeddings, each cached vector is ~6KB. The embedding cache is checked before calling the embedding API, using the SHA-256 content hash as the lookup key (identical to OpenClaw's `embedding_cache` table logic). Batch-check missing hashes with Redis pipeline to identify which chunks need fresh embeddings.

### Session state for compaction tracking

Store session state as Redis hashes with a 30-minute sliding TTL (extended on each access). Track `token_count`, `compaction_count`, `memory_flush_compaction_count`, and `last_activity`. Use `HINCRBY` for atomic token count increments. This data feeds the pre-compaction memory flush trigger: check `token_count >= contextWindow - 20000 - 4000` and `memory_flush_compaction_count !== compaction_count` before firing the flush.

### Cache-aside pattern for memory retrieval

On every memory search: check Redis for cached search results (keyed by query hash + group_id). On cache miss, query MongoDB (vector + BM25), merge results with weighted fusion, cache the result set with a **5-minute TTL**, and return. Individual memory chunks get a 1-hour TTL (24 hours for hot memories tracked via the sorted set). Invalidate group search caches whenever any memory in that group is updated — use `SCAN` with pattern matching, never `KEYS` in production.

---

## 5. What to build first and dependency ordering

The implementation has clear dependencies. **Phase 1** (no external dependencies): implement the leak detection scanner in TypeScript and the credential proxy fix — these are pure NanoClaw host-process changes that immediately improve security. **Phase 2** (requires MongoDB): build the memory chunk collection, vector + text indexes, chunking pipeline (port OpenClaw's `chunkMarkdown()` with 400-token/80-overlap settings), and the hybrid search with 70/30 weighted fusion. **Phase 3** (requires Redis): add the caching layer, session state tracking, and embedding cache. **Phase 4** (requires git setup): implement the `MemoryGitSync` class with `simple-git` and `async-mutex`. **Phase 5** (integration): implement the pre-compaction memory flush by extending the existing PreCompact hook to include the silent agentic turn before transcript archival, and wire it to trigger git sync after flushing.

Key technical decisions the implementer should make: whether to use MongoDB 8.1+ native `$rankFusion` (cleaner but requires newer MongoDB) or application-level weighted fusion (works on any version); whether to use `git worktree` for parallel branch operations or accept sequential group syncing through a single working directory; and how aggressive the Redis TTLs should be for the embedding cache given API cost vs staleness tradeoffs.

## Conclusion

The two feature areas decompose into well-bounded modules. The memory layer is the most complex piece — it requires porting OpenClaw's chunking, dual-index search, weighted fusion, and pre-flush compaction logic from SQLite to MongoDB, but every component has a clean MongoDB equivalent. The security pipeline is the most impactful piece, directly addressing NanoClaw's documented credential exposure via a network proxy pattern that Docker has already validated. Redis ties everything together as the performance layer, preventing redundant embedding computations and database queries across NanoClaw's per-group message processing. The git sync mechanism is straightforward given NanoClaw's sole-writer guarantee, which permits force-push on every cycle without conflict risk.
