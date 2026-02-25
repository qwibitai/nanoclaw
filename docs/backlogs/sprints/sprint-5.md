# Sprint 5: Multi-Tenant Core

**Package:** cambot-agent
**Duration:** ~3-4 weeks
**Sprint Goal:** Make container isolation and credential management tenant-aware.

---

## Stories

### 3.3 — Tenant-aware container isolation
- [ ] Filter container mounts by tenant (tenant A's container can't see tenant B's data)
- [ ] Scope per-group folders under tenant directory structure
- [ ] Make IPC authorization tenant-aware (messages scoped to tenant)
- [ ] Update container-runner to accept tenant context
- [ ] Add tests for tenant container isolation (verify cross-tenant data inaccessible)

### 3.5 — Per-tenant credential and API key isolation
- [ ] Scope API keys per tenant
- [ ] Scope OAuth tokens per tenant
- [ ] Enforce credential filtering per tenant (tenant A's keys never visible to tenant B)
- [ ] Update credential loading to accept tenant context
- [ ] Add tests for credential isolation

---

## Dependencies
- Story 3.1 (design) and 3.2 (DB isolation) in cambot-core Sprint 5 should complete first

## Definition of Done
- Container mounts are tenant-scoped — verified by tests
- IPC messages cannot cross tenant boundaries
- Credentials are fully isolated per tenant
