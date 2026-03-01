# Sovereign v2.0 — 6 Features from Competitors

## Progress
- [x] RECON — architecture scan, domain detection (agentic + paid-api), size = medium
- [x] INTERVIEW — 4 questions answered, 16 decisions locked
- [x] PLAN — 6 phases spec'd, pre-mortem done, seam analysis done
- [x] DESTROY — skipped (folded into PLAN pre-mortem per medium build)
- [x] APPROVE — user approved 2026-03-01
- [ ] IMPLEMENT — Wave 1 done (Ph1+Ph4), Wave 2 done (Ph2+Ph5), Wave 3 next (Ph3+Ph6)
- [ ] REVIEW — diff-anchored code review
- [ ] CLEAN — lint, dead code, formatting
- [ ] PROVE — evidence manifest, ship gate
- [ ] LEARN — retrospective, preferences, breadcrumb

## Purpose

Cherry-pick the 6 best features from 8 competitor frameworks (IronClaw, NullClaw, PiClaw, GoClaw, OpenFang, PicoClaw, OpenClaw, NanoClaw upstream) while staying lean (<35K lines). No SaaS infrastructure. Just a killer open-source framework.

## Context

Sovereign is a Claude assistant framework (~26K lines, Node.js/TypeScript) that runs agents in Docker containers. It connects to Discord/WhatsApp, routes messages to Claude Agent SDK, and manages per-group isolated memory. Current gaps: single-provider LLM calls (no fallback), plaintext secrets, cold-start containers, BM25-only memory, no event-driven routines, no runtime model switching.

## Decisions

| # | Decision | Chosen | Why |
|---|----------|--------|-----|
| 1 | Database | SQLite + in-app cosine | User decided. Portable, simple. |
| 2 | Embedding provider | OpenAI text-embedding-3-small (512D) | Cheapest, works via OpenRouter |
| 3 | Encryption cipher | AES-256-GCM + HKDF | IronClaw pattern. AES-NI hardware accel. |
| 4 | Key derivation | HKDF-SHA256 | Master key already strong (not password) |
| 5 | Master key storage | Env var (SOVEREIGN_MASTER_KEY) | Simple, works everywhere |
| 6 | Model switching scope | Per-session (sticky until idle) | Good balance, auto-resets |
| 7 | Provider fallback | Host-side retry wrapping container | No container changes needed |
| 8 | Fusion algorithm | RRF (k=60) | IronClaw uses it. Proven, no tuning. |
| 9 | Routine engine | IronClaw Trigger/Action/Guardrails adapted | Clean separation of concerns |
| 10 | Webhook auth | HMAC-SHA256 signature verification | Standard webhook auth |
| 11 | License | MIT forever | Never changes |

## Milestones

### Phase 1: Provider Fallback Chain
**Files:** NEW `src/provider-chain.ts`, MODIFY `src/model-router.ts`, MODIFY `src/config.ts`
**Domain:** agentic, paid-api | **QA Risk:** HIGH | **Depends:** —

Make LLM calls resilient with a 3-layer decorator pattern (from IronClaw):
- **RetryProvider** — exponential backoff (1s × 2^attempt, 25% jitter, max 3), respects `retry-after` header
- **FailoverProvider** — cooldown-based (3 failures → 30s cooldown), oldest-cooled fallback (never deadlock)
- **CircuitBreakerProvider** — state machine (Closed → Open after 5 failures → HalfOpen probe after 30s)
- Error classification: `is_retryable()` (429, 5xx, network) vs non-retryable (401, 400, 422) vs context_length_exceeded (skip to next provider)
- `selectModelChain()` returns ordered array of {provider, model} pairs
- Kill switch: `PROVIDER_FALLBACK_ENABLED` env var

### Phase 2: Encrypted Secrets Vault
**Files:** NEW `src/secrets-vault.ts`, MODIFY `src/config.ts`, MODIFY `.env.example`
**Domain:** agentic, paid-api | **QA Risk:** HIGH | **Depends:** —

Protect API keys at rest with per-secret encryption:
- AES-256-GCM + HKDF-SHA256 (per-secret 32-byte salt, info: "sovereign-secrets-v1")
- Storage: `groups/{name}/.secrets.enc` — salt || nonce || ciphertext || auth_tag as base64
- API: `store(name, value)`, `get(name)`, `list()` (names only), `delete(name)`, `rotate(oldKey, newKey)`
- Atomic key rotation (temp file + rename)
- Container integration: host decrypts → passes as env vars → never written to container filesystem
- Kill switch: unset `SOVEREIGN_MASTER_KEY` → secrets disabled, falls back to plaintext env vars

### Phase 3: Warm-Start Session Pool
**Files:** NEW `src/session-pool.ts`, MODIFY `src/container-runner.ts`, MODIFY `src/index.ts`
**Domain:** agentic | **QA Risk:** HIGH | **Depends:** Phase 1 (container-runner changes must be stable)

Eliminate container cold-start latency:
- Per-group container reuse via `docker exec` (keyed by group folder)
- LRU eviction: MAX_POOL_SIZE=3 (configurable), POOL_IDLE_TIMEOUT=10min (configurable, floor 60s)
- 60s reaper interval checks for idle containers
- Graceful shutdown: SIGTERM/SIGINT → stop all pooled containers
- Failed containers auto-removed from pool, fresh spawn on next request
- Kill switch: `SESSION_POOL_ENABLED` env var

### Phase 4: Hybrid Memory (BM25 + Vector)
**Files:** NEW `src/embedding.ts`, MODIFY `src/progressive-recall.ts`, MODIFY `src/db.ts`
**Domain:** agentic, paid-api | **QA Risk:** HIGH | **Depends:** —

Combine keyword + semantic search for dramatically better recall:
- OpenAI text-embedding-3-small (512D, $0.02/1M tokens)
- Chunking: 800 words, 15% overlap, paragraph-aware splitting
- RRF fusion (k=60): BM25 top 50 + vector top 50 → fused top 10
- In-app cosine similarity (no SQLite extension needed)
- Content hash dedup: skip re-embedding unchanged chunks
- Fallback: embedding API failure → BM25-only (never blocks recall)
- Kill switch: `HYBRID_MEMORY_ENABLED` env var

### Phase 5: In-Chat Model Switching
**Files:** MODIFY `src/ipc.ts`, MODIFY `src/model-router.ts`, MODIFY `src/config.ts`
**Domain:** agentic | **QA Risk:** LOW | **Depends:** Phase 1 (model selection infrastructure)

Let users switch models mid-conversation:
- `/model <name>` — set model override for group session (sticky until idle/eviction)
- `/model` — list current model + available models
- `/model reset` — clear override, use default
- `/thinking` — toggle extended thinking mode (budget_tokens: 10000)
- IPC commands: `set_model`, `set_thinking` (processed host-side, not sent to LLM)
- In-memory storage: `Map<groupFolder, { model?, thinking? }>`
- Kill switch: `MODEL_SWITCHING_ENABLED` env var

### Phase 6: Routine Engine + Webhooks
**Files:** NEW `src/routine-engine.ts`, NEW `src/webhook-server.ts`, MODIFY `src/task-scheduler.ts`, MODIFY `src/db.ts`, MODIFY `src/config.ts`
**Domain:** agentic, paid-api | **QA Risk:** HIGH | **Depends:** —

Extend beyond cron to react to real-world events:
- Trigger types: cron, event (regex on messages), webhook (HTTP POST), manual
- Action types: lightweight (single LLM call, ROUTINE_OK sentinel) or full_job (container)
- Guardrails: cooldown (5min default), max_concurrent (1), dedup_window, global capacity cap
- Auto-pause after 5 consecutive failures
- Webhook server: HTTP on port 3456, HMAC-SHA256 signature verification, 10 req/min rate limit
- DB tables: `routines`, `routine_runs` with full audit trail
- Kill switches: `ROUTINE_ENGINE_ENABLED`, `WEBHOOK_SERVER_ENABLED` (separate)

## Interfaces

```typescript
// Phase 1 — Provider Fallback Chain
interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}
interface ProviderChainConfig {
  providers: ProviderConfig[];
  maxRetries: number;        // default 3
  cooldownMs: number;        // default 30000
  circuitThreshold: number;  // default 5
  recoveryMs: number;        // default 30000
}
function selectModelChain(task: string): Array<{ provider: string; model: string }>;
function classifyError(error: unknown): 'retryable' | 'non_retryable' | 'context_exceeded';

// Phase 2 — Secrets Vault
interface SecretsVault {
  store(name: string, value: string): Promise<void>;
  get(name: string): Promise<string | null>;
  list(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
  rotate(oldMasterKey: Buffer, newMasterKey: Buffer): Promise<void>;
}

// Phase 3 — Session Pool
interface PoolEntry { containerId: string; groupFolder: string; lastUsed: number; }
interface SessionPool {
  acquire(groupFolder: string): Promise<string | null>;  // returns containerId or null (miss)
  release(groupFolder: string, containerId: string): void;
  evict(groupFolder: string): Promise<void>;
  shutdown(): Promise<void>;
}

// Phase 4 — Hybrid Memory
interface EmbeddingChunk { id: string; content: string; embedding: Float32Array; contentHash: string; }
function generateEmbeddings(text: string): Promise<Float32Array>;
function hybridSearch(query: string, groupFolder: string, topK?: number): Promise<SearchResult[]>;

// Phase 5 — Model Switching
interface ModelOverride { model?: string; thinking?: boolean; }
const modelOverrides: Map<string, ModelOverride>;

// Phase 6 — Routine Engine
type TriggerType = 'cron' | 'event' | 'webhook' | 'manual';
type ActionType = 'lightweight' | 'full_job';
interface Routine {
  id: number; name: string; groupFolder: string;
  triggerType: TriggerType; triggerConfig: Record<string, unknown>;
  actionType: ActionType; actionConfig: Record<string, unknown>;
  guardrails: { cooldownMs: number; maxConcurrent: number; dedupWindowMs?: number };
  enabled: boolean;
}
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Embedding API costs spiral | LOW | MED | Batch at index time, cache in SQLite, ~$0.003 per re-index |
| Session pool memory blow-up | MED | HIGH | MAX_POOL_SIZE=3, auto-evict, monitor RSS |
| Master key loss | MED | HIGH | Document backup, support key rotation |
| Webhook DDoS/injection | MED | HIGH | HMAC-SHA256, rate limit 10/min, validate schema |
| All providers down | LOW | HIGH | Oldest-cooled fallback, circuit breaker auto-recovery |
| BM25+Vector worse than BM25-only | MED | MED | Keep BM25 fallback, HYBRID_MEMORY_ENABLED flag |
| Routine engine runaway | MED | HIGH | Guardrails: cooldown, max_concurrent, auto-pause on failures |
| Provider retries multiply costs | LOW | MED | Circuit breaker prevents storms, max 3 retries, backoff |
| SQLite write contention | LOW | MED | WAL mode, batch writes, single-writer discipline |

## Validation

End-to-end proof: send a Discord message that exercises each feature:
1. **Provider fallback** — set primary to invalid key → verify failover logged, response still arrives
2. **Secrets** — check `.secrets.enc` is binary, not plaintext → retrieve correct value via agent
3. **Session pool** — send two messages quickly → verify "pool hit" in logs (second reuses container)
4. **Hybrid memory** — write a note, recall with different words → verify semantic match found
5. **Model switching** — send `/model` → verify model list response; send `/model sonnet` → verify next response uses it
6. **Routine engine** — create webhook routine → POST to endpoint → verify routine fires and logs run

## Execution Plan

**Parallel waves** (to minimize conflicts on shared files):

| Wave | Phases | Why parallel |
|------|--------|--------------|
| Wave 1 | Phase 1 (Provider) ‖ Phase 4 (Memory) | No shared files |
| Wave 2 | Phase 2 (Secrets) ‖ Phase 5 (Model Switch) | No shared files (Ph5 depends on Ph1 selectModelChain) |
| Wave 3 | Phase 3 (Session Pool) ‖ Phase 6 (Routines) | Ph3 depends on Ph1 container-runner; Ph6 touches db.ts |

**Estimated new lines:** ~1500 total across 6 new files + modifications to 7 existing files.
**Target:** Stay under 35K total lines (currently ~26K).
