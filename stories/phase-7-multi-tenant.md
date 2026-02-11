# Phase 7: Multi-Tenant Provisioning

**Goal**: Onboard a second MLA with zero code changes — config only.

**Deliverable**: Second tenant running on same cluster with completely isolated data.

---

## P7-S1: Tenant Provisioning Script

**As a** DevOps engineer
**I want** a provisioning script that creates everything needed for a new tenant (namespace, config, PVCs, deployment, ingress)
**So that** onboarding a new MLA is a single script run with interactive prompts

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S3 | CI/CD pipeline for bot | Need production deployment and CI/CD running before provisioning new tenants |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `scripts/provision-tenant.sh <tenant-name>` created
2. [ ] Script creates k8s namespace for new tenant
3. [ ] Script generates tenant config template (YAML) with interactive prompts
4. [ ] Script creates PVCs for SQLite + WhatsApp auth
5. [ ] Script deploys bot pod with tenant-specific ConfigMap
6. [ ] Script creates ingress rules for tenant's domains
7. [ ] Interactive prompts for: MLA name, constituency, WhatsApp number, domains
8. [ ] Second tenant provisioned with single script run
9. [ ] Both tenants running simultaneously on same cluster
10. [ ] Zero data leakage between tenants (verified)
11. [ ] Each tenant has independent WhatsApp connection

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `scripts/provision-tenant.sh` | New | Tenant provisioning automation |
| `k8s/templates/` | New | Templated K8s manifests for new tenants |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: script creates namespace with correct name (`tenant-{name}`)
   - Test: script generates valid tenant config YAML
   - Test: script creates PVCs for SQLite and WhatsApp auth
   - Test: script deploys bot pod in new namespace
   - Test: script creates ingress rules for tenant domains
   - Test: two tenants run simultaneously without interference
   - Test: tenant A cannot access tenant B's database
   - Test: tenant A's rate limits don't affect tenant B
   - Test: each tenant has independent WhatsApp connection
   - Edge case: provisioning script re-run for existing tenant is idempotent
   - Edge case: invalid tenant name rejected (special characters)
2. **Run tests** — confirm they fail
3. **Implement** — provisioning script
4. **Refactor** — improve error handling and prompts

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the provisioning system.
Use `/requesting-code-review` to validate:
- Namespace isolation strategy
- Template parameterization approach
- Data isolation verification method

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Provision a test tenant and verify isolation
- Verify both tenants operational

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P7-S2: Shared Admin CLI

**As a** DevOps engineer
**I want** a CLI tool to manage all tenants — list status, view usage, restart bots, manage backups
**So that** platform operators can efficiently manage multiple MLAs from a single interface

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P7-S1 | Tenant provisioning script | Need at least two tenants provisioned to manage |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `scripts/tenant-admin.sh` created
2. [ ] List all tenants and their status (running/stopped/error)
3. [ ] View tenant resource usage (pods, storage)
4. [ ] Restart tenant bot
5. [ ] View tenant logs
6. [ ] Backup/restore tenant data
7. [ ] Admin can view/manage all tenants from CLI

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `scripts/tenant-admin.sh` | New | Multi-tenant admin CLI |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `tenant-admin.sh list` shows all tenants with status
   - Test: `tenant-admin.sh usage <tenant>` shows resource usage
   - Test: `tenant-admin.sh restart <tenant>` restarts bot pod
   - Test: `tenant-admin.sh logs <tenant>` shows recent logs
   - Test: `tenant-admin.sh backup <tenant>` triggers backup
   - Test: `tenant-admin.sh restore <tenant> <backup-file>` restores data
   - Edge case: non-existent tenant name returns clear error
   - Edge case: restart of already-stopped pod handled gracefully
2. **Run tests** — confirm they fail
3. **Implement** — admin CLI
4. **Refactor** — improve output formatting

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the admin CLI.
Use `/requesting-code-review` to validate:
- CLI command structure
- kubectl integration approach
- Output formatting

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test all CLI commands against running cluster

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P7-S3: Tenant Onboarding Documentation

**As a** developer
**I want** comprehensive documentation for adding a new MLA tenant
**So that** any team member can onboard a new tenant by following the step-by-step guide

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P7-S2 | Shared admin CLI | Need the provisioning and admin tools complete before documenting them |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Step-by-step guide for adding new MLA tenant
2. [ ] WhatsApp number registration process documented
3. [ ] DNS configuration for tenant domains documented
4. [ ] Content setup for tenant website documented
5. [ ] All scripts and commands referenced with examples
6. [ ] Troubleshooting section for common issues

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `docs/tenant-onboarding.md` | New | Complete onboarding documentation |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Manual verification: follow the guide to onboard a test tenant end-to-end
   - Test: all referenced scripts exist and are executable
   - Test: all referenced configuration files exist
   - Test: DNS examples are valid format
2. **Run tests** — confirm they fail
3. **Implement** — write documentation
4. **Refactor** — ensure clarity and completeness

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the documentation structure.
Use `/requesting-code-review` to validate:
- Documentation completeness
- Step ordering
- Accuracy of commands and examples

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Follow documentation to onboard a test tenant
- Verify all steps work as described

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P7-S4: Cross-Tenant Cost Dashboard (Optional)

**As a** admin
**I want** an aggregate view of usage across all tenants
**So that** I can track per-tenant volume and plan capacity

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P7-S2 | Shared admin CLI | Need multi-tenant management infrastructure |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Aggregate usage visible across tenants
2. [ ] Per-tenant volume breakdown (messages, container runs)
3. [ ] Global usage tracking view
4. [ ] Data accessible via CLI or simple dashboard

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `scripts/tenant-admin.sh` | Extend | Add cross-tenant usage aggregation |
| `src/api/admin-usage.ts` | New | Cross-tenant usage API (optional) |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: aggregate usage sums across all tenants correctly
   - Test: per-tenant breakdown shows correct volumes
   - Test: usage data covers correct time period
   - Edge case: tenant with no usage shows zero, not error
2. **Run tests** — confirm they fail
3. **Implement** — cross-tenant usage view
4. **Refactor** — optimize queries

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the cost dashboard.
Use `/requesting-code-review` to validate approach.

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify with multiple tenant data

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 7 is now complete — Phase 9 (Advanced Features) is unblocked.
