# Phase 4: Web Admin Dashboard

**Goal**: Give MLA's team a web interface for complaint management, filtering, and basic analytics.

**Deliverable**: Web dashboard at admin.rahulkul.udyami.ai showing all complaints with filters, status updates, and charts.

---

## P4-S1: Dashboard API

**As a** developer
**I want** a Hono-based REST API for the admin dashboard with endpoints for complaints, stats, usage, and categories
**So that** the dashboard frontend (and future integrations) can query and update complaint data via a clean API

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P2-S3 | Build admin group notification system | Need admin handler and status update flow before exposing via API |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/api/` directory created
2. [ ] Hono-based REST API running in same Node.js process as bot
3. [ ] `GET /api/complaints` — list with filters (status, category, date range, ward)
4. [ ] `GET /api/complaints/:id` — single complaint with full update history
5. [ ] `PATCH /api/complaints/:id` — update status (triggers WhatsApp notification to constituent)
6. [ ] `GET /api/stats` — aggregate statistics (open, resolved, aging counts)
7. [ ] `GET /api/usage` — volume tracking data (messages, container runs)
8. [ ] `GET /api/categories` — complaint categories with counts
9. [ ] Simple auth: API key in header (Phase 1 of dashboard auth)
10. [ ] API returns proper error codes and messages

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/api/index.ts` | New | Hono app setup and route registration |
| `src/api/complaints.ts` | New | Complaint CRUD endpoints |
| `src/api/stats.ts` | New | Statistics endpoint |
| `src/api/usage.ts` | New | Usage tracking endpoint |
| `src/api/categories.ts` | New | Categories endpoint |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `GET /api/complaints` returns list of complaints
   - Test: `GET /api/complaints?status=open` filters correctly
   - Test: `GET /api/complaints?category=water_supply` filters correctly
   - Test: `GET /api/complaints?from=2026-01-01&to=2026-01-31` filters by date range
   - Test: `GET /api/complaints/:id` returns complaint with update history
   - Test: `GET /api/complaints/:id` returns 404 for non-existent ID
   - Test: `PATCH /api/complaints/:id` updates status and triggers notification
   - Test: `GET /api/stats` returns correct aggregate counts
   - Test: `GET /api/usage` returns volume tracking data
   - Test: `GET /api/categories` returns categories with counts
   - Test: request without API key returns 401
   - Test: request with invalid API key returns 403
   - Edge case: empty database returns empty arrays, not errors
2. **Run tests** — confirm they fail
3. **Implement** — API routes and handlers
4. **Refactor** — clean up query logic

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the API architecture.
Use `/requesting-code-review` to validate:
- Hono integration with existing Node.js process
- API route naming conventions
- Auth approach (API key)
- Query parameter design for filters

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test API with curl/httpie
- Verify WhatsApp notification on PATCH

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P4-S2: Dashboard Frontend

**As a** developer
**I want** a React SPA dashboard with complaint list, detail view, summary cards, and charts
**So that** the MLA's team can visually manage complaints, track trends, and monitor system usage

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S1 | Dashboard API | Need API endpoints for the frontend to consume |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] React SPA built with Vite, served by Hono server
2. [ ] Complaint list view: table with sort/filter/search
3. [ ] Complaint detail view: full history, status timeline, update form
4. [ ] Dashboard home: cards showing open/resolved/aging counts
5. [ ] Charts: complaints over time, by category, by ward, resolution time
6. [ ] Usage volume: daily/weekly message and container run charts
7. [ ] TailwindCSS styling
8. [ ] Mobile-friendly layout (admins may check on phone)
9. [ ] Dashboard loads at `admin.rahulkul.udyami.ai`

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `dashboard/` | New | React SPA project directory |
| `dashboard/src/App.tsx` | New | Main application with routing |
| `dashboard/src/pages/` | New | Dashboard pages (home, complaint list, detail) |
| `dashboard/src/components/` | New | Reusable UI components (charts, tables, cards) |
| `dashboard/vite.config.ts` | New | Vite configuration |
| `dashboard/tailwind.config.js` | New | TailwindCSS configuration |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: dashboard app renders without errors
   - Test: complaint list displays complaints from API
   - Test: complaint list filters work (status, category)
   - Test: complaint detail shows full history
   - Test: status update form submits correctly
   - Test: dashboard home shows summary cards with correct counts
   - Test: charts render with data
   - Test: layout is responsive on mobile viewport
   - Edge case: API error shows user-friendly error message
   - Edge case: empty complaint list shows appropriate message
2. **Run tests** — confirm they fail
3. **Implement** — React SPA
4. **Refactor** — optimize component structure

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the dashboard frontend.
Use `/requesting-code-review` to validate:
- Component architecture
- State management approach
- Chart library selection
- Mobile responsiveness strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test in browser with real data
- Test on mobile viewport

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P4-S3: Authentication for Dashboard

**As a** developer
**I want** password-based authentication for the admin dashboard with JWT tokens
**So that** only authorized admin users can access complaint data and management features

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S1 | Dashboard API | Need the API to protect with authentication |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Simple password-based auth for 1-3 admin users
2. [ ] JWT tokens stored in httpOnly cookies
3. [ ] Admin users defined in tenant config
4. [ ] Login page with username/password form
5. [ ] No public registration — invite-only
6. [ ] Unauthenticated API requests return 401
7. [ ] Expired JWT returns 401 and redirects to login

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/api/auth.ts` | New | Authentication middleware, login endpoint |
| `dashboard/src/pages/Login.tsx` | New | Login page component |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: valid credentials return JWT token
   - Test: invalid credentials return 401
   - Test: JWT stored in httpOnly cookie
   - Test: authenticated request with valid JWT succeeds
   - Test: request without JWT returns 401
   - Test: expired JWT returns 401
   - Test: admin users loaded from tenant config
   - Edge case: brute force protection (rate limit login attempts)
   - Edge case: SQL injection in login fields handled safely
2. **Run tests** — confirm they fail
3. **Implement** — auth system
4. **Refactor** — ensure security best practices

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the auth system.
Use `/requesting-code-review` to validate:
- JWT implementation approach
- Password hashing strategy
- Cookie security settings
- Session management

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test login flow end-to-end
- Verify security headers

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P4-S4: Kubernetes Ingress for Dashboard

**As a** DevOps engineer
**I want** K8s ingress routing for the admin dashboard with TLS termination
**So that** the dashboard is accessible at admin.rahulkul.udyami.ai with HTTPS

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S2 | Dashboard frontend | Need the dashboard built before deploying to k8s |
| P4-S3 | Authentication for dashboard | Need auth in place before exposing dashboard publicly |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `admin.rahulkul.udyami.ai` routes to dashboard service
2. [ ] TLS termination at ingress layer
3. [ ] Dashboard accessible via HTTPS only
4. [ ] Ingress rules added to existing k8s configuration

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `k8s/dashboard/ingress.yaml` | New | Traefik ingress rules for dashboard subdomain |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: ingress YAML is valid
   - Test: ingress routes `admin.rahulkul.udyami.ai` to correct service
   - Test: TLS configured in ingress
   - Manual verification: dashboard accessible via domain
2. **Run tests** — confirm they fail
3. **Implement** — ingress configuration
4. **Refactor** — verify TLS settings

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the ingress configuration.
Use `/requesting-code-review` to validate:
- Ingress rules
- TLS certificate approach
- Network security

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify dashboard accessible via HTTPS
- Test login flow via ingress

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 4 is now complete — Phase 6 (Production Deployment) is unblocked.
