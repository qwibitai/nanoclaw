---
## 2026-03-01 - Pre-Compact: REVIEW — fixing P0/P1 from 6 reviewers

**SDLC Stage:** REVIEW, mid-fix on P0/P1 findings
**Task:** Fix P0/P1 findings from 6 parallel review agents, then triage P2s
**Modified files:** src/routine-engine.ts, src/secrets-vault.ts (uncommitted P0/P1 fixes), STATE.md
**Progress:**
- DONE: INTEGRATE complete (ab54415, e81101e). SQLite persistence, kill switches, cost safety, input validation, trace logging.
- DONE: Generated branch diff (6834 lines). Spawned 6 parallel reviewers.
- DONE: All 6 reviewers returned. Deduplicated findings: 2 P0, ~8 P1, 12+ P2.
- DONE: Applied 3 fixes so far:
  1. P0-1 ReDoS: Added regex length cap (200) + nested quantifier rejection in routine-engine addRoutine
  2. P0-2 Path traversal: Added groupDir validation (rejects ..) in secrets-vault create()
  3. P1 Decrypt: Added min blob length check (SALT+NONCE+TAG=60 bytes) in secrets-vault decrypt()
- IN PROGRESS: Was mid-edit on handleWebhook when interrupted
- NOT DONE: Webhook HMAC on raw body (pass bodyStr instead of re-serialized JSON)
- NOT DONE: URL-decode + validate webhook path params (group, routineName)
- NOT DONE: rateLimitMap max size cap (e.g., 1000 entries)
- NOT DONE: dailyRunCounts.clear() in RoutineEngine.shutdown()
- NOT DONE: ProviderChain pass maxTotalAttempts to FailoverProvider
- NOT DONE: cosineSimilarity vector length check (return 0 if mismatch)
- NOT DONE: chunkText dead code cleanup (3 identical branches, empty if-body, dead assignment)
- NOT DONE: tryOldestCooled remove redundant catch(err){throw err}
- NOT DONE: P2 triage with user (present findings for accept/reject)
- NOT DONE: Run tests after all fixes
- NOT DONE: Commit REVIEW fixes
- NOT DONE: REVIEW EXIT deposit
- NOT DONE: CLEAN → SHIP → PROVE → LEARN stages
**Test results:** 178/178 v2.0 tests passing (before P0/P1 fixes — need re-run after)
**Key context:**
- Branch: feature/v2-six-features (5 commits ahead of main: 7de60a2, 7591254, 1cd2afe, ab54415, e81101e)
- Review diff files in .claude/review-diff*.txt
- All reviewer results are in the conversation summary — do NOT re-run reviewers
- P0 findings CANNOT be rejected — must be fixed
- P2 findings need user triage via AskUserQuestion
- After fixes: re-run tests → commit → REVIEW EXIT → CLEAN → SHIP GATE → SHIP → PROVE → LEARN

---
## 2026-03-01 - Pre-Compact: INTEGRATE — P0 fixes in progress

**SDLC Stage:** INTEGRATE, fixing P0 findings from Financial Safety + Agentic Security audits
**Task:** Adding SQLite persistence + kill switches + cost safety fixes
**Modified files:** src/db.ts, src/config.ts, src/embedding.ts, src/routine-engine.ts, src/provider-chain.ts, .env.example, STATE.md
**Progress:**
- DONE: Wave 3 committed (1cd2afe). IMPLEMENT EXIT deposited. Advanced to INTEGRATE.
- DONE: Ran architecture drift check → DRIFTED. User chose "Add SQLite persistence."
- DONE: Added SQLite tables (embedding_chunks, routines, routine_runs) + CRUD to db.ts
- DONE: Added 5 kill switches to config.ts (PROVIDER_FALLBACK, SESSION_POOL, MODEL_SWITCHING, ROUTINE_ENGINE, WEBHOOK_SERVER)
- DONE: Added EmbeddingPersistence adapter + write-through in embedding.ts
- DONE: Added RoutinePersistence + loadFromPersistence in routine-engine.ts
- DONE: Ran Financial Safety audit (P0-1: retry budget 15→6, P0-2: cron min cooldown 5min)
- DONE: Ran Agentic Security audit (P0-1: embedding group validation, P0-2: routine prompt safety)
- DONE: Applied fix — provider-chain maxTotalAttempts 15→6
- DONE: Applied fix — routine-engine: MIN_CRON_COOLDOWN_MS=300000, MIN_EVENT_DEDUP_MS=60000, maxDailyRuns=50, daily run tracking
- DONE: Defined assertValidGroupFolder + normalizeFilePath in embedding.ts
- NOT DONE: Call assertValidGroupFolder/normalizeFilePath at indexFile, vectorSearch, hybridSearch, removeFileEmbeddings entry points
- NOT DONE: Run tests after P0 fixes
- NOT DONE: Commit INTEGRATE fixes
- NOT DONE: Run remaining INTEGRATE checklists (agentic operational safeguards, seam contracts)
- NOT DONE: INTEGRATE EXIT line in Evidence Log
**Test results:** 146/146 passing (before P0 fixes — need re-run after)
**Key context:**
- Financial audit P0s: (1) retry budget too high — FIXED to 6, (2) cron no min interval — FIXED with 5min floor + 50/day cap
- Agentic audit P0s: (1) embedding no group validation — PARTIALLY FIXED (functions defined, not yet called), (2) routine prompts agent-settable — noted for integration wiring (routines should be operator-only)
- P1s deferred to REVIEW: retry-after hold (P1-1), event no global rate limit (P1-2), webhook per-group not global (P1-3), Opus in allowlist (P1-4), features default ON (P1-5), embedding rate limit (P1-1a), secrets key in memory (P1-2a), API keys in config objects (P1-3a), sequential cron blocks (P1-4a), event feedback loops (P1-5a)
- User decision: Add SQLite persistence for both embeddings and routines (not just in-memory)
- All 4 wave commits: c144c07 (base), 7de60a2 (W1), 7591254 (W2), 1cd2afe (W3)

---
## 2026-03-01 - Pre-Compact: Sovereign v2.0 ALL 6 PHASES IMPLEMENT COMPLETE

**SDLC Stage:** IMPLEMENT complete → INTEGRATE next
**Task:** All 6 phases VERIFIED. Need: IMPLEMENT EXIT check, Wave 3 checkpoint commit, then advance to INTEGRATE.
**Modified files:** src/provider-chain.ts, src/provider-chain.test.ts, src/embedding.ts, src/embedding.test.ts, src/secrets-vault.ts, src/secrets-vault.test.ts, src/model-switching.ts, src/model-switching.test.ts, src/session-pool.ts, src/session-pool.test.ts, src/routine-engine.ts, src/routine-engine.test.ts, STATE.md, PLAN.md, .claude/risk-policy.json, tsconfig.json
**Progress:**
- DONE: All 3 waves implemented with TDD (separate Test Author + Implementer per phase):
  - Wave 1: Ph1 Provider Fallback (28 tests) + Ph4 Hybrid Memory (34 tests) — committed 7de60a2
  - Wave 2: Ph2 Secrets Vault (15 tests) + Ph5 Model Switching (24 tests) — committed 7591254
  - Wave 3: Ph3 Session Pool (22 tests) + Ph6 Routine Engine (23 tests) — NOT YET COMMITTED
- DONE: Security sentinel on all 6 modules. All P0/P1 fixed:
  - Ph1: global call budget(15), retry-after clamp [1s,60s], cooldown auto-recovery
  - Ph2: file perms 0o600, hex key validation, temp file cleanup
  - Ph3: containerId regex validation (command injection P0)
  - Ph4: store eviction 10K, input length 32K, SSRF protection, error sanitization
  - Ph5: user input removed from error messages
  - Ph6: timing-safe HMAC (crypto.timingSafeEqual), bind 127.0.0.1, global concurrency cap(5)
- NOT DONE: Wave 3 checkpoint commit. IMPLEMENT EXIT line in Evidence Log. Advance to INTEGRATE stage.
- P2 findings logged for REVIEW: error cast typing (Ph1), cosine length check (Ph4), master key Buffer zeroing (Ph2), decrypt min-length guard (Ph2), Map eviction (Ph5), /thinking word boundary (Ph5), groupFolder validation (Ph3), duplicate stopContainer (Ph3), ReDoS protection (Ph6), rate limiter ordering (Ph6), naive cron parser (Ph6), rateLimitMap growth (Ph6)
**Test results:** 146/146 passing (28+34+15+24+22+23). tsc --noEmit clean. Pre-existing suite: 886 pass, 83 fail (7 unrelated test files, confirmed identical on main)
**Key context:**
- Branch: feature/v2-six-features (3 commits: c144c07 base, 7de60a2 Wave 1, 7591254 Wave 2)
- After compact: re-invoke /do → reads STATE.md → checkpoint commit Wave 3 → IMPLEMENT EXIT → INTEGRATE stage
- All HIGH QA Risk phases have USER_LIVE_TEST still NOT_TESTED (deferred to post-IMPLEMENT per protocol)
- Phase 5 is LOW QA Risk — auto-verified, no user test needed

---
## 2026-03-01 - Pre-Compact: Sovereign v2.0 IMPLEMENT Wave 1 (receipts pending)

**SDLC Stage:** IMPLEMENT, Wave 1 (Phase 1 + Phase 4 in parallel)
**Task:** Fill proof receipts for Ph1+Ph4 tasks, checkpoint commit, then Wave 2
**Modified files:** src/provider-chain.ts (NEW), src/provider-chain.test.ts (NEW), src/embedding.ts (NEW), src/embedding.test.ts (NEW), STATE.md, PLAN.md, .claude/risk-policy.json
**Progress:**
- DONE: PLAN.md overwritten with v2.0 content. risk-policy.json updated to v2 (12 high-risk files). APPROVE gate passed. Feature branch `feature/v2-six-features` created. Phase 1 Test Author (28 tests) + Phase 4 Test Author (34 tests) → Implementers made all 62 tests GREEN. Security sentinel ran on both files — all P0/P1 issues FIXED:
  - Ph1: maxTotalAttempts=15 global call budget, retry-after clamped [1s,60s], cooldownMs wired for auto-recovery
  - Ph4: MAX_STORE_SIZE=10K eviction, MAX_EMBEDDING_INPUT_CHARS=32K, SSRF protection (HTTPS-only base URL), error body sanitization (truncate+redact Bearer), input length validation
- NOT DONE: Proof receipts not yet filled in STATE.md task checkboxes. Full regression check started (7 pre-existing failures in discord.test/db.test/setup tests — NOT from our changes, existed before branch). Need to: fill receipts, checkpoint commit Ph1+Ph4, then start Wave 2 (Ph2 Secrets Vault + Ph5 Model Switching). Waves 2 and 3 still ahead.
- P2 findings logged for REVIEW: error cast typing (Ph1), cross-phase result envelope (Ph1), cosineSimilarity length check (Ph4), BM25 word-boundary matching (Ph4), chunk overlap edge cases (Ph4), degraded fallback warning (Ph4)
**Test results:** 62/62 passing (28 provider-chain + 34 embedding). tsc --noEmit clean. Pre-existing suite: 886 pass, 83 fail (7 test files — all pre-existing, none from our code)
**Key context:**
- Branch: feature/v2-six-features (no commits yet — need checkpoint)
- After compact: re-invoke /do → reads STATE.md → resumes IMPLEMENT → fill receipts → checkpoint commit → Wave 2
- Wave execution: Wave 1 (Ph1||Ph4) DONE → Wave 2 (Ph2||Ph5) NEXT → Wave 3 (Ph3||Ph6) LAST
- Pre-existing test failures: discord.test.ts, db.test.ts, setup/environment.test.ts, setup/register.test.ts — existed on main before our branch

---
## 2026-03-01 - Pre-Compact: Sovereign v2.0 PLAN stage (APPROVE pending)

**SDLC Stage:** APPROVE (RECON→INTERVIEW→PLAN complete, DESTROY not yet run)
**Task:** Write PLAN.md (stale — has Observer Agent content), present for user approval
**Modified files:** STATE.md (written fresh with 6 phase specs), PLAN.md (needs overwrite)
**Progress:**
- DONE: RECON (architecture scan, domain detection agentic+paid-api, size=medium), INTERVIEW (4 questions answered: OpenAI embeddings, session-level model switch, yes webhooks, env var master key), PLAN research (4 parallel agents: ChaCha20→switched to AES-256-GCM, BM25+vector RRF k=60, session pool LRU, extension points mapped), IronClaw deep dive (read actual source: 3-layer provider fallback, RRF, routine engine types, secrets vault, sandbox), Pre-mortem (9 risks), Decompose (6 phases with full WHEN/THEN specs), Decisions (16 entries in STATE.md)
- NOT DONE: PLAN.md needs rewriting with v2.0 content (currently stale Observer Agent plan). risk-policy.json needs updating. DESTROY stage. APPROVE gate. TaskList creation. Context break.
**Test results:** N/A (planning stage, no code written)
**Key context:**
- 6 phases: (1) Provider Fallback Chain, (2) Encrypted Secrets Vault, (3) Warm-Start Session Pool, (4) Hybrid Memory BM25+Vector, (5) In-Chat Model Switching, (6) Routine Engine + Webhooks
- Parallel waves: Wave 1: Ph1||Ph4, Wave 2: Ph2||Ph5, Wave 3: Ph3||Ph6
- IronClaw insights adopted: AES-256-GCM+HKDF (not ChaCha20), 3-layer decorator (Retry→Failover→CircuitBreaker), Trigger/Action/Guardrails types, ROUTINE_OK sentinel, RRF k=60
- Host-side provider fallback (no container changes needed for v2.0)
- All phase specs written in STATE.md with Intent + WHEN/THEN + Test Cases + Operational Constraints
- PLAN.md file on disk is STALE (Observer Agent v0.2.0 content) — must be overwritten
- After compact: re-invoke /do → it reads STATE.md → resumes at APPROVE (write PLAN.md, then present)

---
## 2026-03-01 - Session End: Sovereign v2.0 roadmap finalized

**What we worked on:** Researched 8 claw competitors + open-core pricing models, wrote brainstorm doc for v2.0, rescoped from full SaaS platform to lean feature integration (6 features, ~1500 lines, stay under 35K total)
**What worked:** Parallel research agents (8 total) for competitive landscape. Architecture audit identified exact files/lines for multi-tenant gaps. User rescoping from SaaS to "best framework" was the right call.
**What didn't work:** N/A — research-only session, no code failures
**Left off at:** RECON stage of /do build for v2.0. STATE.md is stale (Observer Agent build) — needs fresh one for v2.0. Brainstorm approved, ready to enter SDLC.
**Key files:**
- `docs/brainstorms/2026-03-01-v2-multi-tenant-saas.md` — full brainstorm with approved 6-feature scope
- `STATE.md` — STALE from Observer Agent build, DELETE and start fresh
- `.claude/risk-policy.json` — from prior build, can be extended
**Notes for next time:**
- User decided: keep SQLite (no PostgreSQL migration), open-core MIT license forever
- User wants LEAN — no SaaS infra (no Clerk, Stripe, dashboards). Just features.
- 6 approved features: (1) Hybrid memory BM25+vector, (2) Provider fallback chain, (3) Warm-start session pool, (4) Encrypted secrets ChaCha20, (5) In-chat model switching, (6) Routine engine events+webhooks
- Additional research done this session: NullClaw (Zig, 678KB, hybrid memory, ChaCha20 secrets, provider fallbacks), PiClaw/rcarmo (Bun, warm-start agent pool, in-chat /model switching, session forking)
- Pricing research completed: LangChain, n8n, Windmill, Cal.com, Supabase, Agentforce models analyzed. Key lesson: MIT core, never change license (HashiCorp BSL cautionary tale)
- Domains: agentic + paid-api → minimum Medium build
- ~26K lines currently, target <35K after v2.0

---
## 2026-03-01 - Pre-Compact: Multi-tenant SaaS pivot research complete

**SDLC Stage:** N/A (research session — competitive landscape + architecture audit)
**Task:** Research turning Sovereign v1.0.0 into multi-tenant SaaS open-core product
**Modified files:** None (research only, no code changes)
**Progress:**
- DONE: Full competitive landscape scan — 6 research agents ran in parallel
- DONE: Claw ecosystem mapped: OpenClaw, NanoClaw, IronClaw (v0.12.0), OpenFang (v0.1.0), GoClaw (v0.3.0), Baudbot, ZeroClaw, NullClaw, PicoClaw, NanoBot, ClawWork
- DONE: Architecture audit — Sovereign is 65% multi-tenant ready (groups=tenants, container isolation, IPC auth, per-group memory all exist)
- DONE: Multi-tenant SaaS patterns researched (isolation, billing, auth, deployment)
- NOT DONE: v2.0 roadmap not yet written
- NOT DONE: No code changes made
**Key context:**
- NOBODY in the claw family does multi-tenant SaaS — first mover advantage
- "IronFang" does not exist as a public project. User may have meant IronClaw (nearai) or OpenFang (RightNow-AI)
- Sovereign's unique moats: x402 payments (no competitor has this), memory intelligence stack (Observer+Reflector+Auto-learning+Hindsight), container isolation
- Top features to pull from competitors:
  - IronClaw: routine engine (event triggers + webhooks), skill verification, libSQL/Turso, capability-based permissions
  - OpenFang: "Hands" (autonomous packages), Merkle audit trail, Ed25519 signed manifests, A2A protocol
  - GoClaw: lane-based scheduling, delegation audit trail, prompt caching, runtime tool definition (ONLY claw with DB-native multi-tenancy)
  - Baudbot: atomic deploy (source/runtime separation), sentry-agent pattern
  - NanoClaw upstream PRs: three-layer semantic memory with RAG (#560), multi-channel parallel (#558), third-party models (#592)
- Multi-tenant gaps to fill: per-tenant secrets (.env.secrets), per-tenant channel config (bring-your-own-bot), resource limits/quotas, usage metering (OpenMeter/Stripe), auth (Clerk orgs=tenants), PostgreSQL+RLS (replace SQLite)
- Open-core model: MIT core + paid observability/hosting (LangChain pattern). Avoid n8n Sustainable Use License (slows adoption)
- Recommended tech stack: Clerk (auth) + Supabase/PostgreSQL+RLS (DB) + Stripe meter events (billing) + Docker Compose per tenant initially
- Old HANDOFF.md ops tasks (hz health check, confabulation fix, adamloveai.com, X OAuth, Gmail SMTP) were deprioritized — user pivoted to SaaS research
- STATE.md is stale (from old Observer Agent build v0.2.0, Feb 27) — not relevant to current work

---
## 2026-02-28 - Pre-Compact: Sovereign v0.3.0 COMPLETE, v0.4.0 started (#13 in progress)

**SDLC Stage:** v0.4.0 IMPLEMENT — starting #13 Multi-repo workspaces
**Task:** Sovereign open-source fork, building milestone features
**Modified files:**
- v0.3.0 (all merged to develop, tagged):
  - `src/tool-guardrails.ts` + test — #28 rate limits + spend caps
  - `src/self-knowledge.ts` + test — #27 progressive disclosure MCP tool
  - `templates/agent-starter/knowledge/capabilities.json` — #27 template
  - `src/acp-adapter.ts` + test — #23 ACP adapter (Agent Client Protocol)
  - `src/config.ts` + `src/index.ts` — #23 ACP_ENABLED config + startup hook
  - `src/deploy.ts` + test — #11 atomic symlink-based release management
  - `src/cli.ts` + test — #12 CLI (sovereign init/deploy/status/logs/rollback)
  - `package.json` — bin entry for sovereign CLI
  - `container/agent-runner/src/ipc-mcp-stdio.ts` — #27 self_knowledge tool, #28 rate limits wired in
- v0.4.0 in progress:
  - Branch: `feat/multi-repo-workspaces` from develop
  - Read delegation-handler.ts to understand worker architecture
  - No code written yet — interrupted before implementation
**Progress:**
- v0.3.0 COMPLETE — tagged, 8 issues closed (PRs #41-#46 + direct pushes)
- v0.4.0 started — 5 issues: #13 Multi-repo workspaces, #14 Slack, #15 Sentry agent, #26 Structured elicitation, #30 Agent relay
- Currently on `feat/multi-repo-workspaces` branch, read delegation-handler.ts, about to implement
**Test results:** 53 files, 792 passed, 4 skipped. TypeScript clean.
**Key context:**
- Deploy Gate pattern: branch → implement → test → 3 receipts → commit (yes) → push (yes) → PR+merge (yes)
- Container can't import from src/ — inline duplicate code in agent-runner
- All v0.3.0 features follow Small Build Fast Path (no STATE.md)
- Repo: github.com/brandontan/sovereign, local: /tmp/sovereign/
- Full suite excludes discord.test.ts (pre-existing failures)

---
## 2026-02-28 - Pre-Compact: Sovereign v0.3.0 — #28 Tool Guardrails Audit awaiting push

**SDLC Stage:** IMPLEMENT (Small Build Fast Path) — committed, awaiting push → PR → merge
**Task:** Build #28 — Tool Guardrails Audit (rate limits, spend caps, safety framework)
**Modified files:**
- `/tmp/sovereign/src/tool-guardrails.ts` — NEW: rate limiter + spend tracker pure functions
- `/tmp/sovereign/src/tool-guardrails.test.ts` — NEW: 16 tests
- `/tmp/sovereign/container/agent-runner/src/ipc-mcp-stdio.ts` — MODIFIED: rate limits on send_sms (10/hr) + make_call (5/hr), $10/day spend cap on x402_fetch
**Progress:**
- v0.2.0 COMPLETE — tagged, all 11 issues closed
- v0.3.0 in progress:
  - DONE: #7 Smart Model Routing — PR #40
  - DONE: #9 Task Templates — PR #41
  - DONE: #10 Tool Guard — PR #42 (with security audit fixes: Bash guard hook, whitespace evasion, config injection, merge defaults)
  - AWAITING PUSH: #28 Tool Guardrails Audit — committed at f43ce0b on feat/tool-guardrails-audit
  - NEXT: Push #28 → PR → merge → #27 Self-knowledge → #23 ACP → #11 Deploys → #12 CLI
**Test results:** 49 files, 740 passed, 4 skipped. TypeScript clean.
**Key context:**
- Branch: `feat/tool-guardrails-audit` on `/tmp/sovereign/`
- Rate limits + spend caps are in-memory per-session (reset on container restart — by design)
- Tool guard (#10) got a proper security audit: 4 findings, all fixed before merge

---
## 2026-02-28 - Pre-Compact: Sovereign v0.3.0 — #9 Task Templates ready to commit

**SDLC Stage:** IMPLEMENT (Small Build Fast Path) — code written, tests passing, proof receipts done, awaiting commit
**Task:** Build #9 — Task Templates (reusable structured prompts with anti-pattern guardrails)
**Modified files:**
- `/tmp/sovereign/src/task-templates.ts` — NEW: template loader with 3-tier fallback (group → global → built-in), markdown parser, applyTemplate() wraps prompts
- `/tmp/sovereign/src/task-templates.test.ts` — NEW: 20 tests passing
- `/tmp/sovereign/templates/tasks/` — NEW: 5 editable template files (research.md, content.md, analysis.md, outreach.md, code-review.md)
- `/tmp/sovereign/src/task-scheduler.ts` — MODIFIED: wired applyTemplate()
- `/tmp/sovereign/src/delegation-handler.ts` — MODIFIED: wired applyTemplate()
**Progress:**
- v0.2.0 COMPLETE — tagged, all 11 issues closed (PRs #29-39)
- v0.3.0 started:
  - DONE: #7 Smart Model Routing — PR #40 merged, issue closed
  - READY TO COMMIT: #9 Task Templates — 47 files, 690 tests pass, typecheck clean, proof receipts done, user said "comp w bc" before confirming commit
  - NEXT: Commit #9 → push → PR → merge → #10 Tool Guard → #28 Tool Guardrails Audit → #27 Self-knowledge → #23 ACP → #11 Deploys → #12 CLI
**Test results:** 47 files, 690 passed, 4 skipped. TypeScript exit 0.
**Key context:**
- Branch: `feat/task-templates` on `/tmp/sovereign/` (from develop)
- All v0.3.0 work uses same pattern: branch from develop → implement → test → proof receipts → Deploy Gate (commit → push → PR → merge)
- Task templates pair with model router (#7) — classifier determines task type, templates provide structured guidance
- Conversation and quick-check prompts skip template wrapping (stay lightweight)
- 5 built-in templates hardcoded as fallback; file-based templates override them
- Pre-existing discord test failures (16 tests) excluded from all suites

---
## 2026-02-28 - Pre-Compact: Sovereign v0.2.0 — #24 Progressive Memory in progress

**SDLC Stage:** IMPLEMENT (Small Build Fast Path) — `progressive-recall.ts` + test written, container ipc-mcp-stdio.ts NOT yet modified
**Task:** Build #24 — Progressive Memory (layered search instead of raw result dump)
**Modified files:**
- `/tmp/sovereign/src/progressive-recall.ts` — NEW: pure functions for summary extraction (detectCategory, detectPriority, extractFirstLine, summarizeResult, formatLayeredResults, formatFullResults)
- `/tmp/sovereign/src/progressive-recall.test.ts` — NEW: tests written but NOT yet run
- `/tmp/sovereign/container/agent-runner/src/ipc-mcp-stdio.ts` — NOT YET MODIFIED (next step: add `mode` param to recall tool, add `recall_detail` tool, remove duplicate grep-based recall)
**Progress:**
- DONE: #20 Zod schemas — PR #29 merged
- DONE: #6 Quality tracker — PR #31 merged
- DONE: #4 Auto-learner — PR #32 merged
- DONE: #22 Per-step eval — PR #33 merged
- DONE: #2 Reflector — PR #34 merged
- DONE: #3 Structured memory — PR #35 merged
- DONE: #5 Hindsight — PR #36 merged
- DONE: #21 Router — PR #37 merged
- IN PROGRESS: #24 Progressive Memory — host-side module written (progressive-recall.ts + test), container changes pending
- NEXT: Finish #24 (modify ipc-mcp-stdio.ts: remove duplicate recall, add mode param, add recall_detail tool) → run tests → Deploy Gate → #25 Tool Observability
**Test results:** Not yet run for #24
**Key context:**
- Branch: `feat/progressive-memory` on `/tmp/sovereign/` (from develop)
- Container code (`container/agent-runner/src/ipc-mcp-stdio.ts`) has a BUG: duplicate `recall` tool registration (BM25 at line 417, grep at line 472) — grep one needs removal
- Container code has no test infrastructure — only host-side `src/` code is testable
- v0.2.0 score: 9 of 12 features done, #24 partially written

---
## 2026-02-28 - Pre-Compact: Sovereign v0.2.0 — #5 Hindsight implemented, pending test/commit/push/PR

**SDLC Stage:** IMPLEMENT (Small Build Fast Path) — code written, tests written, needs full suite run + Deploy Gate
**Task:** Build #5 — Hindsight (auto post-mortem on failed conversations)
**Modified files:**
- `/tmp/sovereign/src/hindsight.ts` — NEW: frustration detection (regex gate, >= 2 signals required) + LLM post-mortem → HindsightReport → LEARNINGS.md. Same safeguards (circuit breaker, 10min cooldown, 200KB cap, credential scrubbing, kill switch).
- `/tmp/sovereign/src/hindsight.test.ts` — NEW: 20 tests (6 detection + 14 integration)
- `/tmp/sovereign/src/config.ts` — MODIFIED: added HINDSIGHT_ENABLED config flag
- `/tmp/sovereign/src/index.ts` — MODIFIED: added hindsight fire-and-forget hook in processGroupMessages
**Progress:**
- DONE: #20 Zod schemas — PR #29 merged
- DONE: #6 Quality tracker — PR #31 merged
- DONE: #4 Auto-learner — PR #32 merged
- DONE: #22 Per-step eval — PR #33 merged
- DONE: #2 Reflector — PR #34 merged
- DONE: #3 Structured memory — PR #35 merged
- IN PROGRESS: #5 Hindsight — code + tests written, `vitest run src/hindsight.test.ts` → 20 passed. Full suite + typecheck NOT YET RUN (interrupted). On branch `feat/hindsight` at `/tmp/sovereign/`. NOT committed yet.
- NEXT: Run full tests + typecheck → proof receipts → Deploy Gate (commit → push → PR → merge). Then: #21 → #24 → #25
**Test results:** `vitest run src/hindsight.test.ts` → 20 passed. Full suite not yet run.
**Key context:**
- Branch: `feat/hindsight` on `/tmp/sovereign/` (from develop)
- Repo ephemeral at /tmp/sovereign — re-clone if needed, checkout feat/hindsight
- User wants explicit proof receipts (✅🔒📋) before every commit
- v0.2.0 score: 7 of 12 features done, #5 nearly complete
- Differentiation from auto-learner: hindsight detects FRUSTRATION (multiple signals, abandonment) not single corrections. Deeper LLM analysis → HindsightReport with severity.
- Frustration patterns: explicit frustration words, abandonment signals ("forget it", "I'll do it myself"), repeated corrections (>= 2 in one conversation)
- 10min cooldown (vs auto-learner's 2min) because heavier analysis

---
## 2026-02-28 - Pre-Compact: Sovereign v0.2.0 — #4 Auto-learner committed, pending push+PR

**SDLC Stage:** Deploy Gate (Small Build Fast Path) — committed, awaiting push
**Task:** Build #4 — Auto-learning loop (correction detection + learning extraction)
**Modified files:**
- `/tmp/sovereign/src/auto-learner.ts` — NEW: correction detection (regex gate) + LLM extraction of structured LearningEntry + LEARNINGS.md append. Same safeguards as observer (circuit breaker, cooldown, file cap, credential scrubbing, kill switch).
- `/tmp/sovereign/src/auto-learner.test.ts` — NEW: 21 tests (7 detection + 14 integration)
- `/tmp/sovereign/src/config.ts` — MODIFIED: added AUTO_LEARNER_ENABLED config flag
- `/tmp/sovereign/src/index.ts` — MODIFIED: added auto-learner fire-and-forget hook in processGroupMessages
**Progress:**
- DONE: #20 Zod schemas — PR #29 merged to develop
- DONE: #6 Quality tracker — PR #31 merged to develop
- DONE: #4 Auto-learner — committed on feat/auto-learning (`4755aa0`), NOT YET PUSHED
- DONE: #30 filed (Agent relay, v0.4.0)
- NEXT: Push #4 → PR → merge to develop. Then continue: #22 → #2 → #3 → #5 → #21 → #24 → #25
**Test results:** `vitest run` → 455 passed | 4 skipped | 16 pre-existing discord failures. `tsc --noEmit` → clean. `npm run build` → clean.
**Key context:**
- Branch: `feat/auto-learning` on `/tmp/sovereign/` (cloned from github.com/brandontan/sovereign, from develop)
- Repo is at /tmp/sovereign (ephemeral — re-clone if needed, checkout feat/auto-learning)
- User asked for MORE EXPLICIT proof receipts before commit — show formatted checklist every time
- v0.2.0 score: 4 of 12 features done (#1 Observer, #20 Zod, #6 Quality, #4 Auto-learner)
- Build order remaining: #22 (Per-step Eval) → #2 (Reflector) → #3 (Structured Memory) → #5 (Hindsight) → #21 (Router) → #24 (Progressive Memory) → #25 (Tool Observability)
- All features follow same pattern: Small Build Fast Path, fire-and-forget hook in processGroupMessages, same operational safeguards

---
## 2026-02-28 - Pre-Compact: Sovereign v0.2.0 feature scan + #20 Zod schemas in progress

**SDLC Stage:** IMPLEMENT (Small Build Fast Path), Phase 2/2 (Observer Retrofit)
**Task:** Build #20 — Zod-validated agent outputs for Sovereign
**Modified files:**
- `/tmp/sovereign/src/schemas.ts` — NEW: Zod schemas for all 7 agent types (Observer, Reflector, Memory, Learning, Hindsight, Quality, StepValidation) + observationToMarkdown() serializer
- `/tmp/sovereign/src/validate-llm.ts` — NEW: LLM output validation utility (parse JSON + Zod validate + retry once + circuit-break)
- `/tmp/sovereign/src/schemas.test.ts` — NEW: 16 tests for all schemas + markdown serialization
- `/tmp/sovereign/src/validate-llm.test.ts` — NEW: 10 tests for validation utility (retry, circuit-break, code fence stripping)
- `/tmp/sovereign/src/observer.ts` — MODIFIED: retrofitted to use Zod validation. LLM prompt now requests JSON. Credential scrubbing moved AFTER Zod parse (scrubbing raw JSON breaks structure — password regex `\S+` eats through JSON delimiters).
- `/tmp/sovereign/src/observer.eval.ts` — MODIFIED: eval mocks updated to return valid JSON instead of old markdown format
**Progress:**
- DONE: Phase 1 (schemas + validation utility) — 26 tests pass, typecheck clean
- DONE: Phase 2 (observer retrofit) — 46 tests pass (15 observer + 5 eval assertions + 16 schema + 10 validation), 4 eval scaffolds skipped, typecheck clean, build clean
- NEXT: CLEAN (grep TODOs, unused imports) → LEARN → Deploy Gate (commit → push → PR → merge to develop)
**Test results:** `vitest run` → 46 passed | 4 skipped. `tsc --noEmit` → clean. `npm run build` → clean.
**Key context:**
- Branch: `feat/zod-validated-outputs` on `/tmp/sovereign/` (cloned from github.com/brandontan/sovereign, checkout develop)
- Repo is at /tmp/sovereign (ephemeral — re-clone if needed, checkout feat/zod-validated-outputs)
- Bug found + fixed: credential scrubbing on raw JSON breaks structure. Password regex `/(secret|token|...)\s*[=:]\s*\S+/` greedily eats through `"],"referencedDates":[]}]}`. Fix: scrub individual field values after Zod parse, not raw JSON string.
- v0.2.0 milestone now has 12 issues total (was 7 original + 3 from MindsDB blog + 2 from Claude Code blogs). #8 closed (merged into #22). #23 (ACP) filed on v0.3.0.
- Build order: #20 (in progress) → #6 → #4 → #22 → #2 → #3 → #5 → #21 → #24 → #25
- All issues filed: #20-#28 across milestones

---
## 2026-02-27 - Session End: Observer Agent shipped

**What we worked on:** Finished CLEAN → SHIP → PROVE → LEARN for Observer Agent (v0.2.0, issue #1). Merged PR #19.
**What worked:** Deploy Gate sequence (commit → push → PR → merge as separate stops). Loose-ends check caught nothing new — clean build.
**What didn't work:** First `gh pr create` failed because fork confused base repo. Fixed with explicit `--repo brandontan/sovereign --base develop --head feat/observer-agent`.
**Left off at:** Build COMPLETE. PR merged into develop. Next: live VPS deployment test, file pre-existing P0 financial issues as GitHub issues.
**Key files:** src/observer.ts, src/index.ts, src/config.ts, .claude/evidence-manifest.json
**Notes for next time:** When creating PRs on forks, always use `--repo` and `--head` flags explicitly. The `develop` branch is the integration branch, `main` is stable.

---
## 2026-02-27 - Build: Observer Agent (v0.2.0)

**What we built:** Auto-compress substantial Discord conversations (5+ user messages) into prioritized observations (🔴🟡🟢) via Sonnet 4.6. Fire-and-forget, host-side, with full security hardening.
**What worked:** Separate Test Author subagent (spec-only, no code access) produced tests that caught real bugs. Assertion evals for security boundaries. Host-side direct API call (no container overhead).
**What didn't work:** Nothing major — clean execution across 3 compacted sessions.
**Key files:** src/observer.ts (core), src/index.ts (hook), src/config.ts (config), src/observer.test.ts (15 tests), src/observer.eval.ts (5 assertion + 4 scaffold evals)
**Notes for next time:** Circuit breaker needs trip recording on ALL failure paths (4 in this case). readEnvFile for secrets when process.env isn't reliable. BM25 recall auto-finds files in daily/ subdirectories.
**PR:** https://github.com/brandontan/sovereign/pull/19

---
## 2026-02-27 - Pre-Compact: Observer both phases implemented, at CLEAN stage ready for SHIP GATE

**SDLC Stage:** CLEAN (after IMPLEMENT → INTEGRATE → REVIEW) — ready to finalize and present SHIP GATE
**Task:** Build Observer Agent (v0.2.0, issue #1) — conversation compression to prioritized observations
**Modified files:**
- `/tmp/sovereign/src/observer.ts` — NEW: main observer module (310 lines). LLM call, scrubCredentials, circuit breaker w/ 15min auto-reset, cooldown, file writing. All 3 P1 security fixes applied (content length limits, circuit breaker reset, readEnvFile for secrets).
- `/tmp/sovereign/src/observer.test.ts` — NEW: 15 TDD tests (Test Author subagent)
- `/tmp/sovereign/src/observer.eval.ts` — NEW: 5 assertion evals + 4 scaffold evals (Eval Author subagent)
- `/tmp/sovereign/src/types.ts` — ObservationEntry removed (dead code, found in REVIEW)
- `/tmp/sovereign/src/env.ts` — defensive null check for mocked fs
- `/tmp/sovereign/src/config.ts` — OBSERVER_ENABLED (bool) + MIN_OBSERVER_MESSAGES (int, default 5)
- `/tmp/sovereign/src/index.ts` — observer hook in processGroupMessages (fire-and-forget after response)
- `/tmp/sovereign/.env.example` — observer config entries added
- `/tmp/sovereign/vitest.config.ts` — added `src/**/*.eval.ts` to include
**Progress:**
- DONE: Phase 1 (Observer Core) — 4/4 tasks, all receipts filled, 3 P1 security fixes, 6 operational safeguards verified
- DONE: Phase 2 (Host Integration) — 3/3 tasks, all receipts filled, BM25 recall verified (recursive walk)
- DONE: INTEGRATE — 372 tests pass (excluding 16 pre-existing discord.test.ts failures), financial/agentic/architecture checklists run
- DONE: REVIEW — 3 parallel reviewers (architecture, agentic security, financial safety). Triage: 0 P0 in scope, removed unused ObservationEntry. Pre-existing P0 financial issues noted (not introduced by observer).
- IN PROGRESS: CLEAN — build+typecheck+tests pass. Dead code removed.
- NEXT: CLEAN EXIT → SHIP GATE (eval baseline check, evidence freshness, parking lot) → SHIP (commit, push, PR) → PROVE → LEARN
**Test results:** 20 passed | 4 skipped (observer tests+evals). 372 passed full suite (excl discord).
**Key context:**
- After compact: run `/do` → reads STATE.md → sees CLEAN stage → load build-ship.md → finish CLEAN exit → SHIP GATE
- Pre-existing issues found but OUT OF SCOPE: x402 max_price_usd not enforced (P0), no global daily spend cap (P0), no per-user rate limit (P0), main message path missing outbound credential scrubbing (P1). All pre-existing, file as GitHub issues.
- Architecture drift: 5 points found, 4 accepted (deliberate decisions from security review), 1 fixed (dead code removed). PLAN.md should be updated to match reality.
- Eval baseline for SHIP GATE: assertion evals pass (5/5). LLM-judge evals are scaffolded (4 skipped) — scored post-implementation. Need to document this at SHIP GATE.

---
## 2026-02-27 - Pre-Compact: Observer Phase 1 implementation done, fixing P1 security issues

**SDLC Stage:** IMPLEMENT Phase 1/2 (Observer Core) — code written, security review done, fixing P1s
**Task:** Build Observer Agent (v0.2.0, issue #1) — P1 security fixes in progress
**Modified files:**
- `/tmp/sovereign/src/observer.ts` — NEW: main observer module (288 lines). LLM call, scrubCredentials, circuit breaker, cooldown, file writing. P1 fixes partially applied.
- `/tmp/sovereign/src/observer.test.ts` — NEW: 15 TDD tests (written by Test Author subagent, zero codebase access)
- `/tmp/sovereign/src/observer.eval.ts` — NEW: 5 assertion evals + 4 scaffold evals (written by Eval Author subagent)
- `/tmp/sovereign/src/types.ts` — MODIFIED: added ObservationEntry interface
- `/tmp/sovereign/src/env.ts` — MODIFIED: defensive null check for mocked fs
- `/tmp/sovereign/vitest.config.ts` — MODIFIED: added `src/**/*.eval.ts` to include
**Progress:**
- DONE: Test Author wrote 15 failing tests (RED) — separate subagent, spec-only, zero codebase access
- DONE: Eval Author wrote 5 assertion evals + 4 scaffold evals (RED)
- DONE: Implementer made all 20 tests GREEN (15 tests + 5 assertion evals pass, 4 scaffolds skipped)
- DONE: Build passes (`npm run build`), typecheck passes (`tsc --noEmit`)
- DONE: Full regression — discord.test.ts 16 failures are PRE-EXISTING (confirmed on base branch), NOT our regression
- DONE: Security sentinel review — 0 P0, 3 P1, 5 P2
- IN PROGRESS: Fixing 3 P1 security issues:
  - P1-1 ✅ APPLIED: Added MAX_MESSAGE_LENGTH (2000 chars) + MAX_TOTAL_CHARS (50000) to prevent cost spiral
  - P1-2 ✅ PARTIALLY APPLIED: Circuit breaker time-based reset (15min). Added circuitBreakerTrippedAt variable + reset logic + trip recording on fetch-catch and non-ok paths. NEED: verify tests still pass, add trip recording to parse-failure and empty-response paths
  - P1-3 ✅ APPLIED: Switched from process.env to readEnvFile for ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN (with fallback to process.env)
- NOT DONE: Re-run tests after P1 fixes to verify no regressions
- NOT DONE: Fill 3 proof receipts (✅🔒📋) for each of 4 Phase 1 tasks in STATE.md
- NOT DONE: Phase exit check (all tasks done, verify cmd, regression, SHA-stamp, operational safeguards)
- NOT DONE: USER_LIVE_TEST gate (Phase 1 is HIGH QA Risk)
- NOT DONE: Checkpoint commit
- NOT DONE: Phase 2: Host Integration (3 tasks)
**Test results:** Before P1 fixes: 20 passed | 4 skipped | build clean. After P1 fixes: not yet verified.
**Key context:**
- TDD used separate Test Author + Implementer subagents (BANNED: same agent writing both for logic-heavy medium builds)
- Security sentinel P2 issues logged for REVIEW: P2-1 injection blocklist bypassable (defense-in-depth only), P2-2 TOCTOU race (minimal), P2-3 _resetCooldownsForTesting in production, P2-4 sender_name not sanitized (unused), P2-5 ObservationEntry interface unused by observer.ts
- After compact: run `/do` → reads STATE.md → sees IMPLEMENT Phase 1 → needs to: (1) finish P1 fixes, (2) re-run tests, (3) fill receipts, (4) phase exit, (5) checkpoint commit, (6) start Phase 2
- build-implement.md has the IMPLEMENT stage instructions (load via build.md STAGE ROUTING)
- Observer module uses lazy imports for group-folder.js and env.js to avoid module-load cascade in vitest

---
## 2026-02-27 - Pre-Compact: Observer Agent APPROVED, ready for IMPLEMENT

**SDLC Stage:** IMPLEMENT Phase 1/2 (Observer Core)
**Task:** Build Observer Agent (v0.2.0, issue #1) — user approved plan, context break before implementation
**Modified files:**
- `/tmp/sovereign/STATE.md` — Updated: APPROVE EXIT logged, Loop State → IMPLEMENT Phase 1
- `/tmp/sovereign/PLAN.md` — Unchanged (written in PLAN phase)
- `/tmp/sovereign/.claude/risk-policy.json` — Unchanged
**Progress:**
- DONE: RECON → INTERVIEW → PLAN → DESTROY → APPROVE (all 5 planning stages complete)
- NEXT: IMPLEMENT Phase 1: Observer Core (4 tasks, all pending)
  - Task 1: Create Observation types in types.ts
  - Task 2: Build observer module (LLM call + hard delimiters + credential scrubbing + output validation)
  - Task 3: Write to daily/observer/{date}.md (append-only, provenance, size cap, safe paths)
  - Task 4: Per-group cooldown + conversation truncation
- THEN: IMPLEMENT Phase 2: Host Integration (3 tasks, blocked by Phase 1)
**Test results:** N/A (no code written yet)
**Key context:**
- This is a MEDIUM build with agentic+paid-api domains. Full SDLC flow.
- TDD: logic-heavy → BANNED: same agent writing tests AND production code. Use separate Test Author + Implementer subagents.
- Phase 1 scope: src/observer.ts (NEW), src/types.ts (modify)
- Phase 2 scope: src/index.ts, src/config.ts, .env.example
- After compact: run `/do` → it reads STATE.md → resumes at IMPLEMENT Phase 1
- build-implement.md has the IMPLEMENT stage instructions (load via build.md STAGE ROUTING)
- Key files to read for implementation: src/container-runner.ts (scrubCredentials pattern), src/index.ts (processGroupMessages hook point), src/config.ts (config pattern)
- User note: "haiku hallucinates" → use Sonnet 4.6 for observer LLM

---
## 2026-02-27 - Pre-Compact: Observer Agent plan complete, awaiting APPROVE

**SDLC Stage:** APPROVE (after RECON → INTERVIEW → PLAN → DESTROY)
**Task:** Build Observer Agent (v0.2.0, issue #1) — compress conversations into prioritized observations
**Modified files:**
- `/tmp/sovereign/STATE.md` — NEW: Full STATE.md with 2 phases, security mitigations from DESTROY
- `/tmp/sovereign/PLAN.md` — NEW: Self-contained plan document
- `/tmp/sovereign/.claude/risk-policy.json` — NEW: Risk tiers for observer files
**Progress:**
- DONE: RECON — medium build, agentic+paid-api domains, TypeScript
- DONE: INTERVIEW — 6 decisions (timing=5+ msgs, storage=daily/observer/, model=Sonnet 4.6, architecture=host-side API call, crons skipped, anti-goals=both)
- DONE: PLAN — 2 phases (Observer Core + Host Integration), requirements traced
- DONE: DESTROY — architecture ALIGNED, security found 1 CRITICAL + 3 HIGH + 4 MEDIUM. ALL mitigated in revised plan:
  - OA-01 CRITICAL (prompt injection → memory poison): hard delimiters + output validation
  - OA-02 HIGH (credential leak): scrubCredentials before LLM + add missing patterns (ghp_, AKIA, xoxb-)
  - OA-03 HIGH (cost amplification): per-group 5-min cooldown + payload truncation + max_tokens cap
  - OA-04 HIGH (unhandled rejection): never-reject pattern (try/catch entire function)
  - OA-07 MEDIUM (trust boundary): daily/observer/ subdirectory with provenance tag
  - OA-05/06/08: safe path resolution, file size cap, expanded scrub patterns
- NEXT: ⛩ APPROVE — present plan to user for approval, then IMPLEMENT
- User note: "haiku hallucinates" — do NOT use Haiku for observer. Sonnet 4.6 chosen.
**Test results:** N/A (no code written yet — planning phase)
**Key context:**
- Observer is HOST-SIDE direct API call (not container), matches x402-handler precedent
- Fire-and-forget after Discord response sent (non-blocking)
- Observations go to daily/observer/{date}.md (separate trust boundary from user notes)
- BM25 recall already searches all workspace files — no container changes needed
- Phase 1: observer.ts + types.ts (4 tasks). Phase 2: index.ts + config.ts + .env.example (3 tasks)
- After APPROVE, recommend /compact before IMPLEMENT (context break)

---
## 2026-02-27 - Pre-Compact: Sovereign repo created + feature roadmap from 4 sources

**SDLC Stage:** N/A (repo setup + research session)
**Task:** Fork NanoClaw → Sovereign public repo, research competitors, build feature roadmap
**Modified files:**
- GitHub: `brandontan/sovereign` — NEW PUBLIC REPO (forked from qwibitai/nanoclaw)
- `/tmp/sovereign/README.md` — Full README with architecture diagram, quickstart, roadmap
- `/tmp/sovereign/.env.example` — Clean env template with all config options documented
- `/tmp/sovereign/src/` — All patches committed (delegation, BM25, x402, scrubbing, Discord, etc.)
- Local: `memory/MEMORY.md` — Added Sovereign repo section
**Progress:**
- DONE: Forked NanoClaw → brandontan/sovereign (public, MIT)
- DONE: Applied all patches as clean commit (2,643 lines, 24 files)
- DONE: Tagged v0.1.0 on main, develop branch synced
- DONE: Researched baudbot (tool guard, atomic deploys, structured memory, sentry-agent, Slack)
- DONE: Researched Mastra observational memory (observer/reflector, priority markers, three-date model, text > vectors)
- DONE: Researched OpenClaw-RL (next-state as oracle, auto-learning loop, hindsight extraction, conversation JSONL logging)
- DONE: Analyzed Perplexity Computer (smart model routing, evaluation gate, task templates with anti-patterns)
- DONE: Created 18 GitHub issues across 4 milestones (v0.2.0 Memory, v0.3.0 Security+Deploy, v0.4.0 Multi-agent, v1.0.0 Production)
- DONE: Labels (feature, memory, security, dx, core, from-baudbot, from-mastra) and milestones created
- DONE: README with architecture, roadmap linked to issues, quickstart
- User decided: TypeScript (not Go rewrite), name "Sovereign"
**Test results:** Repo visible at https://github.com/brandontan/sovereign, all 18 issues listed, v0.1.0 tag on main
**Key context:**
- Branching: main (stable, tagged releases) + develop (integration) + feature branches for work
- Upstream: `upstream` remote = qwibitai/nanoclaw (can pull upstream updates)
- Feature priorities from research: observational memory (Mastra) > auto-learning (OpenClaw-RL) > tool guard (baudbot) > smart model routing (Perplexity) > clean codebase
- Ole Lehmann tweet shared re: don't launch coins for SaaS — user noted but no action needed
- `/tmp/sovereign/` is temporary clone — clone fresh from GitHub when needed

---
## 2026-02-27 - Pre-Compact: Delegation fixed + BM25 recall + honest NanoClaw assessment

**SDLC Stage:** N/A (ops session — fixing delegation, upgrading recall, feature assessment)
**Task:** Fix delegation end-to-end, upgrade recall to BM25, evaluate NanoClaw vs OpenClaw
**Modified files:**
- hz VPS: `src/delegation-handler.ts` — Fixed IPC path (was `data/ipc`, needed to stay `data/ipc` not `data/sessions`). Fixed streaming callback to accumulate results with `lastResult` variable instead of writing on each stream event.
- hz VPS: `container/agent-runner/src/index.ts` — (1) `lastAssistantText` declaration placed correctly at line 418. (2) Added `break` after result message for scheduled tasks (SDK stream doesn't close after result). (3) Added `containerInput.isScheduledTask` check in message loop. (4) Changed `main()` to `main().then(() => process.exit(0))` (open MCP handles kept Node alive).
- hz VPS: `data/sessions/main/agent-runner-src/index.ts` — Synced with above.
- hz VPS: `src/db.ts` — Fixed SQL: `THEN paused` → `THEN 'paused'`, `THEN completed` → `THEN 'completed'` (unquoted string literals treated as column names).
- hz VPS: `src/container-runner.ts` — Added `delegate-requests` and `delegate-responses` to mkdirSync on container startup.
- hz VPS: `container/agent-runner/src/ipc-mcp-stdio.ts` — Replaced grep-based recall with pure JS BM25 search. Files split into 10-line overlapping chunks, ranked by BM25 score. Added `EMBEDDING_URL` env var hook for future semantic search.
- hz VPS: `data/sessions/main/agent-runner-src/ipc-mcp-stdio.ts` — Synced with above.
- Local: `memory/MEMORY.md` — Updated patches list.
**Progress:**
- DONE: Delegation end-to-end working — tested: scheduled task → Adam → delegate_task → IPC → host spawns worker → worker answers → host writes response → Adam reports result → both containers exit cleanly. 22s full chain.
- DONE: BM25 recall — pure JS implementation, zero deps. Tested with Sonnet: "brandon" search found knowledge/security.md correctly.
- DONE: Skipped heartbeat (morning cron already covers it) and lightweight mode (container overhead is fine for 3-5 daily crons).
- DONE: Honest assessment — NanoClaw+patches is more capable than OpenClaw (session resumption, Claude Code, delegation, x402) but fragile (monkey-patches, no tests, upstream updates could break). Works as private bot, needs proper fork for open source.
**Test results:**
- Delegation: "What is 7 times 8?" → worker returned "56" → Adam reported "56" → task completed in 22s
- BM25 recall: "brandon" → found knowledge/security.md with correct content and relevance score
- SQL fix: task status properly set to 'completed' (was failing with "no such column: completed")
- Container exit: "Scheduled task got result, breaking message loop" + "Scheduled task complete, exiting" logged correctly
**Key context:**
- Delegation bugs found and fixed this session: (1) IPC path mismatch, (2) SQL unquoted literals, (3) SDK message stream never closes after result (need manual break), (4) Node.js hangs on exit due to open MCP handles (need process.exit)
- MiniMax model can't discover/use MCP tools (recall test failed with MiniMax, works with Sonnet)
- Heartbeat and lightweight mode evaluated and skipped — not worth the complexity for current scale
- User considering proper fork vs continuing monkey-patch approach for open source
- `LOG_LEVEL=debug` reverted to default in systemd service

---
## 2026-02-27 - Pre-Compact: Delegation, DM allowlist, credential scrubbing, IronClaw/GoClaw/OpenClaw features

**SDLC Stage:** N/A (ops session — EasyClaw feature parity from competitor repos)
**Task:** Add delegation (GoClaw), DM allowlist + stale skip (OpenClaw), credential scrubbing (IronClaw), test delegation
**Modified files:**
- hz VPS: `src/delegation-handler.ts` — NEW: Host-side delegation handler. Watches IPC for delegate-requests, spawns worker containers, writes results to delegate-responses. Max 3 concurrent workers.
- hz VPS: `container/agent-runner/src/ipc-mcp-stdio.ts` — Added `delegate_task` MCP tool (writes request to IPC, polls for response). Also fixed `z.record(z.string())` → `z.record(z.string(), z.string())` for Zod compat.
- hz VPS: `container/agent-runner/src/index.ts` — Added `lastAssistantText` capture from assistant messages so delegation results include actual response text. **IN PROGRESS — TS compilation error, `lastAssistantText` declaration placement wrong. Need to add `let lastAssistantText: string | null = null;` before line 418 (the `for await` loop).**
- hz VPS: `src/container-runner.ts` — Added `scrubCredentials()` function. Redacts API keys, tokens, private keys, Discord tokens from stderr logs.
- hz VPS: `src/router.ts` — Added `scrubOutboundCredentials()`. Redacts secrets from outbound Discord messages before sending.
- hz VPS: `src/channels/discord.ts` — Added DM allowlist (`ALLOWED_USERS` import + filter) + stale message skip (`startedAt` timestamp check).
- hz VPS: `src/config.ts` — Added `ALLOWED_USERS` config export (reads from .env, comma-separated Discord user IDs, empty = allow all).
- hz VPS: `src/index.ts` — Added delegation-handler import + `startDelegationHandler()` call.
- hz VPS: `.env` — Added `ALLOWED_USERS=524122516717961224` (Brandon's Discord ID).
- hz VPS: `groups/main/CLAUDE.md` — Added Delegation skill section (delegate_task usage, rules, examples).
- hz VPS: `groups/global/CLAUDE.md` — Added Delegation section for all agents.
- Local: `memory/MEMORY.md` — Updated patches list, EasyClaw architecture section with delegation/scrubbing/allowlist.
**Progress:**
- DONE: DM allowlist — only Brandon's Discord ID (524122516717961224) gets through. Others silently ignored.
- DONE: Stale message skip — messages from before process start dropped on restart.
- DONE: Credential scrubbing — regex-based redaction on stderr logs AND outbound Discord messages.
- DONE: Delegation handler — host-side, spawns worker containers, max 3 concurrent.
- DONE: delegate_task MCP tool — container writes request, polls for response.
- DONE: Delegation handler starts on boot (confirmed in journalctl: "Delegation handler started").
- DONE: Worker containers spawn and run successfully (exit code 0, ~12-15s with minimax).
- **BUG: Worker output not captured** — Agent SDK's `result` message has `result: null`, actual text is in `assistant` messages. Fix: added `lastAssistantText` capture in agent-runner index.ts. BUT the `let` declaration was placed outside the function scope (line 417 sed insertion didn't match the `for await` pattern correctly). **Need to add the declaration at the right line number.**
- DONE: Researched IronClaw (Rust, WASM sandbox, hybrid BM25+pgvector search, heartbeat system, routine lightweight mode, per-job orchestrator tokens).
- DONE: Researched GoClaw (Go, delegation as first-class, lane-based scheduler, prompt caching, runtime custom tools, hybrid memory).
**Test results:**
- DM allowlist: verified — config export added, filter in discord.ts, service restarted
- Stale message skip: verified — startedAt timestamp check before processing
- Credential scrubbing: host build clean, scrubCredentials() added to container-runner + router
- Delegation IPC: request picked up within 500ms, "Processing delegation request" logged
- Worker container: spawns, runs ~12-15s with minimax, exits 0 — but result is `null` (assistant text not captured)
- z.record fix: `z.record(z.string(), z.string())` fixes Zod compat error in container TS compilation
**Key context:**
- Delegation IPC flow: Container `delegate_task` → writes `/workspace/ipc/delegate-requests/{id}.json` → host delegation-handler spawns worker container → worker runs → result written to `/workspace/ipc/delegate-responses/{id}.json` → container reads response
- **BUG FIX NEEDED:** In `container/agent-runner/src/index.ts` (and `data/sessions/main/agent-runner-src/index.ts`), the `lastAssistantText` variable declaration must be placed INSIDE `runQuery()` function, right before line 418 (`for await (const message of query({`). Current state: the capture code and `textResult || lastAssistantText || null` fallback are in place, but the `let` declaration is missing.
- IronClaw features to add next: BM25 hybrid search (recall is just grep), heartbeat system (periodic self-check), routine lightweight mode (single LLM call crons)
- NanoClaw debug logging temporarily enabled: `LOG_LEVEL=debug` in systemd service file. **Remember to revert to default before leaving.**
- User wants next: BM25 search, heartbeat system, routine lightweight mode

---
## 2026-02-27 - Pre-Compact: Agent OS template, x402 payments, OpenFang/Ramya learnings, ACP started

**SDLC Stage:** N/A (ops session — EasyClaw architecture + Adam hardening)
**Task:** Generalize agent template, build x402 host-side payments, apply memory discipline learnings, start ACP
**Modified files:**
- hz VPS: `groups/global/CLAUDE.md` — NEW: Universal Agent OS (218 lines) — boot sequence, write discipline, memory architecture, multi-phase playbooks, nightly consolidation, learnings system, cost awareness. Every agent inherits this.
- hz VPS: `groups/main/CLAUDE.md` — SLIMMED: Adam-only identity (101 lines, was ~200). Moved all generic patterns to global. Added x402 Payments skill section.
- hz VPS: `groups/main/learnings/LEARNINGS.md` — NEW: 31 starter rules from real experience (DB path, proxy routing, write discipline, crons, communication)
- hz VPS: `src/x402-handler.ts` — NEW: Host-side x402 payment handler. Reads wallet key from .env (never enters container). Watches IPC for x402-requests, makes HTTP requests with @x402/fetch, writes responses back. Pattern 2 from Browser Use article.
- hz VPS: `src/index.ts` — Added x402 handler import + startup call
- hz VPS: `src/db.ts` — Added `consecutive_errors` column migration + updated `updateTaskAfterRun()` with error tracking and auto-pause after 5 failures
- hz VPS: `src/task-scheduler.ts` — Passes wasError flag to updateTaskAfterRun, logs auto-pause, notifies Discord channel when cron auto-pauses
- hz VPS: `container/agent-runner/src/ipc-mcp-stdio.ts` — Added `x402_fetch` MCP tool (writes request to IPC, polls for response from host — private key never in container)
- hz VPS: `templates/` — NEW: Agent starter template (CLAUDE.md, learnings, knowledge files, README for spinning up N agents)
- hz VPS: `package.json` — Added @x402/fetch, @x402/evm, viem as host dependencies
- hz VPS: `.env` — Added BASE_WALLET_PRIVATE_KEY and BASE_WALLET_ADDRESS
- Local: `memory/MEMORY.md` — Updated with cron jobs, patches list, DB gotcha
**Progress:**
- DONE: Agent OS split — global/CLAUDE.md (universal) + groups/{agent}/CLAUDE.md (identity only). Any new agent inherits boot sequence, write discipline, memory system, playbooks.
- DONE: Learnings system — learnings/LEARNINGS.md with 31 starter rules. Read on boot, append on mistakes.
- DONE: Cron auto-disable — consecutive_errors column, auto-pauses after 5 failures, notifies Discord channel.
- DONE: x402 payment tools — host-side handler (secure pattern). Container writes IPC request → host signs payment with wallet key → writes response back. Private key never enters container.
- DONE: Base wallet created — 0xeC33e6455657103F11bBD7d5dc2d11BaA8B1Fb1B (empty, needs USDC funding)
- DONE: x402 round-trip test — httpbin GET returned 200 via IPC in ~1 second
- DONE: Template directory — `cp -r templates/agent-starter groups/{name}` to spin up new agents
- DONE: Applied Ramya's memory discipline (boot sequence, write discipline, MEMORY.md curation rules, handover protocol, learnings compounding)
- DONE: Applied OpenFang patterns (multi-phase playbooks for research/content/outreach, memory decay in consolidation, cron auto-disable)
- DONE: Applied Browser Use Pattern 2 (agent=disposable, host=command center, private keys never in container)
- IN PROGRESS: ACP server — @agentclientprotocol/sdk installed on host, example agent studied, implementation started but interrupted by compact
- NOT DONE: ACP adapter wrapping NanoClaw (needs: ACP stdio server → forwards prompts to Adam via IPC/DB → streams responses back)
- NOT DONE: Wallet funding (0 USDC on Base)
- NOT DONE: Stripe keys, X OAuth, Gmail SMTP, adamloveai.com site
**Test results:**
- Host build: clean (tsc compiled without errors)
- x402 handler: wallet initialized, polling started (journalctl confirmed)
- x402 round-trip: httpbin GET → status 200, body returned via IPC, paid=false (no paywall)
- Cron auto-disable: consecutive_errors column exists in SQLite, updateTaskAfterRun accepts wasError param
- NanoClaw service: active (running), Discord bot connected
**Key context:**
- Architecture: Agent (container) = disposable worker with no secrets. Host (NanoClaw) = command center holding all keys. IPC is the gateway.
- x402 flow: Container x402_fetch → writes /workspace/ipc/x402-requests/{id}.json → host reads, makes @x402/fetch with wallet key → writes /workspace/ipc/x402-responses/{id}.json → container reads response
- ACP protocol: JSON-RPC over stdio, agent implements initialize/session_new/session_prompt, streams responses via sessionUpdate notifications. SDK: @agentclientprotocol/sdk. Example agent at dist/examples/agent.js.
- ACP for EasyClaw: makes agents driveable from IDEs (Zed, Cursor). Stack: MCP (tools) + ACP (orchestration) + x402 (payments).
- EasyClaw template: `templates/agent-starter/` — copy to groups/{name}, edit CLAUDE.md, register Discord channel. Agent inherits global OS automatically via CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1.
- Two articles applied: Ramya Chinnadurai's OpenClaw memory debugging (write discipline, boot sequence, learnings, handover protocol) + Larsen Cundric's Browser Use sandbox architecture (Pattern 2: isolate the agent, host holds all secrets)
- OpenFang patterns applied: multi-phase playbooks (research 6-phase, content 5-phase, outreach 5-phase), memory confidence decay in consolidation, cron auto-disable after 5 failures

---
## 2026-02-27 - Pre-Compact: SDK upgrade, cron jobs, recall/remember tools, SignalWire, container beefup

**SDLC Stage:** N/A (ops session — making Adam self-sufficient)
**Task:** Upgrade Agent SDK, set up crons, build memory tools, add phone access, beef up container
**Modified files:**
- hz VPS: `container/agent-runner/src/ipc-mcp-stdio.ts` — added recall, remember, send_sms, check_messages, make_call, check_calls MCP tools
- hz VPS: `container/agent-runner/src/index.ts` — passes SIGNALWIRE_* env vars to MCP server process
- hz VPS: `container/agent-runner/package.json` — Agent SDK 0.2.34 → 0.2.62
- hz VPS: `src/container-runner.ts` — added getRecentMessages import, conversation history dump before container runs, SIGNALWIRE_* in readSecrets()
- hz VPS: `src/db.ts` — added getRecentMessages() function
- hz VPS: `container/Dockerfile` — expanded with python3, ffmpeg, jq, imagemagick, gawk + 15 npm packages (axios, cheerio, nodemailer, stripe, openai, sharp, rss-parser, csv-parse, date-fns, lodash, pdf-parse, marked, turndown, dotenv), NODE_PATH=/app/node_modules
- hz VPS: `groups/main/CLAUDE.md` — added Recall & Memory Tools skill, Phone (SignalWire) skill, Building Your Own Tools skill
- hz VPS: `groups/main/scripts/README.md` — created scripts folder
- hz VPS: `.env` — added SIGNALWIRE_PROJECT_ID, SIGNALWIRE_API_TOKEN, SIGNALWIRE_SPACE_URL, SIGNALWIRE_PHONE_NUMBER
- hz VPS: `store/messages.db` — 3 cron jobs inserted (morning heartbeat, email check, nightly consolidation)
- Local: MEMORY.md — updated with DB path fix, cron docs, container packages, patch list
**Progress:**
- DONE: Agent SDK upgraded 0.2.34 → 0.2.62 (memory leak fix in 0.2.51, getSessionMessages in 0.2.59)
- DONE: 3 cron jobs bootstrapped — morning heartbeat (7am SGT, minimax), email check (9am+5pm SGT, minimax), nightly consolidation (midnight SGT, sonnet)
- DONE: recall MCP tool — grep-searches workspace files by keyword
- DONE: remember MCP tool — appends/writes to workspace files with path safety
- DONE: Conversation history dump — host writes recent-history.md with last 100 messages before each container run
- DONE: SignalWire MCP tools — send_sms, check_messages, make_call, check_calls (via WireGuard proxy)
- DONE: Container beefed up — python3, ffmpeg, imagemagick, jq + 15 npm packages, NODE_PATH set
- DONE: Adam's CLAUDE.md updated with 3 new skill sections (memory, phone, self-service tools)
- DONE: All tested — recall wrote to patterns.md, SignalWire API returned 200, container packages verified (date-fns, axios, stripe all importable)
- CRITICAL FIX: DB is store/messages.db NOT data/nanoclaw.db (wasted 15 min inserting into wrong file)
- NOT DONE: x402 (Coinbase agent payments) — researched, npm packages exist, needs wallet private key
- NOT DONE: ACP (Agent Client Protocol) — researched, open spec from Zed Industries, npm SDK exists
- NOT DONE: Stripe keys not configured
- NOT DONE: X OAuth still expired
- NOT DONE: adamloveai.com site still down
- NOT DONE: Gmail SMTP still broken
**Test results:**
- SDK upgrade test: container ran, exit 0, 9s (minimax model override working)
- Recall test: searched for "Brandon", found results in knowledge files, wrote "Recall tool works - tested 2026-02-27" to patterns.md
- SignalWire test: check_messages returned 2 messages from API, container exit 0
- Container packages: date-fns (306 days remaining), axios (function), stripe (function) — all verified
- Crons: scheduler picked up tasks from store/messages.db after restart, test task completed in 60s polling cycle
**Key context:**
- DB path gotcha: NanoClaw uses store/messages.db (STORE_DIR/messages.db in db.ts), NOT data/nanoclaw.db
- Agent SDK Memory Tool (memory_20250818) is NOT available via Agent SDK — would need direct API calls
- x402 protocol: server returns 402 + payment header, client signs ERC-3009 USDC transfer, retries. No gas needed. npm: @x402/fetch @x402/evm @x402/express. Any EVM wallet works.
- ACP protocol: JSON-RPC 2.0 over stdio. npm: @agentclientprotocol/sdk. Makes Adam driveable from IDEs (Zed, Cursor). Complementary to MCP (MCP=tools, ACP=orchestration, x402=payments).
- EasyClaw vision: open-source core + hosted service. Adam as proof of concept. Stack: MCP (tools) + ACP (orchestration) + x402 (payments).
- Container image now 2.61GB (was 1.64GB) — NODE_PATH=/app/node_modules makes pre-installed packages accessible from /workspace/group/
- Next steps from user: x402 implementation (needs wallet private key), then ACP server

---
## 2026-02-27 - Pre-Compact: Per-task model override + memory research

**SDLC Stage:** N/A (ops session — continuation of NanoClaw deployment)
**Task:** Add per-task model override to NanoClaw, research Agent SDK memory
**Modified files:**
- hz VPS: `src/types.ts` — added `model?: string` to ScheduledTask interface
- hz VPS: `src/db.ts` — SQLite migration adds `model` column, included in createTask
- hz VPS: `src/ipc.ts` — accepts `model` from IPC task data
- hz VPS: `container/agent-runner/src/ipc-mcp-stdio.ts` — `schedule_task` MCP tool now has `model` parameter
- hz VPS: `src/task-scheduler.ts` — passes `task.model` to container input
- hz VPS: `container/agent-runner/src/index.ts` — sets `ANTHROPIC_MODEL` env var in SDK when model specified
- hz VPS: `/root/scripts/update-nanoclaw.sh` — added agent-runner-src sync step
- hz VPS: `data/sessions/main/agent-runner-src/` — force-synced with patched source
- Local: `MEMORY.md` — added per-task model override docs + OpenRouter model costs
**Progress:**
- DONE: Per-task model override — 7 files patched across host + container
- DONE: Built host (`npm run build` — clean), rebuilt container image (`nanoclaw-agent:latest`)
- DONE: Tested 3 times with `minimax/minimax-m2.5` — all completed successfully, Discord messages delivered
- DONE: CRITICAL learning — agent-runner-src in `data/sessions/*/` is stale copy, must be synced after patches (added to update script)
- DONE: Cleaned up test tasks from SQLite
- DONE: Updated update-nanoclaw.sh with agent-runner sync loop
- IN PROGRESS: Research on Claude Agent SDK memory system
- NOT DONE: Upgrade Agent SDK from 0.2.34 → 0.2.62 (28 versions behind)
- NOT DONE: Enable/configure Memory Tool (new API feature `memory_20250818`)
- NOT DONE: NanoClaw cron jobs still not created (heartbeat, email, Twitter, nightly consolidation)
- NOT DONE: Nightly consolidation cron (critical for anti-amnesia)
**Test results:** 3/3 MiniMax model override tests passed — tasks completed, Discord messages sent
**Key context:**
- Per-task model override flow: schedule_task MCP tool → IPC file → host ipc.ts → SQLite (model column) → task-scheduler.ts → container-runner.ts → agent-runner sets ANTHROPIC_MODEL env var → Claude Code uses specified model
- Agent-runner-src stale copy gotcha: NanoClaw copies `container/agent-runner/src` to `data/sessions/{group}/agent-runner-src/` on first run and NEVER updates it. Must manually sync after patching. First test ran without model override because of this.
- MiniMax M2.5 via OpenRouter: $0.30/$1.10 per M tokens, works with Claude Agent SDK through Anthropic-compatible endpoint. 10x cheaper than Sonnet for grunt crons.
- Agent SDK v0.2.34 installed, latest is v0.2.62. 28 versions behind.
- Claude API has new Memory Tool (`memory_20250818`) — client-side tool that lets agent store/retrieve info across sessions. Could solve amnesia. Need to check if Agent SDK exposes this.
- Claude Code auto-memory (`MEMORY.md` in `.claude/projects/`) is enabled but EMPTY — Adam hasn't written anything to it yet
- NanoClaw already has session resumption (SQLite stores session IDs, conversations resume same session) — this is the #1 anti-amnesia feature vs OpenClaw
- 4 memory layers available: (1) session resumption, (2) CLAUDE.md identity loaded every turn, (3) Claude Code auto-memory, (4) workspace files
- Gap: no nightly consolidation cron exists yet — when session compacts, detailed context is lost
- OpenClaw amnesia root causes: no session resumption (fresh conversation every message), embedding search unreliable, compaction lost critical details

---
## 2026-02-27 - Snapshot: OpenClaw deleted, NanoClaw deployed, Adam Love live on Discord

**Task:** Migrate from OpenClaw to NanoClaw for Adam Love bot
**Modified files:**
- hz VPS: OpenClaw completely deleted (containers, images, data, source, scripts, crontab)
- hz VPS: `/root/nanoclaw-src/` — applied add-discord skill, patched container-runner.ts for OpenRouter
- hz VPS: `/root/nanoclaw-src/.env` — OpenRouter key, Discord bot token, email creds, ASSISTANT_NAME=Adam
- hz VPS: `/root/nanoclaw-src/groups/main/CLAUDE.md` — full Felix-inspired identity (3-layer memory, daily workflow, security model, bottleneck removal)
- hz VPS: `/root/nanoclaw-src/groups/main/knowledge/` — patterns.md, preferences.md, security.md seeded
- hz VPS: `/etc/systemd/system/nanoclaw.service` — systemd service created, enabled
- hz VPS: `/root/scripts/update-nanoclaw.sh` — weekly update script (git pull + rebuild + restart)
- hz VPS: Crontab: weekly NanoClaw update Sundays 4am SGT, credit-monitor.sh reads from nanoclaw .env now
- Local: MEMORY.md rewritten for NanoClaw era
**Progress:**
- DONE: Deleted all OpenClaw from hz (containers, images, data, source, scripts)
- DONE: Applied add-discord skill to NanoClaw (390 tests passed)
- DONE: Patched container-runner.ts to pass ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN (OpenRouter hack)
- DONE: Created .env with OpenRouter, Discord, email config
- DONE: Wrote comprehensive Adam Love CLAUDE.md based on Felix Craft patterns (Nate Eliason interview)
- DONE: Created workspace structure (projects/, areas/, resources/, archive/, daily/, knowledge/, conversations/)
- DONE: Seeded knowledge files (patterns.md, preferences.md, security.md)
- DONE: systemd service running, Discord bot connected as AdamLoveAI#7931
- DONE: Registered Discord channel dc:1476734997493973142 → groups/main
- DONE: Weekly update cron (Sundays 4am SGT)
- DONE: Full OpenClaw vs NanoClaw comparison analysis
- NOT DONE: NanoClaw cron jobs (heartbeat, Twitter checks, email checks, nightly consolidation) — not yet created
- NOT DONE: Stripe keys not added to .env
- NOT DONE: X OAuth tokens still expired
- NOT DONE: adamloveai.com site container not started
- NOT DONE: Container permission issue (EACCES mkdir /home/node/.claude/debug) — chown 1000:1000 applied but may recur on new sessions
**Key context:**
- NanoClaw OpenRouter hack: set ANTHROPIC_BASE_URL=https://openrouter.ai/api + ANTHROPIC_AUTH_TOKEN=<key> + ANTHROPIC_API_KEY="" in .env. container-runner.ts readSecrets() patched to pass these. Survives git stash/pop on updates.
- Container permissions: data/sessions/ must be chown 1000:1000 (node user inside container). Fix applied but update script should include this.
- Felix Craft patterns extracted from YouTube interview: 3-layer memory (PARA + daily notes + tacit knowledge), nightly consolidation cron, 6-8 Twitter crons, heartbeat monitors open projects, bottleneck removal philosophy, authenticated vs information channels
- NanoClaw cron system is SQLite-backed, created by agent via MCP tools (schedule_task). No config file like OpenClaw's jobs.json. Agent must create its own crons from Discord.
- NanoClaw's biggest gap vs OpenClaw: NO memory/embedding system. Just plain filesystem. Nightly consolidation cron is a workaround.
- Adam responded to a test message in Discord (typing indicator + response seen by user)

---
## 2026-02-26 - Session End: Script fixes, NanoClaw research, staying on OpenClaw

**What we worked on:** Fixed 4 host scripts on hz that still referenced dead bots (LeadGen, SocialBot). Critical: daily-update.sh would have resurrected dead bot containers at next 3am update. Researched NanoClaw as OpenClaw replacement — cloned repo, built agent container, analyzed architecture. User initially wanted to switch, then decided to stay on OpenClaw, then changed mind again wanting NanoClaw with Discord. NanoClaw agent container built on hz but Discord channel not yet implemented.
**What worked:** All 4 scripts (daily-update.sh, post-deploy.sh, memory-trim.sh, session-watchdog.sh) updated to Adam Love only. post-deploy.sh tested successfully — Adam healthy, stale sessions purged. Node.js 22 installed on hz for NanoClaw.
**What didn't work:** NanoClaw only ships WhatsApp — Discord requires `/add-discord` skill transformation. Also requires direct Anthropic API key (not OpenRouter). User hasn't confirmed they have one.
**Left off at:** NanoClaw cloned at /root/nanoclaw-src, deps installed, agent container built (nanoclaw-agent:latest). Need: (1) Discord channel implementation, (2) Anthropic API key from user, (3) systemd service, (4) migrate Adam Love identity/memory. OpenClaw still running Adam Love on hz — healthy.
**Key files:** hz VPS: /root/nanoclaw-src/ (cloned, built), /root/scripts/ (all 4 scripts updated). NanoClaw Channel interface at src/types.ts, WhatsApp reference at src/channels/whatsapp.ts.
**Notes for next time:** NanoClaw Channel interface is clean (connect, sendMessage, isConnected, ownsJid, disconnect, setTyping). Discord implementation needs discord.js package + a new DiscordChannel class. Main orchestrator (src/index.ts) hardcodes WhatsApp — needs refactoring to support multiple channels. User MUST provide Anthropic API key before NanoClaw can work. OpenRouter credits ($76/day usage shown) won't work with NanoClaw.

---
## 2026-02-26 - Session End: Fleet consolidation, model experiments, Ramya memory fixes

**What we worked on:** Consolidated from 3 bots to 1 (Adam Love only). Tested Qwen3.5-397B as primary model — too dumb, reverted. Switched all bots to Sonnet 4.6 ($3/$15). Killed LeadGen + SocialBot containers. Applied Ramya Chinnadurai's OpenClaw memory fixes: created learnings/LEARNINGS.md (40 rules from past mistakes), rewrote AGENTS.md from 212→64 lines with explicit boot sequence + write discipline + retrieval instructions. Updated Adam's IDENTITY.md + MEMORY.md to reflect Sonnet 4.6.
**What worked:** Sonnet 4.6 confirmed in logs on all bots. AGENTS.md rewrite eliminates ~600 tokens/session of boilerplate. LEARNINGS.md seeded with real rules from our experience.
**What didn't work:** Qwen3.5-397B was "dumb as fuck" per user — immediately reverted. Gemini 3 Flash was already known to ignore instructions. Non-Claude models can't reliably follow OpenClaw's memory system.
**Left off at:** Only Adam Love running on Sonnet 4.6. Credits $26.24. LG+SB containers stopped (data preserved). Need to monitor burn rate — Sonnet 4.6 at $3/$15 will burn fast.
**Key files:** hz VPS: /root/.openclaw-4/workspace/AGENTS.md (rewritten), /root/.openclaw-4/workspace/learnings/LEARNINGS.md (new), /root/.openclaw-4/workspace/IDENTITY.md + MEMORY.md (model updated)
**Notes for next time:** Monitor burn rate over 24h. If too high, consider: (1) keep Sonnet for conversations only + cheaper model for grunt crons (already MiniMax M2.5), (2) trim more tokens from auto-loaded files, (3) reduce cron frequency. /updatebot skill at .claude/commands/updatebot.md still references ssh jp + 5 bots — not updated yet. adamloveai.com site container still not started. AL+SB KPI crons still not fixed (SB is dead anyway now).

---
## 2026-02-26 - Session End: /updatebot audit, time check rule, SignalWire proxy docs, VPS sweep

**What we worked on:** Verified SignalWire API access from Adam's container (SMS/calls/recordings all 200 via proxy). Added SignalWire proxy instructions to Adam's IDENTITY.md + MEMORY.md. Adam was still hitting port 443 directly (403) — expanded IDENTITY.md with full proxy curl example. Ran /updatebot fleet audit on hz. Added mandatory TIME & SCHEDULE CHECK to all 3 bots' IDENTITY.md + MEMORY.md (must run `date` + check cron schedule before every reply to Brandon). Verified daily-update.sh and memory-trim.sh both exist on hz and work (memory-trim trimmed LG+AL). Cleaned memory-trim.sh to only reference 3 bots. Fixed 8 host scripts still referencing terminated bots (pmtrader, cfo, gateway). Fixed SB openclaw.json perms (644→600). Made 94 scripts executable across containers. Verified model tiering: brain=Gemini 3 Flash, grunt=MiniMax M2.5 (FREE), 1 AL standup on Gemini 2.5 Flash.
**What worked:** All SignalWire endpoints return 200 from inside container via `--resolve adamloveai-com.signalwire.com:8443:10.99.0.2`. WireGuard tunnel healthy (182ms, 0% loss). daily-update.sh pulled new OpenClaw commits and ran post-deploy successfully.
**What didn't work:** Adam ignored MEMORY.md proxy instructions and hit SignalWire directly (403). Only noticed because user forwarded Adam's error. Fix: added full proxy example directly into IDENTITY.md (loaded every turn). Still need to tell Adam in Discord to re-read IDENTITY.md for current session.
**Left off at:** All 3 bots healthy, crons correctly tiered, 8 host scripts cleaned, daily-update + memory-trim verified working on hz. Credits $28.49 remaining.
**Key files:** hz VPS: all 3 IDENTITY.md (TIME CHECK + SignalWire proxy), all 3 MEMORY.md (TIME CHECK RULE), all host scripts in /root/scripts/ (cleaned of old bot refs)
**Notes for next time:** Adam's current session won't pick up IDENTITY.md changes — tell him in Discord to re-read it. Shodan shows port 8881 on hz but nothing is actually listening (stale scan from before UFW). LG created 2 crons itself (Daily Standup, Inbox Monitor) — fixed to MiniMax M2.5. SB had 2 crons on "default" model — fixed. AL+SB KPI stale (37h), AdamLove X OAuth + Bluesky expired, SocialBot cron self-deletion, adamloveai.com site container — all still pending.

---
## 2026-02-26 - Pre-Compact: Fleet cost optimization + security hardening + SignalWire proxy

**SDLC Stage:** N/A (ops session)
**Task:** Fix bot burn rate, security harden new Hetzner server, fix SignalWire 403
**Modified files:**
- hz VPS: all 3 openclaw.json (MiniMax M2.5 model definition added), all 3 cron/jobs.json (19 grunt crons → MiniMax M2.5 FREE, 4 KPI crons Sonnet 4.6 → Gemini 2.5 Flash, all via payload.model), all 3 IDENTITY.md (model identity added), all 3 MEMORY.md (model refs fixed)
- hz VPS: UFW enabled, fail2ban installed (2 jails, 8 IPs banned), SSH hardened (99-hardening.conf), gnupg patches applied, /tmp/test-rsync cleaned
- hz VPS: /etc/wireguard/wg0.conf (WireGuard tunnel to Proxmox)
- pm (Proxmox): /etc/wireguard/wg0.conf, /etc/systemd/system/signalwire-proxy.service (socat TCP proxy)
- pm: LXC 105 actual-budget + VM 9000 ubuntu-cloud DESTROYED
- Local: MEMORY.md updated (cron payload.model lesson, OpenRouter API gotcha, bot identity pattern)
- Local: new skill /check-field-path created
**Progress:**
- DONE: /updatebot fleet audit — all 3 healthy, no errors, crons intact
- DONE: Fixed $51/day burn — 4 Sonnet 4.6 KPI crons → Gemini 2.5 Flash, 19 grunt crons → MiniMax M2.5 (FREE)
- DONE: CRITICAL lesson — cron model override goes in `payload.model` NOT top-level `model` (top-level gets stripped by normalizer)
- DONE: Model identity added to IDENTITY.md + MEMORY.md on all 3 bots, containers restarted
- DONE: Security hardened hz — UFW, fail2ban, SSH hardening, patches, rootkit check, unattended-upgrades
- DONE: WireGuard tunnel hz↔pm + SignalWire socat proxy working
- NOT DONE: AL+SB KPI crons still don't write to /home/node/shared/kpi-*.md
- NOT DONE: AdamLove X OAuth + Bluesky tokens expired
- NOT DONE: SocialBot cron self-deletion unsolved
- NOT DONE: adamloveai.com site container not started on hz
**Key context:**
- Credits: ~$28 remaining, burn should drop significantly with free grunt crons
- SignalWire proxy: `--resolve adamloveai-com.signalwire.com:8443:10.99.0.2`
- WireGuard: hz=10.99.0.1, pm=10.99.0.2

---
## 2026-02-26 - Snapshot: Gemini 3 Flash switch + VPS migration to Hetzner

**Task:** Fix bot amnesia (Haiku 4.5 too dumb), cut costs, migrate infrastructure
**Modified files:** MEMORY.md (full rewrite), ~/.ssh/config (added hz alias), VPS scripts (daily-update.sh, credit-monitor.sh, post-deploy.sh — removed PM+CFO refs)
**Progress:**
- DONE: Switched all 3 bots from Haiku 4.5 → Gemini 3 Flash (cheaper AND smarter)
- DONE: Terminated PMTrader + CFO containers (2 bots killed, saves RAM + compute)
- DONE: Created Hetzner CX23 in Nuremberg (46.225.126.49, €3.80/mo vs $24/mo Vultr)
- DONE: Full migration — rsync data, Docker build, compose up, cloudflared tunnel, crontab, post-deploy
- DONE: All 3 bots healthy on hz, Discord connected, Gemini 3 Flash confirmed in logs
- DONE: Old Vultr (jp) decommissioned — user destroyed server from dashboard
- NOT DONE: AL+SB KPI cron prompts still don't write to /home/node/shared/kpi-*.md
- NOT DONE: AdamLove X OAuth + Bluesky tokens expired
- NOT DONE: SocialBot cron self-deletion unsolved
**Key context:**
- New VPS: `ssh hz` — 46.225.126.49 (Hetzner Nuremberg CX23, 4GB RAM)
- Old jp (108.160.143.240) DESTROYED by user

---
(Older entries archived to .claude/breadcrumbs-archive.md)
