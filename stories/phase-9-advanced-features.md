# Phase 9: Advanced Features

**Goal**: Complaint routing, escalation automation, and user satisfaction tracking.

**Deliverable**: Complaints auto-routed to responsible department. Users get satisfaction survey after resolution.

---

## P9-S1: Auto-Routing by Category

**As a** developer
**I want** complaints automatically routed to the responsible team member/department based on category
**So that** the right people are tagged in admin group notifications, reducing response time

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P7-S1 | Tenant provisioning script | Need multi-tenant infrastructure and mature admin handler |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Complaint categories mapped to responsible team members/departments
2. [ ] When complaint registered, relevant admin tagged in group notification
3. [ ] Routing rules configurable in tenant config
4. [ ] Complaints auto-routed to tagged admin by category
5. [ ] Unrecognized category uses default routing (all admins notified)

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/admin-handler.ts` | Extend | Add category-based routing and tagging |
| `config/tenant.yaml` | Extend | Add category → admin mapping configuration |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: water_supply complaint tags water department admin
   - Test: roads complaint tags infrastructure admin
   - Test: electricity complaint tags power department admin
   - Test: unknown category notifies all admins
   - Test: routing rules loaded from tenant config
   - Test: admin tagged with @ mention in WhatsApp group
   - Edge case: admin phone number not in group — notification still sent to group
   - Edge case: category with no mapped admin falls back to default routing
2. **Run tests** — confirm they fail
3. **Implement** — category routing
4. **Refactor** — clean up routing configuration

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the routing system.
Use `/requesting-code-review` to validate:
- Routing rule configuration design
- Admin tagging mechanism in WhatsApp
- Default routing behavior

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test routing with different categories

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P9-S2: Escalation Automation

**As a** developer
**I want** complaints auto-escalated when they exceed configurable SLA thresholds
**So that** stale complaints don't go unnoticed and the admin team is prompted to take action

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P9-S1 | Auto-routing by category | Need routing infrastructure and category-based admin mapping |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Auto-escalate complaints open > 7 days with no status update
2. [ ] Bot posts escalation notice to admin group
3. [ ] Configurable SLA thresholds per category in tenant config
4. [ ] Complaints auto-escalated after configurable SLA
5. [ ] Escalation changes complaint status to `escalated`
6. [ ] Escalation notice includes complaint details and age

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/task-scheduler.ts` | Extend | Add SLA check scheduled task |
| `src/admin-handler.ts` | Extend | Add escalation notification logic |
| `config/tenant.yaml` | Extend | Add per-category SLA thresholds |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: complaint open > 7 days with no update → auto-escalated
   - Test: complaint open > 7 days WITH recent update → NOT escalated
   - Test: escalation notice posted to admin group
   - Test: complaint status changed to `escalated`
   - Test: SLA threshold configurable per category (e.g., water = 3 days, roads = 7 days)
   - Test: escalation notice includes complaint ID, category, age, description
   - Edge case: already-escalated complaint not re-escalated
   - Edge case: resolved complaint not checked for SLA
2. **Run tests** — confirm they fail
3. **Implement** — escalation automation
4. **Refactor** — optimize SLA check query

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the escalation system.
Use `/requesting-code-review` to validate:
- SLA check frequency and approach
- Escalation notification format
- Configuration design

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test with aging complaints

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P9-S3: User Satisfaction Survey

**As a** developer
**I want** a follow-up satisfaction survey sent to constituents 24 hours after complaint resolution
**So that** the MLA's team can measure service quality and include satisfaction scores in reports

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P7-S1 | Tenant provisioning script | Need mature complaint lifecycle and scheduling infrastructure |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] After complaint resolved, follow-up sent after 24 hours
2. [ ] Survey message: "Was your issue resolved satisfactorily? Reply 1-5" (in user's language)
3. [ ] Rating stored in `complaint_updates` table
4. [ ] Satisfaction scores included in weekly report
5. [ ] Satisfaction survey sent 24h after resolution
6. [ ] Satisfaction score visible in dashboard and weekly report
7. [ ] Survey in Marathi for Marathi users (e.g., "तुमची समस्या समाधानकारकपणे सोडवली गेली का? 1-5 रेटिंग द्या")

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/task-scheduler.ts` | Extend | Schedule satisfaction survey 24h after resolution |
| `src/channels/whatsapp.ts` | Extend | Handle survey responses (1-5 rating) |
| `src/admin-handler.ts` | Extend | Include satisfaction in reports |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: complaint resolution triggers survey scheduling for 24h later
   - Test: survey message sent in user's language (Marathi/Hindi/English)
   - Test: user reply of "3" stored as rating in `complaint_updates`
   - Test: rating appears in weekly report
   - Test: rating visible in dashboard complaint detail
   - Test: invalid reply (e.g., "hello") prompts user to reply with 1-5
   - Edge case: user doesn't respond — no follow-up sent
   - Edge case: complaint re-opened after survey — no duplicate survey
2. **Run tests** — confirm they fail
3. **Implement** — satisfaction survey system
4. **Refactor** — clean up scheduling logic

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the survey system.
Use `/requesting-code-review` to validate:
- Survey timing approach
- Response handling
- Integration with reports

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test survey flow end-to-end

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P9-S4: Bulk Operations from Dashboard

**As a** developer
**I want** bulk complaint operations in the admin dashboard (multi-select, batch status update, assign, internal notes)
**So that** admins can efficiently manage large numbers of complaints without updating each one individually

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P4-S2 | Dashboard frontend | Need the dashboard to add bulk operations to |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] Select multiple complaints → update status in bulk
2. [ ] Assign complaints to team members
3. [ ] Add internal notes (not sent to constituent)
4. [ ] Bulk status update triggers notifications for all affected complaints
5. [ ] Internal notes visible in dashboard but NOT sent via WhatsApp

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/api/complaints.ts` | Extend | Add bulk update endpoint |
| `dashboard/src/pages/ComplaintList.tsx` | Extend | Add multi-select and bulk action UI |
| `dashboard/src/components/BulkActions.tsx` | New | Bulk action toolbar component |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: select multiple complaints in UI
   - Test: bulk status update changes all selected complaints
   - Test: bulk update triggers WhatsApp notifications for each complaint
   - Test: assign complaint to team member
   - Test: internal note saved but NOT sent to constituent
   - Test: internal note visible in complaint detail view
   - Edge case: bulk update with mixed valid/invalid IDs — valid ones succeed
   - Edge case: assign to non-existent team member returns error
2. **Run tests** — confirm they fail
3. **Implement** — bulk operations
4. **Refactor** — optimize batch queries

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan bulk operations.
Use `/requesting-code-review` to validate:
- Bulk API endpoint design
- UI component architecture
- Notification batching strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Test bulk operations in browser

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 9 is now complete — Phase 10 (Polish & Scale) is unblocked.
