# Phase 6: Production Deployment on Existing K8s Cluster

**Goal**: Deploy the full system (bot + dashboard + whisper) to the existing k3d cluster with CI/CD and production hardening.

**Deliverable**: All components running on the existing k8s cluster with automated GitHub-triggered deployments, health checks, and backups.

**Note**: The k8s cluster is already running. Phases 1–5 run locally via `npm run dev`. This phase packages everything and deploys to the cluster.

---

## P6-S1: Create Production Dockerfile for the Bot

**As a** DevOps engineer
**I want** a production-ready multi-stage Dockerfile for the bot that includes the orchestrator, dashboard API, and frontend in one image
**So that** the entire bot application can be deployed as a single container on k8s with minimal image size

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S4 | Kubernetes ingress for dashboard | Need all Phase 4 dashboard components complete before packaging for production |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Multi-stage Dockerfile: Stage 1 `node:22-slim` (ARM64) — build TypeScript; Stage 2 `node:22-slim` (ARM64) — runtime with ffmpeg
2. [ ] Image includes: bot orchestrator, dashboard API, dashboard frontend (all in one)
3. [ ] SQLite database configured for persistent volume
4. [ ] WhatsApp auth state configured for persistent volume
5. [ ] Agent container image built separately (nanoclaw's existing `container/Dockerfile`)
6. [ ] Image builds successfully on ARM64
7. [ ] Image size optimized (no dev dependencies in final stage)

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `Dockerfile` | New | Production multi-stage Dockerfile |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: Dockerfile builds without errors on ARM64
   - Test: built image includes Node.js 22 runtime
   - Test: built image includes ffmpeg for voice note conversion
   - Test: built image does NOT include dev dependencies
   - Test: TypeScript compiled to JavaScript in build stage
   - Test: dashboard frontend assets present in built image
   - Test: container starts and responds to health check
   - Edge case: build succeeds with clean Docker cache
2. **Run tests** — confirm they fail
3. **Implement** — multi-stage Dockerfile
4. **Refactor** — optimize image layers and size

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the production Dockerfile.
Use `/requesting-code-review` to validate:
- Multi-stage build strategy
- Volume mount points for SQLite and WhatsApp auth
- Image optimization approach

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Build image and verify it starts correctly
- Check image size

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P6-S2: Kubernetes Manifests for All Components

**As a** DevOps engineer
**I want** complete K8s manifests to deploy the bot, dashboard, and all supporting resources into the existing cluster
**So that** the entire system runs in the `tenant-rahulkul` namespace with proper storage, config, and secrets

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S1 | Create production Dockerfile for the bot | Need the production image before writing deployment manifests |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Deployed into existing cluster, namespace: `tenant-rahulkul`
2. [ ] `k8s/bot/statefulset.yaml` — bot pod (1 replica, stable storage)
3. [ ] `k8s/bot/service.yaml` — ClusterIP service
4. [ ] `k8s/bot/pvc.yaml` — PersistentVolumeClaim for SQLite + WhatsApp auth
5. [ ] `k8s/bot/configmap.yaml` — tenant config (tenant.yaml) mounted as volume
6. [ ] `k8s/bot/secret.yaml` — CLAUDE_CODE_OAUTH_TOKEN, admin passwords
7. [ ] `k8s/bot/ingress.yaml` — Traefik routes for dashboard subdomain
8. [ ] Reuses existing `k8s/whisper/` from Phase 3
9. [ ] Reuses existing `k8s/website/` from Phase 3
10. [ ] All pods in same namespace, communicate via ClusterIP services
11. [ ] `kubectl get pods -n tenant-rahulkul` shows bot + whisper + website pods running

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `k8s/bot/statefulset.yaml` | New | Bot StatefulSet with stable storage |
| `k8s/bot/service.yaml` | New | ClusterIP service |
| `k8s/bot/pvc.yaml` | New | PVC for SQLite + WhatsApp auth |
| `k8s/bot/configmap.yaml` | New | Tenant config mounted as volume |
| `k8s/bot/secret.yaml` | New | Secrets for tokens and passwords |
| `k8s/bot/ingress.yaml` | New | Dashboard ingress rules |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: all K8s manifests are valid YAML
   - Test: StatefulSet specifies correct image and replica count (1)
   - Test: PVC created for SQLite and WhatsApp auth
   - Test: ConfigMap contains tenant config
   - Test: Secret contains required tokens
   - Test: service exposes correct ports
   - Test: ingress routes dashboard subdomain correctly
   - Test: namespace is `tenant-rahulkul`
   - Test: pods can communicate via ClusterIP services
   - Edge case: pod restart preserves data on PVC
2. **Run tests** — confirm they fail
3. **Implement** — K8s manifests
4. **Refactor** — verify resource limits and requests

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the K8s deployment.
Use `/requesting-code-review` to validate:
- StatefulSet vs Deployment choice
- PVC sizing and storage class
- Secret management approach
- Network policies

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Deploy to cluster and verify all pods running
- Test inter-pod communication

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P6-S3: CI/CD Pipeline for Bot

**As a** DevOps engineer
**I want** a GitHub Actions workflow that auto-builds, tests, and deploys the bot on push to main
**So that** code changes are automatically deployed to the k8s cluster with quality checks

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S2 | Kubernetes manifests for all components | Need K8s deployment targets before CI/CD can deploy |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `.github/workflows/bot.yaml` created
2. [ ] On push to `main`: build Docker image → push to cluster registry → `kubectl rollout`
3. [ ] TypeScript compilation check in pipeline
4. [ ] Basic integration tests run in pipeline
5. [ ] GitHub push to main triggers automated deployment
6. [ ] Deployment strategy: rolling update (single replica, so recreate)
7. [ ] Build failure stops deployment and reports error

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `.github/workflows/bot.yaml` | New | CI/CD workflow for bot deployment |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: workflow YAML is valid GitHub Actions syntax
   - Test: workflow triggers on push to `main`
   - Test: workflow includes TypeScript compilation step
   - Test: workflow includes test execution step
   - Test: workflow includes Docker build step
   - Test: workflow includes deployment step
   - Manual verification: push to main and verify deployment
2. **Run tests** — confirm they fail
3. **Implement** — CI/CD workflow
4. **Refactor** — optimize build caching

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the CI/CD pipeline.
Use `/requesting-code-review` to validate:
- Pipeline stage order
- Registry authentication
- Deployment rollout strategy
- Secret management in CI

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test workflow with a sample push

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P6-S4: Health Checks and Monitoring

**As a** DevOps engineer
**I want** liveness and readiness probes, structured logging, and alerting for the bot pod
**So that** the system self-heals on failures and the team is notified of critical issues

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S2 | Kubernetes manifests for all components | Need the deployed bot to add health checks to |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Liveness probe: HTTP endpoint `/health`
2. [ ] Readiness probe: check WhatsApp connection + SQLite access + Whisper pod reachable
3. [ ] Structured logs (Pino) → stdout → `kubectl logs`
4. [ ] Alert on: bot disconnected > 5 min
5. [ ] Alert on: Whisper pod unhealthy
6. [ ] Alert on: errors > 10/hour
7. [ ] Health check endpoints responding correctly
8. [ ] Bot auto-reconnects after pod restart

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/health.ts` | New | Health check endpoints (liveness + readiness) |
| `k8s/bot/statefulset.yaml` | Modify | Add liveness and readiness probe configuration |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `/health` returns 200 when bot is healthy
   - Test: `/health` returns 503 when WhatsApp disconnected
   - Test: readiness check verifies SQLite access
   - Test: readiness check verifies Whisper pod reachable
   - Test: structured logs output valid JSON via Pino
   - Test: alert triggered when bot disconnected > 5 minutes
   - Test: alert triggered when error count > 10/hour
   - Edge case: Whisper pod temporarily unavailable — readiness fails but liveness OK
2. **Run tests** — confirm they fail
3. **Implement** — health checks and monitoring
4. **Refactor** — ensure clean monitoring code

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the monitoring system.
Use `/requesting-code-review` to validate:
- Health check endpoint design
- Alert threshold values
- Logging format and levels

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test health endpoints manually
- Verify pod restarts correctly

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P6-S5: Backup Strategy

**As a** DevOps engineer
**I want** daily automated backups of SQLite database and WhatsApp auth state
**So that** data can be recovered in case of pod failure, storage corruption, or accidental deletion

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P6-S2 | Kubernetes manifests for all components | Need PVCs and deployed bot before setting up backups |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Daily SQLite backup via k8s CronJob (copy to host volume)
2. [ ] WhatsApp auth state backup via same CronJob
3. [ ] Retention: keep last 7 daily backups
4. [ ] Restore procedure documented
5. [ ] SQLite backup CronJob running daily
6. [ ] Backup integrity verified (restored backup produces valid database)

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `k8s/bot/cronjob-backup.yaml` | New | CronJob for daily backups |
| `scripts/restore-backup.sh` | New | Backup restoration script |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: CronJob YAML is valid K8s manifest
   - Test: CronJob scheduled for daily execution
   - Test: backup script copies SQLite file correctly
   - Test: backup script copies WhatsApp auth state
   - Test: old backups (> 7 days) are pruned
   - Test: restore script successfully restores from backup
   - Test: restored database is valid and queryable
   - Edge case: backup during active writes (SQLite WAL mode)
2. **Run tests** — confirm they fail
3. **Implement** — backup CronJob and restore script
4. **Refactor** — optimize backup strategy

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the backup strategy.
Use `/requesting-code-review` to validate:
- Backup approach (file copy vs SQLite backup API)
- Retention policy
- Restore procedure
- Storage location for backups

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Execute backup manually and verify file integrity
- Test restore procedure

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 6 is now complete — Phase 7 (Multi-Tenant) is unblocked.
