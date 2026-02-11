# Phase 10: Polish & Scale Prep

**Goal**: Production hardening, performance optimization, and preparation for scaling.

**Deliverable**: System ready for 5+ tenants with monitoring and observability.

---

## P10-S1: Performance Optimization

**As a** developer
**I want** the system optimized for throughput and latency — SQLite WAL mode, container warm-up tuning, message batching, and session pruning
**So that** the bot handles 500 messages/day without degradation

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P9-S4 | Bulk operations from dashboard | Need all features complete before optimizing the full system |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] SQLite WAL mode enabled for better concurrent reads
2. [ ] Container warm-up: IDLE_TIMEOUT tuned to keep agents alive between messages
3. [ ] Message batching: GroupQueue tuned for optimal throughput
4. [ ] Session pruning: old conversation sessions archived to reduce context size
5. [ ] System handles 500 messages/day without degradation

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/db.ts` | Modify | Enable WAL mode, add session pruning |
| `src/config.ts` | Modify | Tune IDLE_TIMEOUT and GroupQueue settings |
| `src/group-queue.ts` | Modify | Optimize batching parameters |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: SQLite in WAL mode after initialization
   - Test: concurrent reads don't block during writes
   - Test: session pruning removes conversations older than threshold
   - Test: session pruning preserves recent conversations
   - Test: GroupQueue batching handles burst of messages efficiently
   - Test: system processes 500 messages without errors or timeouts
   - Edge case: WAL checkpoint runs without blocking reads
   - Edge case: session pruning during active conversation doesn't lose data
2. **Run tests** — confirm they fail
3. **Implement** — performance optimizations
4. **Refactor** — verify improvements with benchmarks

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the performance optimizations.
Use `/requesting-code-review` to validate:
- WAL mode configuration
- IDLE_TIMEOUT tuning strategy
- Session pruning approach
- Batching parameters

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Load test with 500 messages
- Verify no regressions

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P10-S2: Observability

**As a** DevOps engineer
**I want** Prometheus metrics, Grafana dashboards, and alerting for critical issues
**So that** the team has full visibility into system health, performance, and can be alerted on critical failures

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P10-S1 | Performance optimization | Need optimized system to establish baseline metrics |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Prometheus metrics endpoint exposed
2. [ ] Grafana dashboard for: message volume, response times, container durations, error rates
3. [ ] PagerDuty/webhook alerts for critical issues
4. [ ] Monitoring dashboard shows all key metrics

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/metrics.ts` | New | Prometheus metrics endpoint |
| `k8s/monitoring/` | New | Grafana dashboard config, Prometheus scrape config |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `/metrics` endpoint returns valid Prometheus format
   - Test: message volume metric increments on each message
   - Test: response time metric records durations
   - Test: container duration metric records values
   - Test: error rate metric increments on errors
   - Test: Grafana dashboard JSON is valid
   - Edge case: metrics endpoint available even when bot is unhealthy
2. **Run tests** — confirm they fail
3. **Implement** — metrics and dashboards
4. **Refactor** — optimize metric collection overhead

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the observability stack.
Use `/requesting-code-review` to validate:
- Metric naming conventions
- Dashboard layout
- Alert thresholds

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify metrics endpoint returns data
- Test Grafana dashboard loads

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P10-S3: PostgreSQL Migration Path (Document Only)

**As a** developer
**I want** documented schema migration scripts and decision criteria for moving from SQLite to PostgreSQL
**So that** the team knows when and how to migrate when scale demands it

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S5 | Backup strategy | Need production data management patterns before planning migration |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Schema migration scripts from SQLite → PostgreSQL documented
2. [ ] Migration trigger criteria documented: > 10 tenants or > 50K complaints per tenant
3. [ ] Recommended ORM/query builder documented (Drizzle ORM or Kysely)
4. [ ] PostgreSQL migration documented (not yet implemented)
5. [ ] Step-by-step migration procedure documented

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `docs/postgresql-migration.md` | New | Migration documentation |
| `scripts/migrate-to-postgres.sql` | New | Schema migration SQL (reference only) |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: migration SQL is valid PostgreSQL syntax
   - Test: all SQLite tables have PostgreSQL equivalents
   - Test: all indexes preserved in PostgreSQL schema
   - Manual verification: review documentation for completeness and accuracy
2. **Run tests** — confirm they fail
3. **Implement** — migration documentation and scripts
4. **Refactor** — verify SQL syntax

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the migration documentation.
Use `/requesting-code-review` to validate:
- Schema translation accuracy
- Migration procedure completeness
- ORM recommendation rationale

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Review documentation for accuracy
- Verify SQL syntax is valid PostgreSQL

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P10-S4: Security Hardening

**As a** developer
**I want** comprehensive security hardening: dashboard API rate limiting, CSRF protection, input validation, audit logging, and SQLite integrity checks
**So that** the system is protected against common web vulnerabilities and maintains data integrity

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S3 | Authentication for dashboard | Need dashboard auth system to add security hardening to |
| P6-S4 | Health checks and monitoring | Need monitoring infrastructure for audit logging |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Rate limiting on dashboard API endpoints
2. [ ] CSRF protection on state-changing endpoints
3. [ ] Input validation on all API endpoints
4. [ ] Audit logging for admin actions
5. [ ] Regular SQLite integrity checks
6. [ ] Security audit checklist passed

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/api/middleware/rate-limit.ts` | New | API rate limiting middleware |
| `src/api/middleware/csrf.ts` | New | CSRF protection middleware |
| `src/api/middleware/validation.ts` | New | Input validation middleware |
| `src/audit-log.ts` | New | Audit logging for admin actions |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: API rate limit blocks excessive requests (e.g., > 100 requests/minute)
   - Test: CSRF token required for POST/PATCH/DELETE requests
   - Test: invalid input rejected with 400 error
   - Test: SQL injection attempt in filter parameters blocked
   - Test: XSS attempt in complaint update note sanitized
   - Test: admin action creates audit log entry
   - Test: SQLite integrity check runs without errors
   - Edge case: rate limit doesn't block legitimate burst usage
   - Edge case: CSRF token refresh on page reload
2. **Run tests** — confirm they fail
3. **Implement** — security middleware and audit logging
4. **Refactor** — verify against OWASP top 10

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the security hardening.
Use `/requesting-code-review` to validate:
- Rate limiting strategy
- CSRF implementation approach
- Input validation rules
- Audit log format and storage

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Run security audit checklist
- Test with OWASP-style attack payloads

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P10-S5: Documentation

**As a** developer
**I want** comprehensive operations documentation: runbook, API docs, onboarding checklist, and disaster recovery procedures
**So that** the system can be operated and maintained by any team member

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P10-S1 | Performance optimization | Need all optimizations documented |
| P10-S2 | Observability | Need monitoring setup documented |
| P10-S3 | PostgreSQL migration path | Need migration path documented |
| P10-S4 | Security hardening | Need security measures documented |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Operations runbook: common issues and resolutions
2. [ ] API documentation for dashboard endpoints
3. [ ] Tenant onboarding checklist (references Phase 7 docs)
4. [ ] Disaster recovery procedures documented
5. [ ] Operations runbook complete

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `docs/operations-runbook.md` | New | Operations guide with troubleshooting |
| `docs/api-reference.md` | New | Dashboard API documentation |
| `docs/disaster-recovery.md` | New | DR procedures |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Manual verification: all API endpoints documented with examples
   - Manual verification: runbook covers all known failure modes
   - Manual verification: DR procedures tested with simulated failure
   - Test: all referenced file paths exist
   - Test: all referenced commands execute without errors
2. **Run tests** — confirm they fail
3. **Implement** — write documentation
4. **Refactor** — ensure accuracy and completeness

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the documentation suite.
Use `/requesting-code-review` to validate:
- Documentation coverage
- Accuracy of procedures
- Clarity for new team members

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Review all documentation for accuracy
- Have a team member follow the runbook
- Test DR procedures

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 10 and the entire project are now complete!
