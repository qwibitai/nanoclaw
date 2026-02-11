# Constituency Complaint Chatbot — Phase-Wise Implementation Plan

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        K3D CLUSTER (Mac Mini M4)                    │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Namespace: tenant-rahulkul                                  │   │
│  │                                                              │   │
│  │  ┌─────────────────────────┐  ┌──────────────────────────┐  │   │
│  │  │  complaint-bot pod      │  │  admin-dashboard pod     │  │   │
│  │  │  (nanoclaw fork)        │  │  (Phase 4+)              │  │   │
│  │  │                         │  │                           │  │   │
│  │  │  ├─ orchestrator        │  │  Hono API + React SPA    │  │   │
│  │  │  │  (src/index.ts)      │  │  ├─ complaint list       │  │   │
│  │  │  ├─ baileys (WhatsApp)  │  │  ├─ analytics            │  │   │
│  │  │  ├─ rate-limiter        │  │  └─ status updates       │  │   │
│  │  │  ├─ container-runner    │  └──────────────────────────┘  │   │
│  │  │  │  (spawns agents)     │                                │   │
│  │  │  ├─ task-scheduler      │  ┌──────────────────────────┐  │   │
│  │  │  └─ ipc watcher         │  │  static-site pod (nginx) │  │   │
│  │  │         │                │  │  rahulkul.udyami.ai      │  │   │
│  │  │    ┌────┴────┐           │  │  (Phase 3+)             │  │   │
│  │  │    │ SQLite  │           │  └──────────────────────────┘  │   │
│  │  │    │ PV      │           │                                │   │
│  │  │    └─────────┘           │                                │   │
│  │  │         │                │                                │   │
│  │  │    ┌────┴────────────┐   │                                │   │
│  │  │    │ Agent Container │   │                                │   │
│  │  │    │ (per message)   │   │                                │   │
│  │  │    │ Claude Agent SDK│   │                                │   │
│  │  │    │ + complaint     │   │                                │   │
│  │  │    │   tools/scripts │   │                                │   │
│  │  │    │ + CLAUDE.md     │   │                                │   │
│  │  │    │   (bot brain)   │   │                                │   │
│  │  │    └─────────────────┘   │                                │   │
│  │  │                          │                                │   │
│  │  │  ┌─────────────────────┐ │                                │   │
│  │  │  │ whisper pod         │ │                                │   │
│  │  │  │ (faster-whisper     │ │                                │   │
│  │  │  │  OpenAI Whisper)    │ │                                │   │
│  │  │  │ REST API :9000      │ │                                │   │
│  │  │  │ ARM64 / CPU-only    │ │                                │   │
│  │  │  └─────────────────────┘ │                                │   │
│  │  └─────────────────────────┘                                │   │
│  │                                                              │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Namespace: ingress                                          │   │
│  │  Traefik / nginx-ingress → routes to tenant namespaces       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

Claude Code Subscription (via CLAUDE_CODE_OAUTH_TOKEN):
  ┌──────────────────────────────────────────────────────┐
  │ Claude Agent SDK inside containers                    │
  │ Default: Sonnet 4.5 (all tasks)                      │
  │ Upgrade: Opus 4.6 (deep analysis, complex reasoning) │
  │ Cost: Fixed subscription — no per-token billing       │
  └──────────────────────────────────────────────────────┘
```

### Data Flow: Complaint Intake

```
Constituent (WhatsApp)
       │
       │ text / voice note
       ▼
┌──────────────────┐
│ Baileys listener │  src/channels/whatsapp.ts (modified)
│ messages.upsert  │  - Now handles 1:1 chats, not just groups
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ Rate Limiter     │  src/rate-limiter.ts (NEW)
│ - 20 msgs/day    │  - Check per-phone daily count
│ - 5/min cooldown │  - Spam detection (5 msgs in 60s)
└───────┬──────────┘
        │ (pass / block)
        ▼
┌──────────────────┐
│ Message Router   │  src/index.ts (modified)
│ - Route 1:1 →    │  - Registered as "complaint" group
│   complaint grp  │  - Admin group → admin handler
│ - Route group →  │
│   admin handler  │
└───────┬──────────┘
        │
        ├── (if voice note) ──────────────────────┐
        │                                          ▼
        │                               ┌────────────────────┐
        │                               │ Voice Preprocessor │
        │                               │ src/voice.ts (NEW) │
        │                               │                    │
        │                               │ 1. Check duration  │
        │                               │    (reject > 2min) │
        │                               │ 2. Check file size │
        │                               │    (reject > 1MB)  │
        │                               │ 3. Send to Whisper │
        │                               │    pod (REST API)  │
        │                               │ 4. Get transcript  │
        │                               │ 5. Pass as text    │
        │                               └───────┬────────────┘
        │                                       │
        ├───────────────────────────────────────┘
        │ (text or transcribed voice)
        ▼
┌───────────────────────────────────────────────────┐
│ container-runner.ts (nanoclaw original)            │
│ - Spawns agent container for "complaint" group    │
│ - Passes formatted messages as ContainerInput     │
│ - Mounts: SQLite DB, complaint tools, CLAUDE.md   │
└───────┬───────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│ Agent Container (Claude Agent SDK)                 │
│                                                    │
│ CLAUDE.md (bot brain):                             │
│ - Identity & behavioral guardrails                 │
│ - Language detection & response rules              │
│ - Complaint intake flow instructions               │
│ - Category assignment guidelines                   │
│                                                    │
│ Complaint Tools (mounted shell scripts):           │
│ - create-complaint.sh  → insert into SQLite        │
│ - query-complaints.sh  → lookup by phone/ID        │
│ - update-complaint.sh  → change status             │
│ - get-categories.sh    → list categories           │
│ - notify-admin.sh      → post to admin group (IPC) │
│                                                    │
│ Model: Sonnet 4.5 (default)                        │
│        Opus 4.6 (complex analysis — via settings)  │
│                                                    │
│ Session: persists per-user (conversation memory)   │
└───────┬───────────────────────────────────────────┘
        │ OUTPUT_START/END markers
        ▼
┌──────────────────┐
│ Response Builder │  src/index.ts formatOutbound()
│ - Strip tags     │  - Route response to WhatsApp
│ - Send via WA    │  - Notify admin group via IPC
└──────────────────┘
```

### Admin Notification Flow

```
New complaint registered
        │
        ├──────────────────────────┐
        ▼                          ▼
┌──────────────┐          ┌──────────────────┐
│ User gets    │          │ Admin WA Group   │
│ tracking ID  │          │ gets notification│
│ via 1:1 chat │          │ with details     │
└──────────────┘          └───────┬──────────┘
                                  │
                          Admin replies with
                          status update command
                          e.g., "RK-20260211-0042
                          status: in_progress
                          note: contacted water dept"
                                  │
                                  ▼
                          ┌──────────────────┐
                          │ Bot parses update│
                          │ Updates DB       │
                          │ Notifies user    │
                          └──────────────────┘
```

---

## Database Schema (SQLite)

```sql
-- ============================================================
-- TENANT CONFIGURATION (loaded from YAML, cached in DB)
-- ============================================================
CREATE TABLE tenant_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
-- Keys: mla_name, constituency, wa_number, wa_admin_group_jid,
--        website_domain, language_default, daily_msg_limit,
--        office_phone, office_address

-- ============================================================
-- USERS (identified by WhatsApp phone number)
-- ============================================================
CREATE TABLE users (
    phone TEXT PRIMARY KEY,            -- WhatsApp phone (e.g., 919876543210)
    name TEXT,                         -- WhatsApp push name (if available)
    language TEXT DEFAULT 'mr',        -- Detected language: mr, hi, en
    first_seen TEXT NOT NULL,          -- ISO timestamp
    last_seen TEXT NOT NULL,           -- ISO timestamp
    total_complaints INTEGER DEFAULT 0,
    is_blocked INTEGER DEFAULT 0       -- Manual block by admin
);

-- ============================================================
-- COMPLAINTS
-- ============================================================
CREATE TABLE complaints (
    id TEXT PRIMARY KEY,               -- RK-YYYYMMDD-XXXX
    phone TEXT NOT NULL,               -- FK to users.phone
    category TEXT,                     -- AI-assigned category
    subcategory TEXT,                  -- Optional finer classification
    description TEXT NOT NULL,         -- Full complaint text
    location TEXT,                     -- Ward/area
    language TEXT NOT NULL,            -- Language of complaint: mr, hi, en
    status TEXT DEFAULT 'registered',  -- registered|acknowledged|in_progress|
                                       -- action_taken|resolved|on_hold|escalated
    status_reason TEXT,                -- Reason for on_hold/escalated
    priority TEXT DEFAULT 'normal',    -- low|normal|high|urgent
    source TEXT DEFAULT 'text',        -- text|voice
    voice_message_id TEXT,             -- Original voice note ref if applicable
    created_at TEXT NOT NULL,          -- ISO timestamp
    updated_at TEXT NOT NULL,          -- ISO timestamp
    resolved_at TEXT,                  -- ISO timestamp when resolved
    days_open INTEGER GENERATED ALWAYS AS (
        CAST(julianday(COALESCE(resolved_at, datetime('now'))) -
             julianday(created_at) AS INTEGER)
    ) STORED,
    FOREIGN KEY (phone) REFERENCES users(phone)
);
CREATE INDEX idx_complaints_phone ON complaints(phone);
CREATE INDEX idx_complaints_status ON complaints(status);
CREATE INDEX idx_complaints_category ON complaints(category);
CREATE INDEX idx_complaints_created ON complaints(created_at);
CREATE INDEX idx_complaints_days_open ON complaints(days_open);

-- ============================================================
-- COMPLAINT UPDATES (audit trail)
-- ============================================================
CREATE TABLE complaint_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id TEXT NOT NULL,         -- FK to complaints.id
    old_status TEXT,
    new_status TEXT,
    note TEXT,                         -- Admin comment
    updated_by TEXT DEFAULT 'system',  -- 'system' | admin phone number
    created_at TEXT NOT NULL,
    FOREIGN KEY (complaint_id) REFERENCES complaints(id)
);
CREATE INDEX idx_updates_complaint ON complaint_updates(complaint_id);

-- ============================================================
-- CONVERSATION HISTORY (for Claude context)
-- ============================================================
CREATE TABLE conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    role TEXT NOT NULL,                 -- 'user' | 'assistant'
    content TEXT NOT NULL,
    complaint_id TEXT,                  -- Linked complaint if in intake flow
    created_at TEXT NOT NULL,
    FOREIGN KEY (phone) REFERENCES users(phone)
);
CREATE INDEX idx_conversations_phone ON conversations(phone, created_at);

-- ============================================================
-- RATE LIMITING
-- ============================================================
CREATE TABLE rate_limits (
    phone TEXT NOT NULL,
    date TEXT NOT NULL,                 -- YYYY-MM-DD
    message_count INTEGER DEFAULT 0,
    last_message_at TEXT,               -- ISO timestamp (for spam detection)
    recent_timestamps TEXT,             -- JSON array of last 5 message times
    PRIMARY KEY (phone, date)
);

-- ============================================================
-- USAGE TRACKING (subscription model — track volume, not cost)
-- ============================================================
CREATE TABLE usage_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,                         -- NULL for system/admin calls
    complaint_id TEXT,
    model TEXT NOT NULL,                -- 'sonnet-4.5' | 'opus-4.6'
    purpose TEXT,                       -- 'complaint_intake' | 'status_query' |
                                        -- 'voice_transcribe' | 'admin_command' |
                                        -- 'translation' | 'report'
    container_duration_ms INTEGER,      -- How long the container ran
    created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_phone ON usage_log(phone);
CREATE INDEX idx_usage_date ON usage_log(created_at);
CREATE INDEX idx_usage_model ON usage_log(model);

-- ============================================================
-- CATEGORIES (auto-populated, normalized over time)
-- ============================================================
CREATE TABLE categories (
    name TEXT PRIMARY KEY,              -- e.g., 'water_supply'
    display_name_en TEXT,
    display_name_mr TEXT,
    display_name_hi TEXT,
    complaint_count INTEGER DEFAULT 0,
    first_seen TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
);

-- ============================================================
-- NANOCLAW INHERITED TABLES (kept for compatibility)
-- ============================================================
-- chats, messages, registered_groups, sessions, router_state
-- scheduled_tasks, task_run_logs
-- (see nanoclaw schema — retained as-is for group functionality)
```

---

## Tech Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Runtime** | Node.js 22 (ARM64) | Orchestrator + API server |
| **Language** | TypeScript 5.x | Type safety, developer experience |
| **WhatsApp** | @whiskeysockets/baileys 7.x | WhatsApp Web multi-device API |
| **LLM** | Claude Code Subscription | Fixed-cost, no per-token billing |
| **LLM SDK** | @anthropic-ai/claude-agent-sdk | Container-based agent execution (nanoclaw native) |
| **Default Model** | Sonnet 4.5 | All standard tasks (complaints, queries, translations) |
| **Deep Model** | Opus 4.6 | Complex analysis, trend reports, edge cases |
| **Agent Auth** | CLAUDE_CODE_OAUTH_TOKEN | Subscription auth for agent containers |
| **Database** | SQLite via better-sqlite3 | Per-tenant data store |
| **Web Framework** | Hono (lightweight) | Admin dashboard API (Phase 4+) |
| **Frontend** | Astro (static site gen) | MLA website |
| **Admin Dashboard** | React + Tailwind (via Astro) | Complaint management UI (Phase 4+) |
| **Container Runtime** | Docker (ARM64 images) | Agent containers + application packaging |
| **Orchestration** | k3d (k3s in Docker) | Kubernetes on Mac Mini M4 |
| **Ingress** | Traefik (k3d default) | HTTPS routing, domain mapping |
| **CI/CD** | GitHub Actions | Build, test, deploy |
| **Monitoring** | Pino (structured logging) | Application logs |
| **Speech-to-Text** | OpenAI Whisper (faster-whisper) | Voice note transcription, runs locally on k8s |
| **Whisper Runtime** | faster-whisper + CTranslate2 | ARM64-optimized, CPU-only, no GPU needed |
| **Whisper Model** | whisper-small or whisper-medium | Good accuracy for Hindi/Marathi/English |

---

## Phase 1: Core Complaint Bot (Weeks 1–2)

**Goal**: A working WhatsApp bot that accepts complaints in Marathi/Hindi/English, generates tracking IDs, and stores them in SQLite — using nanoclaw's container-based Agent SDK powered by Claude Code subscription.

**Deliverable**: Send a WhatsApp message describing an issue → receive a tracking ID. Query by tracking ID → get status. All in the user's detected language. Zero per-token cost.

### Tasks

1. **Fork nanoclaw and set up project structure**
   - Fork `github.com/gavrielc/nanoclaw` → `github.com/{org}/constituency-bot`
   - Keep the ENTIRE nanoclaw architecture intact: container-runner, Agent SDK, IPC, scheduler
   - Configure `CLAUDE_CODE_OAUTH_TOKEN` for subscription-based auth (no API key billing)
   - Create tenant config loader (`src/tenant-config.ts`)
   - Update container image settings for the complaint bot agent
   - Files modified: `package.json`, `tsconfig.json`, `src/config.ts`

2. **Extend WhatsApp channel for 1:1 chats**
   - Nanoclaw only handles group messages. Modify `src/channels/whatsapp.ts`:
     - Add handler for individual chat messages (JID without `@g.us`)
     - Store individual chat metadata in `chats` table
     - Extract sender phone number from JID
     - Handle WhatsApp push name for user identification
   - Register a virtual "complaint" group that all 1:1 messages route to
   - Files modified: `src/channels/whatsapp.ts`

3. **Create database schema for complaints**
   - Extend `src/db.ts` with all complaint-related tables (see schema above)
   - Add migration system: `src/migrations/001-complaints.sql`
   - Create shell script tools for the agent container to interact with DB:
     - `tools/create-complaint.sh` — inserts complaint record, generates tracking ID
     - `tools/query-complaints.sh` — lookups by phone number or complaint ID
     - `tools/update-complaint.sh` — changes complaint status
     - `tools/get-categories.sh` — lists known categories
   - Generate complaint IDs: `RK-YYYYMMDD-XXXX` (configurable prefix from tenant config)
   - Files modified: `src/db.ts`, NEW: `src/migrations/`, NEW: `tools/`

4. **Write CLAUDE.md — the bot's brain**
   - NEW: `groups/complaint/CLAUDE.md` — this is the core of the bot's behavior
   - Contains:
     - **Identity**: "You are a complaint assistant for {mla_name}'s office in {constituency}"
     - **Language rules**: Auto-detect user's language (Marathi/Hindi/English), respond in same
     - **Complaint intake flow**: Step-by-step instructions for gathering info, clarifying, confirming
     - **Tool usage**: How to call the complaint shell scripts to create/query/update complaints
     - **Behavioral guardrails**: No promises, no politics, redirect off-topic, empathetic always
     - **Response format**: Templates for tracking ID confirmation, status updates, greetings
     - **Category guidelines**: How to auto-categorize (water, roads, electricity, etc.)
   - This file IS the prompt engineering — all bot behavior defined here
   - Files: NEW `groups/complaint/CLAUDE.md`

5. **Configure container agent for complaint handling**
   - Modify `container/Dockerfile` (or build a variant):
     - Mount SQLite database read-write into container
     - Mount `tools/` scripts into container at `/workspace/tools/`
     - Mount tenant config for identity/branding
   - Configure `container/agent-runner/src/index.ts` settings:
     - Default model: **Sonnet 4.5** (`claude-sonnet-4-5-20250929`)
     - Enable model upgrade to **Opus 4.6** for complex cases (via CLAUDE.md instruction:
       "If the complaint is unusually complex or ambiguous, use extended thinking")
   - Set up per-user session persistence so the agent remembers conversation context
   - Files modified: `container/Dockerfile`, `container/agent-runner/src/index.ts`

6. **Implement message routing in orchestrator**
   - Modify `src/index.ts`:
     - Route 1:1 messages → "complaint" group (triggers container with CLAUDE.md)
     - Route admin group messages → "admin" group (stub in Phase 1)
     - Pass user phone number + push name in the formatted prompt to container
     - Keep nanoclaw's existing group message pipeline for admin group
   - Modify `src/router.ts`:
     - Add 1:1 chat routing support
   - Files modified: `src/index.ts`, `src/router.ts`

7. **Create tenant configuration system**
   - NEW: `src/tenant-config.ts`
     - Load YAML config file: `config/tenant.yaml`
     - Fields: `mla_name`, `constituency`, `complaint_id_prefix`, `wa_admin_group_jid`,
       `languages`, `daily_msg_limit`, `office_phone`
     - Validate config on startup
     - Inject tenant config into CLAUDE.md via template variables
     - Cache in `tenant_config` table for runtime access
   - NEW: `config/tenant.yaml` (Rahul Kul defaults)
   - Files: NEW `src/tenant-config.ts`, NEW `config/tenant.yaml`

8. **Local development setup and testing**
   - Docker Compose for local dev: `docker-compose.dev.yaml`
   - Build the agent container image for ARM64
   - WhatsApp auth flow: connect bot to a test number
   - Set `CLAUDE_CODE_OAUTH_TOKEN` from Claude Code subscription
   - Manual end-to-end test: send complaint → get tracking ID → query status
   - Note: k8s cluster is already running but Phase 1 runs locally via `npm run dev`.
     K8s deployment happens in Phase 6; Whisper pod deployed to k8s earlier in Phase 3.
   - Files: NEW `docker-compose.dev.yaml`

### Tech Decisions
- **Keep Agent SDK + containers (nanoclaw native)**: The Claude Code subscription provides
  flat-rate access — no per-token billing. This means we can use the full power of Claude
  Agent SDK with Sonnet 4.5 as default, and Opus 4.6 for complex cases, without worrying
  about cost. The container approach also gives us session persistence, tool use, and
  filesystem access for free.
- **Sonnet 4.5 default, Opus 4.6 for deep thinking**: Sonnet handles all standard tasks
  (language detection, categorization, reply generation). The CLAUDE.md instructs the agent
  to escalate to Opus when encountering complex/ambiguous complaints or when generating
  analytical reports.
- **CLAUDE.md as the bot brain**: All complaint handling logic, guardrails, and behavioral
  rules live in the CLAUDE.md file. This is nanoclaw's native configuration pattern — no
  custom handler code needed. The agent reads instructions and uses mounted tools.
- **Shell script tools for DB operations**: The agent inside the container calls bash scripts
  to interact with SQLite. This leverages Claude Code's native bash tool capability.
  Simple, debuggable, no custom MCP server needed.
- **Stateful sessions**: Nanoclaw persists Claude Code sessions per group. We reuse this
  for per-user conversation memory — the agent naturally remembers prior messages.
- **SQLite from Day 1**: Single file, zero config, fast reads. Mounted into agent containers.

### Multi-Tenant Consideration
- Tenant config file (`config/tenant.yaml`) drives all identity: MLA name, constituency,
  complaint ID prefix, languages.
- CLAUDE.md template is shared, tenant-specific values injected at startup.
- Database is initialized per tenant config — different tenants get different SQLite files.
- Container mounts are tenant-scoped — each tenant's agent sees only their database.
- No hardcoded MLA references anywhere — all from config.

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Baileys connection drops | Keep nanoclaw's auto-reconnect logic; add health check logging |
| WhatsApp bans bot number | Use a dedicated SIM; avoid bulk messaging; respect rate limits |
| Container spawn latency | Nanoclaw's idle timeout keeps containers warm; tune IDLE_TIMEOUT |
| Agent SDK subscription limits | Monitor usage volume; implement rate limiting before limits hit |
| Agent hallucinates DB operations | Shell scripts validate inputs; CLAUDE.md has strict tool-use rules |

### Definition of Done
- [ ] Bot responds to a WhatsApp message in Marathi with complaint acknowledgment and tracking ID
- [ ] Bot responds in Hindi if user writes in Hindi
- [ ] Bot responds in English if user writes in English
- [ ] Tracking ID format: `RK-YYYYMMDD-XXXX` (sequential daily counter)
- [ ] User can ask "my complaints" and get list with statuses
- [ ] All complaints stored in SQLite with category, location, description
- [ ] Agent runs on Sonnet 4.5 via Claude Code subscription (no API billing)
- [ ] Container uses CLAUDE.md for all behavioral instructions
- [ ] Shell script tools successfully create/query complaints from inside container
- [ ] Tenant config loaded from YAML file
- [ ] Bot running locally via `npm run dev` with WhatsApp connected

### Nanoclaw Files Changed
| File | Action | What Changes |
|------|--------|-------------|
| `src/channels/whatsapp.ts` | Modify | Add 1:1 chat handling, phone extraction |
| `src/index.ts` | Modify | Add 1:1 → "complaint" group routing |
| `src/db.ts` | Extend | Add complaint/user/usage tables and helpers |
| `src/config.ts` | Modify | Add tenant config env vars |
| `src/logger.ts` | Keep | No changes |
| `src/types.ts` | Extend | Add complaint/user/conversation types |
| `src/router.ts` | Modify | Add 1:1 routing support |
| `src/container-runner.ts` | Modify | Add complaint DB mount, tools mount |
| `src/group-queue.ts` | Keep | Reuse for message queueing |
| `src/ipc.ts` | Keep | Reuse for admin group communication |
| `src/task-scheduler.ts` | Keep | Will use in Phase 2 for daily summaries |
| `container/Dockerfile` | Modify | Add sqlite3 CLI, mount points for tools |
| `container/agent-runner/src/index.ts` | Modify | Set Sonnet 4.5 default model |
| `groups/complaint/CLAUDE.md` | **NEW** | Bot brain — all complaint handling logic |
| `tools/*.sh` | **NEW** | DB interaction scripts for agent container |
| `config/tenant.yaml` | **NEW** | Tenant configuration |
| `src/tenant-config.ts` | **NEW** | Config loader and validator |

---

## Phase 2: Rate Limiting, Safety & Admin Notifications (Weeks 3–4)

**Goal**: Production-ready bot with abuse prevention, content safety, and admin group integration for real-world deployment.

**Deliverable**: Bot enforces daily message limits, detects spam, handles abusive users gracefully. New complaints auto-posted to admin WhatsApp group. Admins can update complaint status from the group.

### Tasks

1. **Implement rate limiter**
   - NEW: `src/rate-limiter.ts`
     - `checkRateLimit(phone): { allowed: boolean, reason?: string }`
     - Daily limit: configurable via tenant config (default 20 msgs/day)
     - Spam detection: track last 5 message timestamps; if 5+ messages within 60 seconds, cooldown for 60s
     - Store in `rate_limits` table (per phone, per date)
     - Return appropriate message in user's language when limited
   - Hook into message pipeline before complaint handler

2. **Harden content safety in system prompts**
   - Create `src/prompts/system-prompt.ts` with templated guardrails:
     - Identity: "You are a complaint assistant for {mla_name}'s office in {constituency}"
     - NEVER: make promises, discuss politics, share other users' data, use offensive language
     - ALWAYS: be polite, empathetic, redirect off-topic, acknowledge frustration
     - Language: respond in same language as user
   - Add input sanitization: strip potential prompt injection attempts
   - Test with adversarial inputs: political questions, abusive language, off-topic requests

3. **Build admin group notification system**
   - NEW: `src/admin-handler.ts`
     - On new complaint → format and post to admin WhatsApp group:
       ```
       🆕 New Complaint
       ID: RK-20260211-0042
       From: +91 98765 43210
       Category: Water Supply
       Location: Ward 7, Shivaji Nagar
       Description: No water supply for 3 days
       Status: Registered
       ```
     - On status change → notify admin group
   - Admin group commands (parsed from group messages):
     - `#update RK-20260211-0042 in_progress: Contacted water dept` → updates status, notifies user
     - `#resolve RK-20260211-0042: Issue fixed` → marks resolved, notifies user
     - `#escalate RK-20260211-0042: Needs collector attention` → escalates
     - `#hold RK-20260211-0042: Waiting for MSEDCL response` → puts on hold with reason
   - Use nanoclaw's existing group message handling + IPC for routing

4. **User notification on status updates**
   - When admin updates complaint status via group command:
     - Parse command, validate complaint ID
     - Update `complaints` table + insert into `complaint_updates`
     - Send WhatsApp message to constituent in their stored language:
       ```
       तक्रार अपडेट 📢
       तक्रार क्र.: RK-20260211-0042
       स्थिती: कार्यवाही सुरू ✅
       टीप: महानगरपालिका पाणीपुरवठा विभागाशी संपर्क साधला आहे.
       ```
     - Translate status update note using Claude (Sonnet) if admin writes in English but user's language is Marathi

5. **Daily summary scheduled task**
   - Use nanoclaw's `task-scheduler.ts` to schedule daily summary at 9 AM:
     - Total open complaints by status
     - New complaints today
     - Aging complaints (> 7 days, > 14 days, > 30 days)
     - Top categories
   - Post summary to admin WhatsApp group

6. **Usage volume monitoring**
   - Add daily usage summary to admin group (appended to daily summary):
     - Total messages processed today
     - Container runs count and average duration
     - Sonnet vs Opus usage breakdown
   - Log all container runs to `usage_log` table for trend analysis
   - Alert if daily message volume exceeds configurable threshold (capacity planning)

### Tech Decisions
- **Admin commands via WhatsApp group**: Simple, no extra UI needed. Admins already use WhatsApp. Structured commands (`#update`, `#resolve`) are easy to parse and teach.
- **Sonnet for everything (subscription)**: No need to split models for cost reasons. Sonnet 4.5 handles translations, intent parsing, and categorization — all under flat-rate subscription.

### Multi-Tenant Consideration
- Admin group JID is in tenant config — each tenant has their own admin group
- Rate limit thresholds configurable per tenant
- Daily summary template can be tenant-customized

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Admin commands too rigid | Allow natural language commands; Claude parses intent |
| Rate limiting too aggressive | Make thresholds configurable; start generous (20/day) |
| Prompt injection via complaint text | Sanitize inputs; separate user content from instructions in Claude calls |

### Definition of Done
- [ ] Sending 21st message in a day returns rate limit message in user's language
- [ ] Sending 5 messages in 30 seconds triggers spam cooldown
- [ ] Asking about politics returns polite redirect
- [ ] Abusive message gets calm, empathetic response
- [ ] New complaint appears in admin WhatsApp group within 30 seconds
- [ ] `#update RK-XXXX in_progress: note` updates status and notifies constituent
- [ ] Daily summary posts to admin group at 9 AM
- [ ] Usage volume visible in daily summary (message count, container runs)

---

## Phase 3: Voice Notes & Static Website (Weeks 5–6)

**Goal**: Accept voice complaints via OpenAI Whisper transcription and launch the MLA's public website with WhatsApp bot link.

**Deliverable**: Constituents can send voice notes as complaints (transcribed by Whisper, oversized audio rejected). rahulkul.udyami.ai is live with MLA info and "File a Complaint" QR code.

### Tasks

1. **Deploy Whisper pod on k8s cluster**
   - Deploy `faster-whisper` as a dedicated pod in the tenant namespace:
     - Image: `fedirz/faster-whisper-server` (ARM64-compatible) or build custom
     - Model: `whisper-small` for Phase 1 (good Hindi/Marathi/English accuracy,
       low resource usage). Upgrade to `whisper-medium` if accuracy insufficient.
     - Expose as ClusterIP Service on port 9000 (internal only, not public)
     - REST API: `POST /v1/audio/transcriptions` (OpenAI-compatible endpoint)
     - CPU-only — no GPU needed on Mac Mini M4 (slower but sufficient for ~20 voice notes/day)
     - Resource limits: 512MB RAM, 1 CPU core
   - K8s manifests: `k8s/whisper/deployment.yaml`, `service.yaml`
   - Files: NEW `k8s/whisper/`

2. **Voice note preprocessing and validation**
   - NEW: `src/voice.ts` — voice note handler before agent container
     - **Size guard**: Reject audio files > **1MB** (~2 minutes of OGG/Opus)
       - Reply in user's language: "कृपया तुमची तक्रार २ मिनिटांत सांगा" /
         "Please keep your voice message under 2 minutes"
     - **Duration guard**: Parse OGG header for duration, reject > **120 seconds**
     - Download voice note binary via Baileys `downloadMediaMessage()`
     - Convert OGG/Opus → WAV if needed (using ffmpeg in bot container, or pass OGG directly)
     - Send to Whisper pod: `POST http://whisper-svc:9000/v1/audio/transcriptions`
       with `language` hint if user's language is known from prior messages
     - Receive transcript text
     - Log: `source: 'voice'`, `voice_message_id`, transcript in `conversations` table
     - Pass transcript as regular text to the complaint agent container
   - Files: NEW `src/voice.ts`

3. **Modify WhatsApp channel for audio messages**
   - Modify `src/channels/whatsapp.ts`:
     - Detect `audioMessage` type from Baileys `messages.upsert`
     - Extract audio metadata: file size, duration (from message info), mimetype
     - Route audio messages through `src/voice.ts` before the complaint handler
     - On Whisper failure: reply "मला तुमचा आवाज समजला नाही. कृपया लिहून पाठवा." /
       "I couldn't understand your voice message. Please type your complaint."
   - Files modified: `src/channels/whatsapp.ts`

4. **Build static website with Astro**
   - NEW: `website/` directory in repo
   - Astro project with these pages/sections:
     - Hero: MLA photo, constituency name, tagline
     - About: Brief bio, role, constituency info
     - Initiatives: Key achievements (configurable via markdown files)
     - News/Events: Feed from markdown files in `website/content/events/`
     - Photo Gallery: Grid layout, images from `website/public/gallery/`
     - File a Complaint: WhatsApp bot link + QR code (wa.me/{number})
     - Contact: Office address, phone, email, map embed
     - Footer: Social media links
   - All content driven by markdown/YAML files (easy to update)
   - Responsive design, mobile-first (constituency users are mobile-heavy)
   - Marathi as primary language, English secondary

5. **Website CI/CD pipeline**
   - GitHub Actions workflow: `.github/workflows/website.yaml`
     - On push to `dev` branch → build Astro → deploy to dev.rahulkul.udyami.ai
     - On push to `main` branch → build Astro → deploy to rahulkul.udyami.ai
   - Deployment target: nginx pod in existing k8s cluster

6. **Kubernetes deployment for website**
   - `k8s/website/` — Deployment, Service, Ingress manifests
   - nginx pod serving Astro build output
   - Traefik ingress rules for domain routing
   - TLS via Let's Encrypt (cert-manager or Traefik ACME)

### Tech Decisions
- **OpenAI Whisper (local, not API)**: Runs as a pod on the existing k8s cluster using
  `faster-whisper` (CTranslate2 optimized). Free, no external API calls, supports
  Hindi/Marathi/English. ARM64-compatible, CPU-only. Transcription happens in ~5-10 seconds
  for a 1-minute voice note on CPU.
- **Reject large audio upfront**: Prevents system overload. WhatsApp allows up to 16-minute
  voice notes, but we cap at 2 minutes / 1MB. This keeps Whisper processing fast and
  prevents abuse. Most genuine complaints can be stated in under 1 minute.
- **Whisper transcribes, Claude analyzes**: Clean separation — Whisper does speech-to-text,
  then the transcript is passed as regular text to the complaint agent. The agent
  (Sonnet 4.5) handles language detection, categorization, and response in the same flow
  as text complaints.
- **Astro for static site**: Lightweight, fast builds, markdown-driven content, zero client
  JS by default. Perfect for a constituency site that's mostly informational.

### Multi-Tenant Consideration
- Whisper pod can be shared across tenants (stateless, no tenant data stored)
- Website content directory (`website/content/`) is per-tenant
- Website theme/branding configurable via Astro config (colors, fonts, logo)
- Each tenant gets their own domain (configured in ingress)
- Voice size/duration limits configurable per tenant in `config/tenant.yaml`

### Risks & Mitigations
| Risk | Mitigation |
|------|-----------|
| Whisper accuracy for Marathi | Use `whisper-medium` model; add language hint from user profile; fallback to text |
| Whisper pod OOM on large audio | Hard 1MB/2min limit enforced BEFORE sending to Whisper; resource limits on pod |
| Too many voice notes queuing up | Rate limiter already caps messages; Whisper processes sequentially per tenant |

### Definition of Done
- [ ] Send a voice note (< 2 min) → bot transcribes via Whisper and registers complaint
- [ ] Send a voice note (> 2 min) → bot rejects with polite message in user's language
- [ ] Send a large audio file (> 1MB) → bot rejects with size limit message
- [ ] Whisper pod running on k8s cluster: `kubectl get pods` shows whisper pod healthy
- [ ] Voice complaint has same fields as text complaint (category, location, tracking ID)
- [ ] Whisper failure gracefully falls back to "please type your complaint"
- [ ] rahulkul.udyami.ai loads with all sections
- [ ] dev.rahulkul.udyami.ai updates on push to dev branch
- [ ] Site is mobile-responsive
- [ ] "File a Complaint" section has working WhatsApp link and QR code

---

## Phase 4: Web Admin Dashboard (Weeks 7–8)

**Goal**: Give MLA's team a web interface for complaint management, filtering, and basic analytics.

**Deliverable**: Web dashboard at admin.rahulkul.udyami.ai showing all complaints with filters, status updates, and charts.

### Tasks

1. **Dashboard API**
   - NEW: `src/api/` directory
   - Hono-based REST API (lightweight, runs in same Node.js process as bot):
     - `GET /api/complaints` — list with filters (status, category, date range, ward)
     - `GET /api/complaints/:id` — single complaint with history
     - `PATCH /api/complaints/:id` — update status (triggers WhatsApp notification)
     - `GET /api/stats` — aggregate statistics
     - `GET /api/usage` — volume tracking data (messages, container runs)
     - `GET /api/categories` — complaint categories with counts
   - Simple auth: API key in header (Phase 1 of dashboard), OAuth later

2. **Dashboard frontend**
   - React SPA (built with Vite, served by same Hono server):
     - Complaint list view: table with sort/filter/search
     - Complaint detail view: full history, status timeline, update form
     - Dashboard home: cards showing open/resolved/aging counts
     - Charts: complaints over time, by category, by ward, resolution time
     - Usage volume: daily/weekly message and container run charts
   - TailwindCSS for styling
   - Mobile-friendly (admins may check on phone)

3. **Authentication for dashboard**
   - Simple password-based auth (1-3 admin users)
   - JWT tokens stored in httpOnly cookies
   - Admin users defined in tenant config
   - No public registration — invite-only

4. **Kubernetes ingress for dashboard**
   - Route `admin.rahulkul.udyami.ai` to dashboard
   - TLS termination at ingress

### Tech Decisions
- **Hono over Express**: Lighter, faster, TypeScript-first, runs on any runtime. Perfect for a simple API.
- **Single process**: Dashboard API runs in the same Node.js process as the bot. Shares the SQLite connection. No inter-process complexity. At 100 complaints/day, this easily handles the load.

### Multi-Tenant Consideration
- Dashboard auth is per-tenant (different admin users per MLA)
- API queries always scoped to tenant's database
- Dashboard domain configurable per tenant

### Definition of Done
- [ ] Dashboard loads at admin.rahulkul.udyami.ai
- [ ] Complaint list shows all complaints with working filters
- [ ] Clicking a complaint shows full detail with update history
- [ ] Updating status from dashboard sends WhatsApp notification to constituent
- [ ] Dashboard home shows summary statistics
- [ ] Usage volume chart shows daily message/container stats

---

## Phase 5: Analytics, Reporting & Opus Deep Analysis (Weeks 9–10)

**Goal**: Deep analytics for MLA's team, weekly reports, and Opus-powered trend analysis.

**Deliverable**: Auto-generated weekly constituency report. Opus 4.6 used for deep trend analysis and complex complaint resolution patterns.

### Tasks

1. **Weekly constituency report**
   - Scheduled task (nanoclaw scheduler): every Monday 9 AM
   - Agent container with Opus 4.6 generates comprehensive report:
     - Complaints received this week vs last week
     - Resolution rate and average resolution time
     - Top 5 complaint categories
     - Ward-wise complaint distribution
     - Aging complaints requiring attention
     - AI-generated narrative analysis of trends and recommendations
   - Post summary to admin WhatsApp group
   - Store report in dashboard for download

2. **Opus 4.6 for deep analysis tasks**
   - Create `groups/analyst/CLAUDE.md` — a separate agent group for analytical work:
     - Uses Opus 4.6 model for superior reasoning
     - Scheduled tasks trigger this agent for reports, trend analysis
     - Has read-only access to complaint database
   - Configure in `container/agent-runner` settings to select Opus model
   - Use cases: weekly reports, trend detection, anomaly analysis, cross-category patterns

3. **Complaint trend analysis**
   - Dashboard page: trend charts by category, ward, time
   - Alert: if a category spikes (e.g., 10x more water complaints than usual), auto-flag in admin group
   - Opus agent generates weekly narrative summary explaining patterns and suggesting action

4. **Export functionality**
   - CSV export of complaints (filtered)
   - Excel-compatible format for government reporting
   - API endpoint: `GET /api/export?format=csv&status=open&from=...&to=...`

### Multi-Tenant Consideration
- Report templates customizable per tenant
- Opus usage configurable per tenant (some may not need deep analysis)
- Export format may vary per state/government requirements

### Definition of Done
- [ ] Weekly report auto-generated and posted to admin group with narrative analysis
- [ ] Opus 4.6 generates trend insights that Sonnet alone couldn't produce
- [ ] Trend spike alert triggered when category volume exceeds 3x baseline
- [ ] CSV export works with all filters
- [ ] Analyst agent runs on schedule without impacting complaint bot performance

---

## Phase 6: Production Deployment on Existing K8s Cluster (Weeks 11–12)

**Goal**: Deploy the full system (bot + dashboard + whisper) to the existing k3d cluster with CI/CD and production hardening.

**Deliverable**: All components running on the existing k8s cluster with automated GitHub-triggered deployments, health checks, and backups.

**Note**: The k8s cluster is already running. Phases 1–5 run locally via `npm run dev`.
This phase packages everything and deploys to the cluster.

### Tasks

1. **Create production Dockerfile for the bot**
   - Multi-stage build:
     - Stage 1: `node:22-slim` (ARM64) — build TypeScript
     - Stage 2: `node:22-slim` (ARM64) — runtime with ffmpeg (for voice note conversion)
   - Include: bot orchestrator, dashboard API, dashboard frontend (all in one image)
   - SQLite database on persistent volume
   - WhatsApp auth state on persistent volume
   - Agent container image built separately (nanoclaw's existing `container/Dockerfile`)

2. **Kubernetes manifests for all components**
   - Deploy into existing cluster, namespace: `tenant-rahulkul`
   - NEW: `k8s/bot/` directory:
     - `statefulset.yaml` — bot pod (1 replica, stable storage)
     - `service.yaml` — ClusterIP service
     - `pvc.yaml` — PersistentVolumeClaim for SQLite + WhatsApp auth
     - `configmap.yaml` — tenant config (tenant.yaml) mounted as volume
     - `secret.yaml` — CLAUDE_CODE_OAUTH_TOKEN, admin passwords
     - `ingress.yaml` — Traefik routes for dashboard subdomain
   - Reuse existing `k8s/whisper/` from Phase 3
   - Reuse existing `k8s/website/` from Phase 3
   - All pods in same namespace, communicate via ClusterIP services

3. **CI/CD pipeline for bot**
   - `.github/workflows/bot.yaml`:
     - On push to `main`: build Docker image → push to cluster registry → `kubectl rollout`
     - Run TypeScript compilation check
     - Run basic integration tests
   - Deployment strategy: rolling update (single replica, so recreate)

4. **Health checks and monitoring**
   - Liveness probe: HTTP endpoint `/health`
   - Readiness probe: check WhatsApp connection + SQLite access + Whisper pod reachable
   - Structured logs (Pino) → stdout → `kubectl logs`
   - Alert on: bot disconnected > 5 min, Whisper pod unhealthy, errors > 10/hour

5. **Backup strategy**
   - Daily SQLite backup (copy to host volume via k8s CronJob)
   - WhatsApp auth state backup (same CronJob)
   - Retention: keep last 7 daily backups
   - Restore procedure documented

### Tech Decisions
- **Deploy to existing cluster, not create new one**: k3d cluster is already running.
  We just add namespace + manifests. No infrastructure provisioning needed.
- **StatefulSet over Deployment**: SQLite needs stable storage. StatefulSet with PVC
  ensures data survives pod restarts.
- **Single pod for bot + dashboard**: At this scale (100 complaints/day), one pod is
  sufficient. Whisper runs as a separate pod (stateless, can be shared).

### Multi-Tenant Consideration
- Each tenant gets own namespace: `tenant-{name}`
- ConfigMap per tenant with their YAML config
- Separate PVCs per tenant (data isolation)
- Shared container image (same code, different config)
- Whisper pod can be shared across tenants (stateless transcription service)
- Script to provision new tenant: `scripts/provision-tenant.sh`

### Definition of Done
- [ ] `kubectl get pods -n tenant-rahulkul` shows bot + whisper + website pods running
- [ ] Bot auto-reconnects after pod restart
- [ ] Dashboard accessible via ingress at admin.rahulkul.udyami.ai
- [ ] Website accessible at rahulkul.udyami.ai
- [ ] GitHub push to main triggers automated deployment
- [ ] SQLite backup CronJob running daily
- [ ] Health check endpoints responding
- [ ] Whisper pod reachable from bot pod via ClusterIP service

---

## Phase 7: Multi-Tenant Provisioning (Weeks 13–14)

**Goal**: Onboard a second MLA with zero code changes — config only.

**Deliverable**: Second tenant running on same cluster with completely isolated data.

### Tasks

1. **Tenant provisioning script**
   - `scripts/provision-tenant.sh <tenant-name>`:
     - Create k8s namespace
     - Generate tenant config template (YAML)
     - Create PVCs for SQLite + WhatsApp auth
     - Deploy bot pod with tenant-specific ConfigMap
     - Create ingress rules for tenant's domains
   - Interactive prompts for: MLA name, constituency, WhatsApp number, domains

2. **Shared admin CLI**
   - `scripts/tenant-admin.sh`:
     - List all tenants and their status
     - View tenant resource usage (pods, storage, API costs)
     - Restart tenant bot
     - View tenant logs
     - Backup/restore tenant data

3. **Tenant onboarding documentation**
   - Step-by-step guide for adding new MLA
   - WhatsApp number registration process
   - DNS configuration for tenant domains
   - Content setup for tenant website

4. **Cross-tenant cost dashboard** (optional)
   - Aggregate token usage across tenants
   - Per-tenant billing view
   - Global cost tracking

### Multi-Tenant Consideration
- This IS the multi-tenant phase — validate complete isolation
- Test: tenant A cannot see tenant B's data
- Test: tenant A's rate limits don't affect tenant B
- Test: tenant A's WhatsApp connection is independent

### Definition of Done
- [ ] Second tenant provisioned with single script run
- [ ] Both tenants running simultaneously on same cluster
- [ ] Zero data leakage between tenants (verified)
- [ ] Each tenant has independent WhatsApp connection
- [ ] Admin can view/manage all tenants from CLI

---

## Phase 8: WhatsApp CMS for Website Updates (Weeks 15–16)

**Goal**: MLA's team can update the website by sending WhatsApp messages to a content channel.

**Deliverable**: Send a photo with caption to admin group → appears on dev site → approve → goes live.

### Tasks

1. **Content ingestion from WhatsApp**
   - Add CMS commands to admin group handler:
     - Photo + caption with `#gallery` → add to photo gallery
     - Photo + caption with `#event` → create news/event entry
     - Text with `#achievement` → add to achievements section
     - Text with `#announcement` → add to hero/banner area
   - Download and store media files
   - Generate markdown content files from messages

2. **Auto-commit to dev branch**
   - Bot generates content files (markdown + images)
   - Commits to `dev` branch of website repo
   - GitHub Actions builds and deploys to dev.rahulkul.udyami.ai
   - Bot sends preview link to admin group

3. **Approval and publish flow**
   - Admin reviews at dev.rahulkul.udyami.ai
   - Sends `#approve` in admin group
   - Bot merges dev → main, triggering production deploy
   - Bot confirms: "Website updated! Changes live at rahulkul.udyami.ai"

4. **Content moderation**
   - Run uploaded images through basic validation (file size, format)
   - Use Claude to review caption/text for appropriateness
   - Flag potentially sensitive content for explicit admin approval

### Multi-Tenant Consideration
- Each tenant's website is a separate repo (or branch per tenant)
- CMS commands scoped to tenant's admin group
- Image storage per tenant (separate directory/PV)

### Definition of Done
- [ ] Photo sent to admin group with `#gallery` appears on dev site
- [ ] `#approve` merges to main and site updates
- [ ] Content moderation catches inappropriate uploads
- [ ] Full flow works end-to-end in < 5 minutes

---

## Phase 9: Advanced Features (Weeks 17–18)

**Goal**: Complaint routing, escalation automation, and user satisfaction tracking.

**Deliverable**: Complaints auto-routed to responsible department. Users get satisfaction survey after resolution.

### Tasks

1. **Auto-routing by category**
   - Map complaint categories to responsible team members/departments
   - When complaint registered, tag the relevant admin in the group notification
   - Configurable routing rules in tenant config

2. **Escalation automation**
   - Auto-escalate complaints open > 7 days with no status update
   - Bot posts escalation notice to admin group
   - Configurable SLA thresholds per category

3. **User satisfaction survey**
   - After complaint resolved, send follow-up after 24 hours:
     - "Was your issue resolved satisfactorily? Reply 1-5"
   - Store rating in `complaint_updates`
   - Include satisfaction scores in weekly report

4. **Bulk operations from dashboard**
   - Select multiple complaints → update status
   - Assign complaints to team members
   - Add internal notes (not sent to constituent)

### Definition of Done
- [ ] Complaints auto-routed to tagged admin by category
- [ ] Complaints auto-escalated after configurable SLA
- [ ] Satisfaction survey sent 24h after resolution
- [ ] Satisfaction score visible in dashboard and weekly report

---

## Phase 10: Polish & Scale Prep (Weeks 19–20)

**Goal**: Production hardening, performance optimization, and preparation for scaling.

**Deliverable**: System ready for 5+ tenants with monitoring and observability.

### Tasks

1. **Performance optimization**
   - SQLite WAL mode for better concurrent reads
   - Container warm-up: tune IDLE_TIMEOUT to keep agents alive between messages
   - Message batching: GroupQueue tuning for optimal throughput
   - Session pruning: archive old conversation sessions to reduce context size

2. **Observability**
   - Prometheus metrics endpoint
   - Grafana dashboard for: message volume, response times, container durations, error rates
   - PagerDuty/webhook alerts for critical issues

3. **PostgreSQL migration path** (document, don't implement yet)
   - Schema migration scripts from SQLite → PostgreSQL
   - When to migrate: > 10 tenants or > 50K complaints per tenant
   - Use Drizzle ORM or Kysely for database-agnostic queries

4. **Security hardening**
   - Rate limiting on dashboard API
   - CSRF protection
   - Input validation on all API endpoints
   - Audit logging for admin actions
   - Regular SQLite integrity checks

5. **Documentation**
   - Operations runbook: common issues and resolutions
   - API documentation for dashboard
   - Tenant onboarding checklist
   - Disaster recovery procedures

### Definition of Done
- [ ] System handles 500 messages/day without degradation
- [ ] Monitoring dashboard shows all key metrics
- [ ] PostgreSQL migration documented (not yet needed)
- [ ] Security audit checklist passed
- [ ] Operations runbook complete

---

## Cost Estimate

### Claude Code Subscription Model

Using Claude Code subscription eliminates per-token API billing entirely. All LLM usage
(Sonnet 4.5 default + Opus 4.6 for deep analysis) is covered by the flat monthly subscription.

| Cost Component | Monthly Cost | Notes |
|---------------|-------------|-------|
| **Claude Code subscription** | $20/month (Pro) or $100/month (Max) | Covers all Sonnet + Opus usage |
| **Infrastructure (k3d on Mac Mini M4)** | $0 (existing hardware) | Cluster already running |
| **Whisper pod** | $0 (runs on existing cluster) | ~512MB RAM, 1 CPU core |
| **WhatsApp SIM** | ~$2/month | Prepaid SIM for bot number |
| **Domain (udyami.ai subdomain)** | $0 | Existing domain |
| **GitHub (repo + Actions)** | $0 | Free tier sufficient |
| **TOTAL (single tenant)** | **~$22–102/month** | Depends on subscription tier |

### Subscription Capacity at Medium Load (100 complaints/day)

| Activity | Daily Volume | Container Runs/Day | Whisper Runs/Day | Notes |
|----------|-------------|-------------------|-----------------|-------|
| Text complaints | ~80 | ~240 (avg 3 msgs each) | 0 | Sonnet 4.5 |
| Voice complaints | ~20 | ~60 (avg 3 msgs each) | ~20 | Whisper → Sonnet 4.5 |
| Status inquiries | ~50 | ~50 | 0 | Sonnet 4.5 |
| Admin commands | ~30 | ~30 | 0 | Sonnet 4.5 |
| Daily summary | 1 | 1 | 0 | Opus 4.6 |
| **TOTAL** | | **~381 container runs/day** | **~20** | |

Whisper processing: ~5-10 seconds per voice note (CPU, whisper-small model).
At 20 voice notes/day, Whisper pod utilization is minimal (~3-4 min total/day).

### Why Subscription > Per-Token API

| Factor | Per-Token API | Claude Code Subscription |
|--------|-------------|-------------------------|
| Monthly cost at 100 complaints/day | ~$19/month | $20–100/month (flat) |
| Monthly cost at 500 complaints/day | ~$95/month | $20–100/month (flat) |
| Monthly cost at 1000 complaints/day | ~$190/month | $20–100/month (flat) |
| Opus 4.6 access | Very expensive per token | Included in Max plan |
| Cost predictability | Variable, usage-based | Fixed, predictable |
| Model quality worry | Tendency to use cheaper Haiku | Always use best model (Sonnet) |

**Break-even**: Subscription becomes cheaper at ~120+ complaints/day vs per-token API.
At scale (500+/day), subscription saves 80%+ vs API billing.

### Multi-Tenant Cost Scaling

Each tenant needs their own Claude Code subscription. At 10 tenants:
- Per-token API: ~$190/month (variable, hard to predict)
- Subscription: ~$200–1000/month (predictable, better quality)

For multi-tenant, consider Claude Max plan ($100/month) with higher rate limits
to handle multiple tenants from a single subscription (if ToS allows).

---

## Risk Register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|-----------|
| 1 | **WhatsApp number ban** — Meta may flag the bot number for automated messaging | Medium | Critical | Use business-grade SIM; keep message volume reasonable; never send unsolicited bulk messages; implement warm-up period (gradually increase volume); have backup number ready |
| 2 | **Baileys library breaking changes** — Unofficial library, WhatsApp protocol changes can break it | Medium | High | Pin Baileys version; monitor GitHub issues; have fallback plan (WhatsApp Business API if budget allows later); keep WhatsApp auth state backed up |
| 3 | **Claude Code subscription rate limits** — Subscription may throttle at high volume | Medium | Medium | Rate limiting per user prevents spikes; queue messages during throttle; monitor container run counts; keep per-token API key as fallback |
| 4 | **Data privacy incident** — Complaint data leaked or cross-tenant contamination | Low | Critical | Per-tenant SQLite isolation; no cross-tenant queries possible; encrypted backups; admin auth on dashboard; audit logging; regular security review |
| 5 | **Single point of failure** — Bot pod crash = total service outage | Medium | High | k8s auto-restart (liveness probe); SQLite WAL mode for crash recovery; WhatsApp auth state on PVC survives pod restart; daily backups; offline message queue (WhatsApp holds messages for ~30 days) |
| 6 | **Container spawn overhead** — Agent container startup adds latency per message | Low | Medium | Nanoclaw's IDLE_TIMEOUT keeps containers warm; tune concurrency limits; batch rapid messages via GroupQueue |

---

## Dependency Graph

```
                    ┌── existing k8s cluster ──┐
                    │  (available from Day 1)   │
                    └───────────┬───────────────┘
                                │
Phase 1 ──→ Phase 2 ──→ Phase 3 (Voice+Website) ──→ Phase 5 (Analytics)
   │            │         │  │                             │
   │            │         │  │ Whisper pod → k8s           ▼
   │            │         │  │ Website pod → k8s     Phase 8 (CMS)
   │            │         │  │
   │            ▼         ▼  ▼
   │        Phase 4 ──→ Phase 6 (Deploy bot to k8s)
   │                          │
   │                          ▼
   │                    Phase 7 (Multi-tenant)
   │                          │
   │                          ▼
   │                    Phase 9 (Advanced)
   │                          │
   │                          ▼
   └────────────────→ Phase 10 (Scale)
```

- **k8s cluster is already running** — no infrastructure setup needed
- Phase 1 is prerequisite for everything (runs locally via `npm run dev`)
- Phase 2 must come before any public deployment
- Phase 3 deploys Whisper pod + website pod to existing k8s cluster early
- Phase 4 (dashboard) depends on Phase 2 (admin flow)
- Phase 6 deploys the bot itself to k8s (dashboard already running locally)
- Phase 7 (multi-tenant) requires Phase 6 (bot running on k8s)
- Phase 8 (CMS) requires Phase 3 (website exists on k8s)
- Phase 9 and 10 can be reordered based on business priority
