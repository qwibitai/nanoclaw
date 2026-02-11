# Phase 1: Core Complaint Bot

**Goal**: A working WhatsApp bot that accepts complaints in Marathi/Hindi/English, generates tracking IDs, and stores them in SQLite — using nanoclaw's container-based Agent SDK powered by Claude Code subscription.

**Deliverable**: Send a WhatsApp message describing an issue → receive a tracking ID. Query by tracking ID → get status. All in the user's detected language. Zero per-token cost.

---

## P1-S1: Fork Nanoclaw and Set Up Project Structure

**As a** developer
**I want** a forked nanoclaw repo with project structure configured for the constituency complaint bot
**So that** I have a working base to build all complaint-handling features on top of nanoclaw's container-based Agent SDK architecture

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| — | — | This is the foundational story; no dependencies |

### Acceptance Criteria

1. [ ] Repository forked from `github.com/gavrielc/nanoclaw` to `github.com/{org}/constituency-bot`
2. [ ] Entire nanoclaw architecture intact: container-runner, Agent SDK, IPC, scheduler
3. [ ] `CLAUDE_CODE_OAUTH_TOKEN` configured for subscription-based auth (no API key billing)
4. [ ] `src/tenant-config.ts` stub created for tenant config loader
5. [ ] Container image settings updated for the complaint bot agent
6. [ ] `package.json` updated with project name and any new dependencies
7. [ ] `tsconfig.json` configured correctly
8. [ ] `src/config.ts` updated with tenant config environment variables
9. [ ] Project builds successfully with `npm run build`
10. [ ] Existing nanoclaw tests still pass after fork

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `package.json` | Modify | Update project name, add dependencies |
| `tsconfig.json` | Modify | Verify/update TypeScript config |
| `src/config.ts` | Modify | Add tenant config env vars |
| `src/tenant-config.ts` | New | Stub for tenant config loader |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: project builds without TypeScript errors
   - Test: nanoclaw core modules (container-runner, IPC, scheduler) import correctly
   - Test: `CLAUDE_CODE_OAUTH_TOKEN` env var is read from config
   - Test: `src/config.ts` exports tenant config env var definitions
   - Edge case: build fails gracefully if required env vars are missing
2. **Run tests** — confirm they fail (red phase)
3. **Implement** the minimum code to pass all tests (green phase)
4. **Refactor** — clean up while keeping tests green

### Development Workflow

#### Step 1: Architecture Review
Use the `/writing-plans` skill to create an implementation plan for this story.
Use the `/requesting-code-review` skill to validate:
- Fork strategy and what to keep from nanoclaw
- Env var naming conventions
- Project structure decisions

#### Step 2: TDD Implementation
Use the `/test-driven-development` skill:
- Write failing tests for all acceptance criteria
- Implement until all tests pass
- Refactor for clarity

#### Step 3: Code Review
Use the `/requesting-code-review` skill to submit for code review.
If the code-reviewer provides feedback:
- Use the `/receiving-code-review` skill to process feedback with technical rigor
- Do NOT blindly agree — verify suggestions are correct before applying
- Recode based on valid feedback
- Re-run ALL tests after changes

#### Step 4: Verification
Use the `/verification-before-completion` skill:
- Run the FULL test suite (not just this story's tests)
- Confirm no regressions
- Verify all acceptance criteria checkboxes can be checked

#### Step 5: Mark Complete
Only after Steps 1–4 pass:
- Check off all acceptance criteria
- Update the STORIES_INDEX.md status to ✅
- Note: downstream stories that depend on this one are now unblocked

---

## P1-S2: Extend WhatsApp Channel for 1:1 Chats

**As a** developer
**I want** the WhatsApp channel handler to support individual (1:1) chat messages in addition to group messages
**So that** constituents can send complaints directly to the bot via personal WhatsApp messages

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S1 | Fork nanoclaw and set up project structure | Need the forked repo and base config before modifying WhatsApp channel |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/channels/whatsapp.ts` handles individual chat messages (JID without `@g.us`)
2. [ ] Individual chat metadata stored in `chats` table
3. [ ] Sender phone number correctly extracted from JID
4. [ ] WhatsApp push name extracted for user identification
5. [ ] A virtual "complaint" group registered that all 1:1 messages route to
6. [ ] Existing group message handling remains unbroken
7. [ ] Bot correctly differentiates between 1:1 and group messages

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/channels/whatsapp.ts` | Modify | Add 1:1 chat handling, phone extraction, push name extraction |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: 1:1 message (JID without `@g.us`) is detected and handled
   - Test: group message (JID with `@g.us`) still works as before
   - Test: phone number correctly extracted from individual JID (e.g., `919876543210@s.whatsapp.net` → `919876543210`)
   - Test: push name extracted from message metadata
   - Test: 1:1 messages route to virtual "complaint" group
   - Test: chat metadata stored in `chats` table for individual chats
   - Edge case: message from unknown JID format handled gracefully
2. **Run tests** — confirm they fail
3. **Implement** — modify WhatsApp channel handler
4. **Refactor** — ensure clean separation of 1:1 vs group handling

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the 1:1 chat extension.
Use `/requesting-code-review` to validate:
- JID parsing approach
- Virtual "complaint" group registration mechanism
- Impact on existing group message flow

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify P1-S1 tests still pass
- Test with both 1:1 and group message types

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S3: Create Database Schema and Shell Script Tools for Complaints

**As a** developer
**I want** the SQLite schema for complaints, users, and usage tracking — plus shell script tools the agent container uses to interact with the database
**So that** the complaint bot agent can create, query, and update complaints via mounted bash tools

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S1 | Fork nanoclaw and set up project structure | Need the project repo and base config before adding DB schema |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/migrations/001-complaints.sql` exists and creates all tables: `tenant_config`, `users`, `complaints`, `complaint_updates`, `conversations`, `rate_limits`, `usage_log`, `categories`
2. [ ] All indexes from the schema specification are created (`idx_complaints_phone`, `idx_complaints_status`, `idx_complaints_category`, `idx_complaints_created`, `idx_complaints_days_open`, `idx_updates_complaint`, `idx_conversations_phone`, `idx_usage_phone`, `idx_usage_date`, `idx_usage_model`)
3. [ ] `src/db.ts` extended with migration runner that applies SQL files on startup
4. [ ] `tools/create-complaint.sh` inserts a complaint and returns tracking ID in format `RK-YYYYMMDD-XXXX`
5. [ ] `tools/query-complaints.sh` returns complaints filtered by phone number or complaint ID
6. [ ] `tools/update-complaint.sh` changes complaint status and inserts audit record in `complaint_updates`
7. [ ] `tools/get-categories.sh` returns list of known categories from `categories` table
8. [ ] Tracking ID prefix is configurable (reads from tenant config, not hardcoded as "RK")
9. [ ] Daily counter resets at midnight (XXXX restarts at 0001 each day)
10. [ ] All shell scripts validate inputs and return non-zero exit code on failure
11. [ ] `complaints.days_open` computed column works correctly
12. [ ] `src/types.ts` extended with complaint/user/conversation types

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/db.ts` | Extend | Add complaint/user/usage tables and migration runner |
| `src/migrations/001-complaints.sql` | New | Full complaint schema DDL |
| `src/types.ts` | Extend | Add complaint/user/conversation types |
| `tools/create-complaint.sh` | New | Insert complaint, generate tracking ID |
| `tools/query-complaints.sh` | New | Lookup by phone or complaint ID |
| `tools/update-complaint.sh` | New | Change status, audit trail |
| `tools/get-categories.sh` | New | List categories |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: migration creates all expected tables (query `sqlite_master`)
   - Test: all specified indexes exist after migration
   - Test: `create-complaint.sh` generates sequential IDs within the same day (e.g., `RK-20260211-0001`, `RK-20260211-0002`)
   - Test: `create-complaint.sh` resets counter on new day
   - Test: `query-complaints.sh` returns correct results by phone number
   - Test: `query-complaints.sh` returns correct results by complaint ID
   - Test: `update-complaint.sh` changes status AND creates audit record in `complaint_updates`
   - Test: `update-complaint.sh` rejects invalid status values (only `registered`, `acknowledged`, `in_progress`, `action_taken`, `resolved`, `on_hold`, `escalated` allowed)
   - Test: tracking ID prefix comes from tenant config, not hardcoded
   - Test: `days_open` computed column returns correct value
   - Edge case: concurrent complaint creation doesn't produce duplicate IDs
   - Edge case: scripts return non-zero exit code on invalid inputs
2. **Run tests** — confirm they fail
3. **Implement** schema + scripts to pass all tests
4. **Refactor** — ensure scripts are clean and well-commented

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the migration system and shell script interface.
Use `/requesting-code-review` to validate:
- Migration approach (single SQL file vs multiple)
- Shell script interface design (arguments, output format, error codes)
- Tracking ID generation strategy (atomic counter in SQLite)

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify P1-S1 tests still pass (no regressions)
- Manually test each shell script with sample data

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S4: Write CLAUDE.md — The Bot's Brain

**As a** developer
**I want** a comprehensive CLAUDE.md file that defines all complaint bot behavior, language rules, and tool usage instructions
**So that** the agent container knows how to handle complaints, detect languages, respond empathetically, and use the mounted shell script tools

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S1 | Fork nanoclaw and set up project structure | Need the project repo before creating group config |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `groups/complaint/CLAUDE.md` exists with complete bot behavior specification
2. [ ] Identity section: "You are a complaint assistant for {mla_name}'s office in {constituency}" (template variables)
3. [ ] Language rules: auto-detect Marathi/Hindi/English, respond in same language
4. [ ] Complaint intake flow: step-by-step instructions for gathering info, clarifying, confirming
5. [ ] Tool usage section: documents how to call `create-complaint.sh`, `query-complaints.sh`, `update-complaint.sh`, `get-categories.sh`
6. [ ] Behavioral guardrails: no promises, no politics, redirect off-topic, empathetic always
7. [ ] Response format templates: tracking ID confirmation, status updates, greetings
8. [ ] Category guidelines: how to auto-categorize (water, roads, electricity, sanitation, etc.)
9. [ ] Template variables (`{mla_name}`, `{constituency}`, etc.) are used — no hardcoded MLA references
10. [ ] Marathi/Hindi examples included in the prompt for few-shot language behavior (e.g., "तुमची तक्रार नोंदवली गेली आहे", "आपकी शिकायत दर्ज की गई है")

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `groups/complaint/CLAUDE.md` | New | Bot brain — all complaint handling logic, language rules, guardrails, tool usage |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: CLAUDE.md file exists and is non-empty
   - Test: CLAUDE.md contains identity template variables (`{mla_name}`, `{constituency}`)
   - Test: CLAUDE.md references all four shell script tools
   - Test: CLAUDE.md contains language detection instructions for Marathi, Hindi, English
   - Test: CLAUDE.md contains behavioral guardrails (no politics, no promises)
   - Test: CLAUDE.md contains category assignment guidelines
   - Test: no hardcoded MLA name or constituency name in CLAUDE.md
   - Manual verification: review CLAUDE.md for completeness and clarity of instructions
2. **Run tests** — confirm they fail
3. **Implement** — write the CLAUDE.md
4. **Refactor** — ensure clear structure, no redundancy

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the CLAUDE.md structure and content.
Use `/requesting-code-review` to validate:
- Prompt structure and instruction clarity
- Language handling approach
- Guardrail completeness
- Tool usage documentation accuracy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Manually review CLAUDE.md for prompt quality
- Verify template variables are correct

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S5: Configure Container Agent for Complaint Handling

**As a** developer
**I want** the agent container configured with the right model settings, tool mounts, database access, and session persistence
**So that** the complaint bot agent runs inside nanoclaw containers with Sonnet 4.5, uses the CLAUDE.md brain, and can access the complaint database via shell tools

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S3 | Create database schema and shell script tools | Need the DB schema and tools to mount into container |
| P1-S4 | Write CLAUDE.md — the bot's brain | Need the CLAUDE.md to mount as the agent's instructions |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `container/Dockerfile` modified to include `sqlite3` CLI and mount points for tools
2. [ ] SQLite database mounted read-write into agent container
3. [ ] `tools/` scripts mounted into container at `/workspace/tools/`
4. [ ] Tenant config mounted for identity/branding
5. [ ] `container/agent-runner/src/index.ts` configured with default model: **Sonnet 4.5** (`claude-sonnet-4-5-20250929`)
6. [ ] Opus 4.6 model upgrade path enabled for complex cases (via CLAUDE.md instruction for extended thinking)
7. [ ] Per-user session persistence configured so agent remembers conversation context
8. [ ] Agent container starts successfully and can execute shell script tools
9. [ ] Agent can read from and write to the mounted SQLite database

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `container/Dockerfile` | Modify | Add sqlite3 CLI, mount points for tools |
| `container/agent-runner/src/index.ts` | Modify | Set Sonnet 4.5 default model, configure session persistence |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: container builds successfully with modified Dockerfile
   - Test: `sqlite3` CLI available inside container
   - Test: tools directory mounted at `/workspace/tools/`
   - Test: agent-runner defaults to Sonnet 4.5 model
   - Test: session persistence maintains conversation context across messages
   - Test: agent container can execute `create-complaint.sh` and interact with SQLite
   - Edge case: container handles SQLite lock errors gracefully
2. **Run tests** — confirm they fail
3. **Implement** — modify Dockerfile and agent-runner config
4. **Refactor** — clean up Dockerfile layers, optimize image size

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the container configuration.
Use `/requesting-code-review` to validate:
- Dockerfile mount strategy
- Model configuration approach
- Session persistence mechanism

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Build container image and verify mounts
- Test agent execution end-to-end

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S6: Implement Message Routing in Orchestrator

**As a** developer
**I want** the orchestrator to route 1:1 WhatsApp messages to the "complaint" group and admin group messages to the "admin" group
**So that** incoming messages are correctly dispatched to the complaint agent container or admin handler

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S2 | Extend WhatsApp channel for 1:1 chats | Need 1:1 chat handling before routing can work |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/index.ts` routes 1:1 messages to "complaint" group (triggers container with CLAUDE.md)
2. [ ] `src/index.ts` routes admin group messages to "admin" group (stub handler in Phase 1)
3. [ ] User phone number and push name passed in the formatted prompt to container
4. [ ] Nanoclaw's existing group message pipeline preserved for admin group
5. [ ] `src/router.ts` updated with 1:1 chat routing support
6. [ ] Messages correctly queued via nanoclaw's GroupQueue mechanism
7. [ ] Container spawned for each complaint conversation with correct mounts

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/index.ts` | Modify | Add 1:1 → "complaint" group routing, pass phone/push name |
| `src/router.ts` | Modify | Add 1:1 routing support |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: 1:1 message routed to "complaint" group
   - Test: admin group message routed to "admin" group
   - Test: phone number included in formatted prompt to container
   - Test: push name included in formatted prompt to container
   - Test: existing group messages still route correctly
   - Test: container spawned with correct group config for complaint messages
   - Edge case: message from unregistered phone number handled gracefully
   - Edge case: admin group JID correctly identified from tenant config
2. **Run tests** — confirm they fail
3. **Implement** — modify routing logic
4. **Refactor** — ensure clean routing code

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the routing modifications.
Use `/requesting-code-review` to validate:
- Routing decision logic (1:1 vs group)
- Prompt formatting for container input
- Integration with nanoclaw's GroupQueue

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify P1-S1, P1-S2 tests still pass
- Test routing with mock 1:1 and group messages

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S7: Create Tenant Configuration System

**As a** developer
**I want** a tenant configuration system that loads MLA-specific settings from a YAML file and injects them into the bot
**So that** the bot's identity, complaint ID prefix, languages, and admin group are configurable per-tenant without code changes

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S1 | Fork nanoclaw and set up project structure | Need the project repo and base config module |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `src/tenant-config.ts` loads and parses YAML config file at `config/tenant.yaml`
2. [ ] Config fields supported: `mla_name`, `constituency`, `complaint_id_prefix`, `wa_admin_group_jid`, `languages`, `daily_msg_limit`, `office_phone`
3. [ ] Config validated on startup — missing required fields cause clear error messages
4. [ ] Tenant config values injected into CLAUDE.md via template variables at startup
5. [ ] Config cached in `tenant_config` table for runtime access by shell scripts
6. [ ] `config/tenant.yaml` created with Rahul Kul defaults
7. [ ] No hardcoded MLA references anywhere — all from config

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `src/tenant-config.ts` | New | Config loader, validator, template injector |
| `config/tenant.yaml` | New | Tenant configuration (Rahul Kul defaults) |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: valid YAML config loads successfully
   - Test: missing required field (`mla_name`) throws validation error
   - Test: missing required field (`constituency`) throws validation error
   - Test: `complaint_id_prefix` read correctly (e.g., "RK")
   - Test: config values cached in `tenant_config` table
   - Test: template variables in CLAUDE.md replaced with config values
   - Test: default values applied for optional fields (e.g., `daily_msg_limit` defaults to 20)
   - Edge case: malformed YAML file returns clear error
   - Edge case: config file not found returns clear error
2. **Run tests** — confirm they fail
3. **Implement** — config loader, validator, template engine
4. **Refactor** — clean up error handling and validation

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the tenant config system.
Use `/requesting-code-review` to validate:
- YAML schema design
- Template variable injection approach
- Validation strategy

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run full test suite
- Verify P1-S1 tests still pass
- Test with sample tenant.yaml

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.

---

## P1-S8: Local Development Setup and End-to-End Testing

**As a** developer
**I want** a complete local development environment with Docker Compose and a working end-to-end complaint flow
**So that** I can develop and test the bot locally before deploying to the k8s cluster

### Dependencies

| Depends On | Story Title | Why |
|------------|-------------|-----|
| P1-S5 | Configure container agent for complaint handling | Need configured agent container to run E2E |
| P1-S6 | Implement message routing in orchestrator | Need routing to dispatch messages to complaint agent |
| P1-S7 | Create tenant configuration system | Need tenant config for bot identity and settings |

> ⛔ **DO NOT START** this story until all dependencies above are marked completed.

### Acceptance Criteria

1. [ ] `docker-compose.dev.yaml` created for local development
2. [ ] Agent container image builds for ARM64
3. [ ] WhatsApp auth flow connects bot to a test number
4. [ ] `CLAUDE_CODE_OAUTH_TOKEN` configured from Claude Code subscription
5. [ ] Bot running locally via `npm run dev` with WhatsApp connected
6. [ ] End-to-end: send complaint via WhatsApp → receive tracking ID in user's language
7. [ ] End-to-end: send "my complaints" → receive list with statuses
8. [ ] Bot responds in Marathi when user writes in Marathi (e.g., "पाणी पुरवठा बंद आहे" → tracking ID response in Marathi)
9. [ ] Bot responds in Hindi when user writes in Hindi
10. [ ] Bot responds in English when user writes in English
11. [ ] Tracking ID format correct: `RK-YYYYMMDD-XXXX` (sequential daily counter)
12. [ ] All complaints stored in SQLite with category, location, description
13. [ ] Agent runs on Sonnet 4.5 via Claude Code subscription (no API billing)
14. [ ] Container uses CLAUDE.md for all behavioral instructions
15. [ ] Shell script tools successfully create/query complaints from inside container

### Files & Scope

| File | Action | What Changes |
|------|--------|-------------|
| `docker-compose.dev.yaml` | New | Local development Docker Compose config |

### Testing Requirements (TDD Workflow)

Use the `/test-driven-development` skill.

1. **Write tests FIRST**:
   - Test: `docker-compose.dev.yaml` is valid Docker Compose config
   - Test: agent container image builds without errors on ARM64
   - Test: bot process starts and connects to WhatsApp
   - Test: complaint intake flow produces valid tracking ID
   - Test: complaint stored in SQLite with all required fields
   - Test: query by tracking ID returns correct complaint
   - Test: query by phone number returns user's complaints
   - Test: language detection works for Marathi input
   - Test: language detection works for Hindi input
   - Test: language detection works for English input
   - Manual verification: end-to-end WhatsApp flow with real phone
2. **Run tests** — confirm they fail
3. **Implement** — Docker Compose config and E2E integration
4. **Refactor** — optimize dev workflow

### Development Workflow

#### Step 1: Architecture Review
Use `/writing-plans` to plan the local dev setup.
Use `/requesting-code-review` to validate:
- Docker Compose service configuration
- ARM64 build strategy
- WhatsApp auth approach for development

#### Step 2: TDD Implementation
Use `/test-driven-development` — tests first, then implement.

#### Step 3: Code Review
Use `/requesting-code-review`. Process feedback via `/receiving-code-review`.
Recode and re-test as needed.

#### Step 4: Verification
Use `/verification-before-completion`:
- Run the FULL test suite (not just this story's tests)
- Confirm no regressions in P1-S1 through P1-S7
- Perform manual end-to-end test with WhatsApp

#### Step 5: Mark Complete
Check off all acceptance criteria. Update STORIES_INDEX.md.
Note: Phase 1 is now complete — all Phase 2+ stories are unblocked.
