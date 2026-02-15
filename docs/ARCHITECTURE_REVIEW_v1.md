# NanoClaw OS — Architecture Review v1

> Lead Architect + PMO review. Scope: multi-product company readiness.

---

## 1. Current Strengths (Do Not Change)

These invariants are correct and battle-tested (316 tests). Any future work must preserve them.

**1.1 Governance Kernel**
- **Deterministic state machine.** 8 states, 18 valid transitions, fail-closed on unknown. No runtime configuration — the graph is compiled into `policy.ts`.
- **Optimistic locking.** `updateGovTask(id, expectedVersion, updates)` increments version atomically. Stale writes fail silently. This is the right concurrency model for SQLite.
- **Idempotent dispatch.** `UNIQUE(dispatch_key)` pattern with key format `{taskId}:{transition}:v{version}`. Crash-restart produces zero duplicate containers.
- **Append-only audit.** `gov_activities` is INSERT-only with FK to `gov_tasks`. Every transition, approval, assignment is recorded with actor + reason.
- **Separation of powers.** `checkApproverNotExecutor()` is enforced in `gov_approve` IPC, not advisory. Cannot be bypassed from container.

**1.2 External Access Broker**
- **Capability-based, not role-based.** Per-group, per-provider, with explicit allow/deny lists. Deny-wins is correct.
- **Host executes, container requests.** Zero secrets in containers. Zero network in containers.
- **HMAC param hashing.** `ext_calls.params_hmac` stores `HMAC-SHA256(params, secret)`, not raw params. No PII in evidence table.
- **Inflight lock.** INSERT with `status='processing'` + UNIQUE `request_id` prevents double-execution.
- **Broker coupling.** L2+ with `task_id` validates task state (DOING/APPROVAL) and group assignment. This closes the governance↔broker gap.
- **Two-man rule.** L3 requires 2+ approvals from different groups. Not advisory.

**1.3 Architecture**
- **Single process, single DB.** No distributed state, no eventual consistency bugs. SQLite WAL mode is sufficient for the concurrency model (one writer, serial dispatch loop).
- **File-based IPC with atomic writes.** `tmp+rename` pattern is crash-safe on ext4/APFS.
- **Container isolation via Apple Container.** OS-level, not application-level. This is categorically stronger than OpenClaw's process isolation.

---

## 2. Gaps vs Multi-Product Company OS

### 2.1 Product as First-Class Entity (GAP — CRITICAL)

**Current state:** `gov_tasks.product` is `TEXT | null` — free-form string, no validation, no index enforcement. There is no `products` table.

**Problem:** When Ritmo launches and a second product follows, there is no way to:
- Scope tasks to a product with referential integrity
- Query pipeline by product efficiently
- Scope ext_capabilities per product (e.g., developer has L2 on Ritmo's repo but L1 on product-B's)
- Separate company-level tasks (OPS, INCIDENT) from product-level tasks (FEATURE, BUG)

**Decision to lock:** Product must become a first-class entity with its own table, referenced by FK from `gov_tasks` and optionally from `ext_capabilities`.

### 2.2 Company vs Product Governance (GAP — MODERATE)

**Current state:** All tasks flow through one pipeline. No distinction between "company ops" (hiring, legal, infra) and "product work" (features, bugs).

**Problem:** A founder needs two views: "how is the company running?" vs "how is Ritmo doing?" Without board/domain separation, everything is one flat list.

**Decision to lock:** Add `domain` column to `gov_tasks` with values `company | product`. Company tasks have no product FK. Product tasks require product FK. This is purely additive.

### 2.3 WIP Limits (GAP — LOW)

**Current state:** No WIP enforcement. The dispatch loop will happily dispatch 50 tasks to developer simultaneously.

**Problem:** Agent quality degrades with excessive concurrency. Container resource exhaustion.

**Decision to lock:** WIP limits belong in `dispatchReadyTasks()`, not in schema. Check: `SELECT COUNT(*) FROM gov_tasks WHERE state = 'DOING' AND assigned_group = ?`. Configurable via env var. Default: 2 per agent, 8 total (matches Mission Control).

### 2.4 Schema Migration Strategy (GAP — CRITICAL FOR SAFETY)

**Current state:** Schema is created via `CREATE TABLE IF NOT EXISTS`. No migration versioning. Adding a column requires editing `createGovSchema()` and hoping `IF NOT EXISTS` handles it.

**Problem:** SQLite doesn't support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. Adding columns to existing databases will either fail or require manual migration code.

**Decision to lock:** Add a `schema_version` table. Each migration is a numbered function. `initDatabase()` runs pending migrations. This is additive and doesn't break existing tests.

### 2.5 Ext Capability Scoping (GAP — MODERATE)

**Current state:** `ext_capabilities` is `UNIQUE(group_folder, provider)`. One row per group per provider. No product/repo scoping.

**Problem:** Developer may need L2 to `Josuedutra/ritmo` but L1 to `Josuedutra/infra`. Current schema cannot express this.

**Decision to lock:** Add optional `scope TEXT` column to `ext_capabilities`. When null = all (current behavior). When set = scoped (e.g., `Josuedutra/ritmo`). Change UNIQUE constraint to `UNIQUE(group_folder, provider, scope)`. This is additive — existing rows with `scope=null` keep working.

### 2.6 FK on gov_activities.task_id (GAP — LOW, KNOWN)

**Current state:** FK to `gov_tasks.id`. Broker audit uses sentinel task `__ext_broker__`.

**Decision:** Keep for now. P1 hardening: make `task_id` nullable or add `domain TEXT` column for non-task audit entries.

---

## 3. Risk Register

| # | Risk | Impact | Likelihood | Mitigation | Trigger |
|---|------|--------|-----------|------------|---------|
| R1 | Schema migration breaks existing DB on upgrade | **High** — data loss or boot failure | Medium | Add `schema_version` table + numbered migrations before any column additions | First `ALTER TABLE` needed |
| R2 | Product scoping absent → mixed pipelines as products grow | **High** — governance confusion | High (certain when P2 launches) | Add `products` table + FK in Sprint 1 | Second product created |
| R3 | No WIP limits → agent thrashing under load | **Medium** — quality degradation | Medium | Add dispatch-time WIP check (env-configurable) | >3 concurrent DOING tasks |
| R4 | Sentinel task FK hack → fragile audit integrity | **Low** — cosmetic, audit still works | Low | Make `task_id` nullable on `gov_activities` | Code review complaint |
| R5 | Container build requires macOS → no CI/CD on Linux | **Medium** — manual rebuild only | High (already true) | Document workaround; investigate `lima`/`colima` for Linux builds | Any container code change |
| R6 | ext_capabilities not product-scoped → wrong repos accessible | **Medium** — security boundary leak | Medium | Add `scope` column to `ext_capabilities` | Multi-repo development starts |
| R7 | Single-threaded dispatch loop → starvation under many tasks | **Low** — 10s poll is fine for <50 tasks | Low | Monitor dispatch latency; parallelize if needed | >50 READY tasks queued |
| R8 | No rate limiting on ext_calls → runaway agent burns API quota | **Medium** — cost + API ban | Low (agents are slow) | Add per-group rate window in ext_calls cleanup cycle | Agent loops on failing ext_call |
| R9 | Cross-agent context grows unbounded for long-lived tasks | **Low** — prompt bloat | Medium | Cap `maxActivities` + `maxExtCalls` in `buildTaskContext()` | Task with >50 transitions |
| R10 | No backup/restore for SQLite → data loss on disk failure | **High** — total governance loss | Low (single SSD) | Add periodic WAL checkpoint + backup to object storage | Production reliance on OS |

---

## 4. Sprint Plan

### Sprint 1 — Foundation for Multi-Product (3–4 days)

**Goal:** Make product a first-class entity. Add schema migration framework. No breaking changes.

| Task | DoD | BC Note |
|------|-----|---------|
| Add `schema_migrations` table + runner to `db.ts` | Migrations run on boot; existing DB untouched if up-to-date; test with fresh + existing DB | Additive only |
| Migration 001: Add `products` table (`id TEXT PK, name, created_at, active`) | Table created on boot; no existing data affected | New table |
| Migration 002: Add `domain TEXT DEFAULT 'product'` to `gov_tasks` | Existing tasks get default; index added; query by domain works | `ALTER TABLE ADD COLUMN` |
| Migration 003: Add `scope TEXT` to `ext_capabilities` | Existing rows keep `scope=null` (=all); UNIQUE updated to include scope | `ALTER TABLE ADD COLUMN` + reindex |
| Add `product` CRUD to `gov-db.ts` | `createProduct`, `getProduct`, `listProducts`; tested | Additive |
| WIP limit check in `dispatchReadyTasks()` | Env `GOV_MAX_WIP_PER_GROUP=2` respected; test: 3rd task stays READY | Additive logic |
| Update `gov_create` IPC to accept `product_id` | Validates FK if provided; null still allowed | Backward compatible |
| Tests for all above | All new code has tests; 316+ tests still pass | — |

### Sprint 2 — Operational Hardening (2–3 days)

**Goal:** Close the top risks from register. Production-grade resilience.

| Task | DoD | BC Note |
|------|-----|---------|
| Make `gov_activities.task_id` nullable (migration 004) | Existing rows unchanged; broker audit works without sentinel | Migration |
| Remove sentinel task pattern from `ext-broker.ts` | Grant/revoke logs with `task_id=null`; tests updated | Removes hack |
| Add `ext_calls` rate limiting (sliding window) | Per-group, per-provider; configurable via env; test: burst triggers throttle | Additive |
| SQLite backup mechanism (WAL checkpoint + file copy) | Periodic backup to `data/backups/`; restore tested | Additive |
| Dispatch loop starvation test | Seed 20 READY tasks; verify WIP respected; measure dispatch latency | Test only |
| Capability scope enforcement in broker | `ext_capabilities.scope` matched against `params.owner/repo`; test: scoped deny works | Additive check |

### Sprint 3 — Multi-Product Pipeline (2–3 days)

**Goal:** First real product (Ritmo) runs through the full pipeline with product scoping.

| Task | DoD | BC Note |
|------|-----|---------|
| Create `Ritmo` product record via `gov_create_product` IPC | Product exists in DB; listed in pipeline | Additive |
| Update `gov_pipeline.json` snapshot to include product info | Snapshot has `product_id` + `product_name` per task | Additive field |
| Update `writeGovSnapshot()` to filter by product when requested | Main sees all; product-scoped view available | Additive parameter |
| Scope developer's GitHub capability to Ritmo repos | `ext_capabilities.scope = 'Josuedutra/ritmo'`; test: other repos denied | Uses Sprint 1 scope column |
| End-to-end pipeline test: Ritmo BUG from INBOX→DONE | Create, triage, assign, dispatch, review, approve, done — all with product context | Integration test |
| Update CLAUDE.md files for product awareness | Developer knows which product it's working on; main can filter by product | Doc change |

### Sprint 4 — Company-Level Governance (1–2 days)

**Goal:** Separate company ops from product work. Founder has two clear views.

| Task | DoD | BC Note |
|------|-----|---------|
| `gov_create` with `domain='company'` and no product | Company tasks (OPS, INCIDENT) create without product FK | Additive |
| Pipeline queries: `listByDomain('company')`, `listByProduct('ritmo')` | Both return correct subsets; main sees merged view | Additive queries |
| Update `gov_list_pipeline` MCP tool to accept optional `domain`/`product` filter | Container can request filtered view | Additive parameter |
| Dashboard data: task counts by state × domain × product | Query function exists and is tested | Additive |

---

## 5. Non-Negotiables for NanoClaw OS

These are invariants that must hold across all sprints. Any PR that violates them is rejected.

1. **Fail-closed.** Unknown state/provider/action/gate → deny. No fallback to permissive.
2. **Separation of powers.** `approver != executor` enforced at system level, not advisory.
3. **Audit append-only.** `gov_activities` and `ext_calls` are INSERT-only. No UPDATE, no DELETE (except `cleanupStaleExtCalls` for completed records after TTL).
4. **Idempotency.** Dispatch uses `UNIQUE(dispatch_key)`. Ext calls use `UNIQUE(request_id)`. Capability grants use `UPSERT`. Duplicate operations are safe.
5. **Optimistic locking.** All `gov_tasks` mutations go through `updateGovTask(id, version, updates)`. No direct UPDATE without version check.
6. **Least privilege.** Containers start at L0. Every capability is explicit, per-group, per-provider. No wildcard grants.
7. **No secrets in containers.** Credentials live on host. Params are HMAC-hashed in evidence. Secrets stripped from Bash env in container.
8. **No secrets in logs.** `ext_calls.params_hmac` is HMAC, not cleartext. `params_summary` is sanitized by provider's `summarize()`.
9. **Deterministic policy.** `validateTransition()` is a pure function. No side effects, no external state, no randomness. Given the same inputs, it always returns the same result.
10. **Atomic writes.** All IPC files use `tmp+rename`. All DB writes are transactional (SQLite autocommit or explicit transaction).

---

## 6. Migration & Compatibility Notes

### Schema Evolution Rules

1. **Never DROP or RENAME existing columns.** Use additive `ALTER TABLE ADD COLUMN` only.
2. **Always provide defaults.** New columns must have `DEFAULT` values so existing rows are valid.
3. **Migration runner pattern:**
   ```
   schema_migrations(version INT PK, name TEXT, applied_at TEXT)
   ```
   Each migration is a function `migrate_NNN(db)`. `initDatabase()` runs unapplied migrations in order. Rollback is not supported — design forward-only migrations.

4. **Test with both fresh and existing DB.** CI creates a fresh DB and also runs migrations on a pre-existing test DB to verify both paths.

### Gating Changes with Tests

- **Schema changes:** Write a migration test that creates the old schema, runs the migration, and verifies data integrity.
- **Policy changes:** Add transition tests BEFORE changing the state graph. The test should fail first (red), then pass after the change (green).
- **Broker changes:** Add an auth flow test that asserts the new denial reason BEFORE adding the check. Same red-green pattern.
- **Coupling changes:** If a new system (e.g., product scoping) gates an existing operation (e.g., ext_call), write the test that proves the gate works before wiring it in.

### Backward Compatibility Contract

- All existing tests must pass after every sprint.
- `gov_create` without `product_id` must still work (product is optional).
- `ext_call` without `task_id` must still work for L1 actions.
- `ext_capabilities` without `scope` must still mean "all" (null = wildcard).
- Agents that don't know about products must still function — they just see all tasks.

---

## 7. Decisions Locked Now

| Decision | Rationale | Reversible? |
|----------|-----------|-------------|
| Product is a first-class entity with own table | Multi-product is inevitable; retrofitting FK is harder than adding it now | No (table creation is permanent) |
| `domain` column on `gov_tasks` (company/product) | Separates governance concerns cleanly without schema explosion | Yes (column can be ignored) |
| `scope` column on `ext_capabilities` | Per-repo access control is required for multi-product security | Yes (null = all, backward compatible) |
| Schema migration runner before any ALTER TABLE | Prevents data loss on upgrade; industry standard | No (must exist before first migration) |
| WIP limits are runtime config, not schema | Limits change frequently; no need to persist | Yes (env var, can be removed) |
| Products table is optional FK, not mandatory | Allows company-level tasks without product; progressive adoption | Yes (null product is valid) |

---

*Reviewed against: 316 tests, 13 test files, 4 source modules (gov-db, gov-ipc, gov-loop, ext-broker), 2 provider implementations, 3 agent CLAUDE.md files.*
