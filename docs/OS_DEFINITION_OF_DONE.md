# NanoClaw OS v1.0 — Definition of Done

> Internal, Multi-Product Company Ready. Fail-closed by default, repeatable evidence.

**Goal:** The OS can run a multi-product B2B company with one founder, enforcing governance, security, and auditability by default, with repeatable evidence.

---

## 1. Kernel Governance

### 1.1 State machine enforced (host-side, deterministic)

- [x] Valid transitions enforced by policy (graph-based)
- [x] Invalid transitions are DENY with explicit reason code
- [x] Strict mode supported and used for production runs

**Evidence:**
- [x] Policy tests cover all valid transitions + invalid cases (43 policy tests)
- [ ] One E2E pipeline test: `INBOX → TRIAGED → READY → DOING → REVIEW → APPROVAL → DONE`

### 1.2 Idempotency + crash safety

- [x] Dispatch is idempotent (no duplicate enqueue on retries/restarts)
- [x] Optimistic locking prevents lost updates (version check)
- [x] Dispatch loop restart does not corrupt state nor duplicate work

**Evidence:**
- [x] Tests cover: double-dispatch, version conflict, restart simulation (disaster-recovery.test.ts)

### 1.3 Separation of powers

- [x] Gate approver mapping enforced
- [x] Approver ≠ executor enforced
- [x] Override path exists and is audit-tracked (main override logged in ext_calls)

**Evidence:**
- [x] `gates` tests + `ipc` tests (11 gates + 72 ipc tests)

---

## 2. Multi-Product Company Readiness

### 2.1 Product is first-class

- [x] `products` table exists with `status` + `risk_level`
- [x] Governance tasks support `scope = COMPANY | PRODUCT`
- [x] Invariants enforced:
  - [x] COMPANY tasks cannot have `product_id`
  - [x] PRODUCT tasks without product_id coerced to COMPANY (audit-tracked via coerce_scope activity)

**Evidence:**
- [x] Schema + CRUD tests (gov-db + ext-broker-db tests)
- [x] Policy tests for scope/product invariants (gov-ipc scope coercion tests)

### 2.2 Portfolio isolation (logical)

- [x] Tasks, approvals, activities are queryable by `product_id` and `scope`
- [x] Dispatch prompts include product context when applicable (Context Pack)
- [x] Minimum "portfolio views" exist (CLI queries / snapshots) without requiring UI

**Evidence:**
- [x] `gov-db` query tests + snapshot test + ops-metrics tests

---

## 3. External Access Broker

### 3.1 Capability model enforced

- [x] Capability grants are per-group, per-provider, per-level (L0–L3)
- [x] Deny-wins precedence
- [x] L2/L3 have mandatory expiry (≤ 7 days)
- [x] L3 requires two-man rule (approvals from different groups)

**Evidence:**
- [x] Broker tests cover deny-wins, expiry, two-man rule, idempotency (56 ext-broker tests)

### 3.2 Governance coupling (no "out-of-band" actions)

- [x] `ext_call` requires `task_id`
- [x] Broker validates:
  - [x] Task exists
  - [x] `task.state ∈ {DOING, APPROVAL}`
  - [x] `task.assigned_group` matches caller group (main can override)
  - [x] (if PRODUCT scope) product context is present and logged
- [x] Every external call writes an audit record with:
  - [x] HMAC-SHA256 of params (never raw)
  - [x] Sanitized summary
  - [x] Status + duration
  - [x] Linked `task_id`
  - [x] Linked `product_id` if applicable

**Evidence:**
- [x] Tests: `ext_call` denied for INBOX/DONE and allowed for DOING (broker coupling tests)
- [x] DB audit tests verify HMAC params hash (not raw) stored

### 3.3 Secure IPC request/response

- [x] Requests are signed per-group (HMAC)
- [x] Response delivery is atomic (`tmp` + `rename`)
- [x] Backpressure enforced (max pending requests)
- [x] Inflight lock prevents double execution

**Evidence:**
- [x] Tests cover signing failure, backpressure, inflight lock (P0-1, P0-7, P0-8 tests)

---

## 4. Observability + Audit

### 4.1 Append-only audit trail

- [x] `gov_activities` is append-only in practice (no updates/deletes in code paths)
- [x] `ext_calls` is append-only
- [x] Every mutation logs: actor, action, timestamps, reason codes

**Evidence:**
- [x] Unit tests assert audit entries created for create/transition/approve/override/ext_call

### 4.2 No secrets / no PII in logs

- [x] Logs do not emit tokens, raw payloads, or sensitive text
- [x] Any deny logs store only reason + hashes (never raw)

**Evidence:**
- [x] HMAC-SHA256 params hash stored (never raw params); sanitized .env in backups

---

## 5. Operational Model

### 5.1 Single-host explicit ops model

- [x] Documented RPO/RTO targets for v1 (OS_OPERATING_MODEL.md)
- [x] Backup & restore runbooks exist and are executable:
  - [x] SQLite backup (`npm run ops:backup` — VACUUM INTO atomic snapshot)
  - [x] Sanitized .env + version.json + manifest.json
  - [x] Restore procedure (`npm run ops:restore` with --force flag)
- [x] Disaster recovery steps are written and tested (disaster-recovery.test.ts, 5 tests)

**Evidence:**
- [x] `docs/OS_BACKUP_AND_RESTORE.md` + `scripts/backup-os.ts` + disaster-recovery.test.ts

### 5.2 Safe change process

- [x] Policy/schema changes follow a process: proposal → tests → review → merge
- [x] Policy version tracked on every task and ext_call (POLICY_VERSION in metadata)
- [x] "Stop-the-line" rule: changes must bump POLICY_VERSION and be logged in OS_CHANGE_LOG.md

**Evidence:**
- [x] `docs/POLICY_CHANGE_PROCESS.md` + `docs/OS_CHANGE_LOG.md` + `src/governance/policy-version.ts`

---

## 6. Agent Operating Standard

### 6.1 Core groups present and correct

- [x] `groups/main/CLAUDE.md` includes governance + broker usage + triage rules
- [x] `groups/developer/CLAUDE.md` includes delivery discipline + transition rules
- [x] `groups/security/CLAUDE.md` includes gate review + veto rules
- [x] `groups/global/` contains shared operating facts (incl. `USER.md`)

**Evidence:**
- [x] Repo contains files (groups/main, developer, security, global CLAUDE.md files)

### 6.2 Cross-agent context (minimum viable)

- [x] When a task moves DOING → REVIEW/APPROVAL, dispatch prompt includes:
  - [x] Recent `gov_activities`
  - [x] Execution summary (getGovTaskExecutionSummary)
  - [x] Evidence links
- [x] Approver can review without needing chat history

**Evidence:**
- [x] `gov-loop` test validating prompt contains Context Pack (8 tests)

---

## 7. Acceptance Proof — Final "OS GO" Checklist

To declare OS v1.0 DONE, run this playbook and confirm each step:

- [ ] Create Product "Ritmo"
- [ ] Create PRODUCT task, assign developer, move to READY
- [ ] Auto-dispatch to developer (DOING)
- [ ] Developer transitions to REVIEW with evidence
- [ ] Auto-dispatch to security, approve gate, move to DONE
- [ ] Perform one L2 `ext_call` (GitHub issue/PR) tied to the task
- [ ] Verify audit in `gov_activities` + `ext_calls`
- [ ] Run backup scripts and verify files exist

**Evidence:**
- [ ] A dated "OS v1.0 acceptance run" record (output snippets + commit SHA)

---

## Scope Note (explicit)

Memory embedding guard (L0–L3 + PII sanitization) is **not required** for OS v1.0 if embeddings are not enabled. It becomes required before handling real client PII or enabling embedding-based memory search.
