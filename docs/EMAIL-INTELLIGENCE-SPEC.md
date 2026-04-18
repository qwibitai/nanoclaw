# NanoClaw Email Intelligence & Proactive Assistant Spec

> **Status:** Draft v2 (reviewed, gaps addressed)
> **Created:** 2026-04-10
> **Updated:** 2026-04-10
> **Origin:** Design session (6 sections approved), then critic review

---

## Core Principle

**The measure of success is fewer notifications over time, not more.**

NanoClaw should decrease your workload on low-priority stuff and eliminate noise — not replace email noise with Telegram noise. As the system learns and autonomy grows, most days you should see only the morning briefing and maybe 1-2 escalations.

---

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         YOUR CHANNELS                               │
│  Telegram  ·  Discord  ·  WhatsApp  ·  Slack  ·  Gmail (via SP)   │
└──────┬──────────┬──────────┬──────────┬──────────┬──────────────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        NANOCLAW CORE                                │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ IPC Trigger   │  │ Agent Session │  │ Task Scheduler         │  │
│  │ (SP writes    │─▶│ (multi-turn   │  │ (morning briefing,     │  │
│  │  IPC files)   │  │  container)   │  │  weekly review, etc.)  │  │
│  └──────────────┘  └───────┬───────┘  └────────────────────────┘  │
│                            │                                       │
│                   ┌────────┴────────┐                              │
│                   │ Autonomy Engine │                              │
│                   │ AUTO / PROPOSE  │                              │
│                   │ / ESCALATE      │                              │
│                   └────────┬────────┘                              │
│                            │                                       │
│              ┌─────────────┼─────────────┐                        │
│              ▼             ▼             ▼                         │
│     ┌──────────────┐ ┌─────────┐ ┌────────────┐                  │
│     │ Action        │ │ Report  │ │ Knowledge  │                  │
│     │ Executor      │ │ Router  │ │ Manager    │                  │
│     │ (calendar,    │ │ (TG,    │ │ (CLAUDE.md │                  │
│     │  GitHub, FS,  │ │  DC,    │ │  + SP KB   │                  │
│     │  email draft) │ │  WA)    │ │  + repos)  │                  │
│     └──────────────┘ └─────────┘ └────────────┘                  │
└─────────────────────────────────────────────────────────────────────┘
       │          │          │          │          │
       ▼          ▼          ▼          ▼          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         MCP TOOLS                                   │
│  Superpilot MCP  ·  Gmail  ·  GCal  ·  GDrive  ·  GitHub  ·  Web │
└─────────────────────────────────────────────────────────────────────┘
```

**Relationship between systems:**

| System | Role |
|--------|------|
| **NanoClaw** | Orchestration + intelligence. Decides what to do, when, and how. The brain. |
| **Superpilot** | Email pipeline + knowledge base. Triages email, stores/retrieves knowledge. The filing cabinet. |
| **Superpilot MCP** | Wrapper around superpilot's FastAPI + new endpoints for NanoClaw-specific needs. |

NanoClaw does NOT replace superpilot. Superpilot continues doing what it's good at (email classification, KB-grounded drafting, Gmail Push). NanoClaw adds the action/automation/cross-channel intelligence layer on top.

**Deployment assumption:** Both systems run on the same macOS host (localhost). This enables IPC-based push, localhost-only auth, and shared filesystem.

**Gmail channel:** NanoClaw's native Gmail channel (`src/channels/gmail.ts`) stays **disabled**. All email flows through superpilot exclusively.

---

## 2. Intelligence Loop

### Trigger Model: IPC-push + Discord events + poll-fallback

NanoClaw has no HTTP server and adding one contradicts its "minimal glue code" philosophy. Instead, superpilot pushes events by writing to NanoClaw's existing IPC directory, which the IPC watcher already monitors.

```
Superpilot triage complete → writes JSON to NanoClaw IPC dir → IPC watcher triggers agent
Discord.js event (mention/DM) → immediate trigger
                                              ↓
                              Poll every 30min → catchall sweep + housekeeping
```

- **Email push via IPC:** After superpilot triages an email, it writes a small JSON file to NanoClaw's IPC directory (e.g., `ipc/email-{timestamp}.json`). NanoClaw's existing IPC watcher picks it up and spawns an agent session. Latency: ~1-5 seconds.
- **Discord push:** Discord.js is already event-driven. Mentions, DMs, and watched channel activity trigger immediately.
- **Smart batching:** If multiple IPC files arrive within 30 seconds, the IPC watcher buffers them into one agent session that handles everything holistically.
- **Poll fallback:** Every 30 minutes, sweep for anything push missed. Also handles follow-ups, commitments due, and periodic housekeeping.

### Agent Session: 5-Phase Cycle

Each trigger spawns a full container agent session with all MCP tools. **Session budget: 15 minutes** (increased from initial 10 to account for research phases).

**Priority ordering within session:** Escalations first, then proposals, then auto-handled items. If session nears timeout (12 min mark), save progress and defer remaining items to next cycle.

**Phase 1 — Gather**
- Pull triaged emails from superpilot MCP (`get_triaged_emails`)
- Check Discord for mentions, DMs, activity in watched channels
- Load pending approvals (proposals awaiting your response)
- Check follow-ups and commitments due

**Phase 2 — Reason**
- Cross-reference: email from X + Discord message from X = same topic
- Prioritize by urgency, relationship importance, deadline proximity
- Search KB for context (`search_kb`)
- Classify each item into action tier: AUTO, PROPOSE, or ESCALATE

**Phase 3 — Act**
- **AUTO:** Create calendar events, archive emails, file documents, update KB, log to project repos
- **PROPOSE:** Draft replies, prepare research summaries, stage GitHub issues — hold for approval
- **ESCALATE:** Compose escalation message with context and suggested action — send immediately

**Phase 4 — Research** (when needed)
- Multi-step web browsing for context
- Read documents, check GitHub repos, search KB
- Synthesize findings into actionable summaries
- Store research results in KB for future retrieval

**Phase 5 — Report & Learn**
- Send proactive messages (batched summary, proposals, escalations)
- Update CLAUDE.md with new behavioral insights
- Store findings in superpilot KB
- Update project docs in `~/dev/*` when relevant

### Idempotency

**Source of truth for "has this email been processed":** NanoClaw's SQLite database. Each processed email/event gets a row in a `processed_items` table with `(item_id, source, processed_at, action_taken)`. The agent checks this table in Phase 1 before acting. The 30-minute poll sweep uses the same table to avoid double-processing.

---

## 3. Autonomy & Trust System

### Three Tiers

| Tier | What happens | Examples |
|------|-------------|----------|
| **AUTO** | Acts silently. Reports in digest only. | Calendar events from explicit dates, archiving newsletters, filing attachments, KB storage, read receipts |
| **PROPOSE** | Proposes action, waits for approval on Telegram. | Draft email replies, GitHub issues, research next steps, messages on your behalf, document updates |
| **ESCALATE** | Needs your direct judgment. Sent immediately. | Money/legal/contracts, VIP contacts, novel situations, confidence <80%, anything ambiguous |

### Trust Graduation

- **Promotion:** 5 consecutive approvals of the same action type without edits → NanoClaw asks: "I've auto-handled 5 meeting request replies successfully. Graduate to AUTO?"
- **Demotion:** 1 rejection or significant edit → immediate demotion back to PROPOSE
- **Initial state:** Everything starts at PROPOSE (approval-first to build trust)

### Storage

Trust rules live in the main group's CLAUDE.md as explicit, human-readable rules:

```markdown
## Autonomy Rules

### AUTO (no approval needed)
- Calendar events from explicit dates in emails
- Archive newsletters and marketing emails
- File attachments to KB
- Update contact profiles from email signatures

### PROPOSE (approval required)
- Reply to any email
- Create GitHub issues
- Post in Discord channels
- Schedule meetings
- Research tasks >5 min

### ESCALATE (always escalate)
- Anything involving money >$500
- Legal documents or contracts
- VIP contacts: [list]
- Novel situations not covered by rules
```

---

## 4. Superpilot MCP Server

### Scope Reality Check

Superpilot was built for a Chrome extension user, not an automation client. Some MCP tools map cleanly to existing endpoints; others require **new superpilot-side work**. The table below is honest about what exists vs. what must be built.

### Tool Catalog

**Email Intelligence:**

| Tool | Existing SP Endpoint | New Work Needed |
|------|---------------------|-----------------|
| `get_email_thread(thread_id)` | `POST /understand` → full thread understanding | MCP wrapper only (~20 lines) |
| `get_thread_summary(thread_id)` | `POST /email-intelligence/summarize` (deprecated but functional) | MCP wrapper only |
| `get_thread_actions(thread_id, messages)` | `POST /email-intelligence/actions` (per-thread, requires subject+messages) | MCP wrapper + message fetching shim |
| `get_awaiting_reply()` | `GET /inbox/awaiting-reply` | MCP wrapper only |
| `classify_email(email_id)` | `GET /email-category/vnext/{email_id}` | MCP wrapper only |
| `generate_reply(thread_id, ...)` | `POST /email-intelligence/hybrid-reply` (KB-grounded) | MCP wrapper only |
| `create_draft(to, subject, body, account)` | `POST /drafts` | MCP wrapper only |

**Knowledge Base:**

| Tool | Existing SP Endpoint | New Work Needed |
|------|---------------------|-----------------|
| `search_kb(query, tags?)` | KB uses ChromaDB hybrid search internally, but **no search API endpoint exposed** | **New endpoint: `GET /kb/search?q=...&tags=...`** (~50 lines) |
| `upload_to_kb(content, title, tags)` | `POST /kb/text` (upload text document) | MCP wrapper only |
| `upload_file_to_kb(file_path, title, tags)` | `POST /kb/upload` (upload file) | MCP wrapper only |
| `list_kb_documents(tags?, limit?)` | `GET /kb` (document list) | MCP wrapper only |

**NanoClaw Integration (all new):**

| Tool | New Work Needed |
|------|-----------------|
| `get_triaged_emails(since, account?)` | **New SP endpoint** (~100 lines): query email_classifications + understand cache, return batch of triaged emails since timestamp. New DB query joining classifications + threads. |
| `mark_processed(item_ids)` | **NanoClaw-side only** — writes to NanoClaw's `processed_items` SQLite table, not superpilot. |

### Effort Estimate

| Component | Lines | Where |
|-----------|-------|-------|
| MCP server framework + 8 wrapper tools | ~300 | New Python sidecar |
| `search_kb` endpoint in superpilot | ~50 | Superpilot backend |
| `get_triaged_emails` endpoint in superpilot | ~100 | Superpilot backend |
| IPC writer (superpilot → NanoClaw) | ~30 | Superpilot backend |
| **Total** | **~480 lines across 2 codebases** | |

### Auth: Localhost Service Token

Superpilot uses per-user JWT auth. For NanoClaw (same-host automation), add a **localhost service token**:

- Superpilot checks `X-Service-Token` header against a shared secret stored in OneCLI vault (`SUPERPILOT_SERVICE_TOKEN`)
- Only accepted from `127.0.0.1` / `::1` origin
- Bypasses JWT user auth, resolves to Jonathan's user record
- ~20 lines in superpilot's auth middleware

### Container Networking

Superpilot MCP runs on host at a fixed port (e.g., `localhost:8100`). Container agents reach it via `--add-host=host.docker.internal:host-gateway` (already used for OneCLI). Add `SUPERPILOT_MCP_URL=http://host.docker.internal:8100` to container env vars in `container-runner.ts`.

---

## 5. Knowledge Architecture

### Three Layers

**Layer 1 — CLAUDE.md (the brain)**
- Autonomy rules and trust tiers
- Contact profiles (2-3 lines each: name, company, role, tone, handling rules)
- Email patterns ("meeting requests from X → auto-calendar")
- Channel preferences, communication style, account routing
- Known projects registry mapping people → `~/dev/*` repos
- **Budget:** ~500 lines max. Overflows to KB.

**Layer 2 — Superpilot KB (the filing cabinet)**
- Email thread summaries, research findings, company profiles
- Documents, templates, meeting notes
- Tagged by project, contact, topic
- Searchable via `search_kb()`, writable via `upload_to_kb()`
- **Budget:** 50 entries per project max

**Layer 3 — Project Repos (`~/dev/*`)**
- Actual codebases with their own docs
- Agent reads/updates docs directly via filesystem access (mount project dirs into container)
- Code changes go through GitHub PRs/issues (auditable)
- NanoClaw's CLAUDE.md has a project registry mapping people/topics → repos

### Decision Tree: What Goes Where

| What happened | Where it goes |
|--------------|---------------|
| New behavior learned (how you handle things) | CLAUDE.md |
| Important email thread summary | Superpilot KB (tagged by project) |
| Research findings that took effort | Superpilot KB |
| Project decision from email | Project docs in `~/dev/*` + KB |
| Code change needed | GitHub issue or PR |
| Contact profile update | CLAUDE.md (2-3 lines) |
| Routine email handled | **Store nothing** |
| Newsletter/notification archived | **Store nothing** |

### Storage Discipline

**Storage gate — three questions before storing anything:**
1. **Will I need this again?** If probably not, don't store it.
2. **Can I find this elsewhere?** If it's in the email thread, a repo, or googleable — don't duplicate. Store a pointer.
3. **Is this signal or noise?** "Deal closes April 30" = signal. "Thanks for the update!" = noise.

**What NOT to store:**
- Pleasantries, acknowledgments, routine scheduling
- Information already in project repos
- Googleable facts
- One-and-done interactions

### Long-Term Memory Health

**Decay by default:**

| Entry type | TTL | Reset on retrieval? |
|-----------|-----|-------------------|
| Email thread summaries | 30 days | Yes |
| Research findings | 90 days | Yes |
| Project decisions | 180 days | Yes |
| Company profiles | 1 year | Yes |
| Contact profiles (CLAUDE.md) | Evergreen | N/A |

Unretrieved entries after TTL → archived to cold storage (not deleted).

**Implementation:** Each KB document gets a `nanoclaw_ttl_days` and `nanoclaw_last_retrieved` field in its metadata. The weekly housekeeping task queries documents where `now - last_retrieved > ttl_days` and archives them. Retrieval resets `last_retrieved`. Requires a small metadata schema addition to superpilot's KB document model.

**Consolidation over accumulation:**
- 15 email summaries about product-center → 1 updated project narrative
- Weekly housekeeping task consolidates, doesn't just accumulate
- Like sleep for memory — compress raw events into understanding

**Retrieval-driven quality:**
- Track which KB entries get retrieved and used
- Low-retrieval entries get pruned during housekeeping
- High-retrieval entries get boosted

**Storage budgets (hard caps):**

| Store | Budget |
|-------|--------|
| CLAUDE.md | ~500 lines |
| KB entries per project | 50 |
| Active contact profiles | 30 |

At limit → must consolidate or prune before adding more.

**Weekly housekeeping task:**
1. Expire entries past TTL with no recent retrieval
2. Consolidate multiple entries on same topic → single richer entry
3. Check storage budgets, prune if over
4. Review retrieval stats, flag unused entries
5. Generate brief report of knowledge state

---

## 6. Proactive Messaging & Escalation

### Message Types

| Type | When | Urgency |
|------|------|---------|
| **Batched summary** | Per cycle (after processing batch) | Normal |
| **Approval request** | When PROPOSE action is ready | Normal |
| **Escalation alert** | Immediately when detected | High |
| **Discord activity alert** | When mentioned or action item detected | Normal |
| **Research results** | When research task completes | Normal |

### Channel Routing

Default: **Telegram** for all proactive messages. Configurable per message type in CLAUDE.md.

### Timing & Throttling

- **Escalations:** Immediately, always (can't silence)
- **Proposals:** Batched per cycle
- **Digests:** Included in morning briefing or daily summary
- **Quiet hours (11pm-7am CST):** Batch everything except escalations
- **Smart throttling:** >5 messages/hour → auto-batch into one summary

### Approval Flow

Natural language responses on Telegram:
- `approve` / `yes` / `send it` → execute proposed action
- `edit: make it more casual` → revise and re-propose
- `skip` / `ignore` → don't act, no demotion
- `on it` → you're handling it yourself, agent stands down
- `details` / `more context` → agent provides additional info

### Notification Intensity

```markdown
## Notification Intensity
Default: normal

Overrides:
- Morning briefing: always on
- Auto-handled emails: silent (only in weekly review)
- Proposals: normal (batched per cycle)
- Escalations: always on (can't silence)
- Meeting prep: digest (include in morning briefing, not separate)
- Commitment reminders: normal
- Research results: normal
- Relationship pulse: digest (weekly only)
- Discord alerts: normal for mentions, silent for watched channels
```

**Intensity levels:**
- **Silent** — auto-handle, report in weekly review only
- **Digest** — batch into morning briefing or daily summary
- **Normal** — batched summaries per cycle, individual escalations
- **Verbose** — every action reported individually (for initial trust-building)

**Trajectory:** Start at Verbose → dial down to Normal → Digest as autonomy grows.

---

## 7. Value-Add Features

### 7.1 Morning Briefing (daily, 7:30 AM)

Unifies the existing Discord digest feature with email and calendar intelligence into one morning message.

```
Good morning — here's your Thursday briefing:

CALENDAR: 3 meetings today
  - 10:00 — Product sync (5 attendees, prep below)
  - 14:00 — 1:1 with Sarah
  - 16:30 — Attaxion standup

EMAILS NEEDING RESPONSE: 2
  - [whoisxml] Mike re: Q2 pricing — waiting since yesterday
  - [attaxion] Customer escalation — flagged urgent

COMMITMENTS DUE:
  - Send revised proposal to David (promised by EOD)
  - Review PR #142 (overdue 2 days)

DISCORD OVERNIGHT:
  - #product: 12 messages, 1 mentions you (pricing thread)
  - #engineering: deploy completed, no issues

MEETING PREP — Product sync (10:00):
  - Last emails with attendees: pricing discussion, feature request from Corp X
  - Open action items: finalize roadmap slide, confirm demo environment
  - KB context: Corp X evaluation notes from March
```

### 7.2 Commitment Tracking

Detects commitments in both directions:

- **Your commitments:** "I'll send that over by Friday" → tracked, reminded before deadline
- **Others' commitments:** "Mike will have specs ready Monday" → if no delivery by Tuesday, agent drafts a gentle follow-up for your approval

### 7.3 Meeting Prep Packets (15 min before event)

```
Prep — 1:1 with Sarah (in 15 min):
  - Last email: discussed hiring timeline (3 days ago)
  - Open items: she owes you the JD draft
  - KB: Sarah prefers async decisions, confirmation by email
  - Relationship: last 1:1 was 2 weeks ago, monthly cadence
```

### 7.4 Relationship Pulse (weekly)

```
Relationship check-in:
  - Haven't heard from David in 3 weeks (usually bi-weekly)
  - Sarah's been responsive but you owe her a reply from April 2
  - New contact: Alex from Corp Y — 4 emails this week, consider adding to contacts
```

### 7.5 Cross-Channel Correlation

Same topic across email + Discord + calendar → unified view.

**Implementation approach:** Entity extraction on email subjects/bodies (superpilot's `POST /email-intelligence/entities`) + Discord message keyword matching + calendar event title matching. Match on: person names, company names, project names, and explicit topic phrases. This is heuristic-based in Phase 4, not ML — good enough for high-signal matches, won't catch subtle connections.

```
Connected threads — "Q2 pricing":
  - Email: Mike sent revised pricing doc (2 hours ago)
  - Discord: #product — team discussing pricing tiers (30 min ago)
  - Calendar: Pricing review meeting tomorrow 2 PM
  → Want me to pull the pricing doc into meeting prep?
```

### 7.6 Weekly Review (Friday, 5 PM)

```
Week in review:

Completed: 47 emails processed, 12 calendar events created,
  3 research tasks, 8 GitHub issues
Auto-handled: 31 (66%) — up from 45% last week
Open items: 4 commitments due next week
Knowledge: 6 new KB entries, 3 consolidated, 2 expired
Autonomy: graduated "meeting confirmations" to AUTO this week
Cost: ~$X.XX this week (N agent sessions)
```

### 7.7 Smart Scheduling

```
Meeting request detected:
  From: Alex (Corp Y) — wants to discuss integration

  Your availability this week:
  - Tue 2-3 PM
  - Wed 10-11 AM
  - Thu 3-4 PM

  Draft reply: "Hi Alex, I'm available [times].
  Would any of these work for a 30-min call?"

  → Approve / Edit / Pick specific slot
```

### Calendar Ownership

| Calendar operation | Owner | Why |
|-------------------|-------|-----|
| Extract date from email → create event | Superpilot | Happens during email triage |
| Check availability for scheduling reply | NanoClaw | Requires reasoning |
| Morning briefing with calendar preview | NanoClaw | Cross-domain orchestration |
| Meeting prep packets | NanoClaw | Needs KB + email + calendar |
| Find mutual availability | NanoClaw | Back-and-forth reasoning |

---

## 8. Operational Concerns

### Cost Model

Each agent session uses Claude API tokens. Estimated costs:

| Trigger | Frequency | Est. cost/session | Daily cost |
|---------|-----------|-------------------|------------|
| Email push (batched) | ~10-20/day | $0.50-1.50 | $5-30 |
| Discord events | ~5-10/day | $0.30-0.80 | $1.50-8 |
| Poll sweep | 48/day (every 30m) | $0.10-0.30 | $5-15 |
| Scheduled tasks (briefing, review) | 3-5/day | $0.50-1.00 | $1.50-5 |
| **Total estimate** | | | **$13-58/day** |

**Cost controls:**
- Poll sweep should be lightweight (check `processed_items`, only spawn full session if unprocessed items found)
- Batching reduces sessions: 20 emails in 5 batched sessions, not 20 individual sessions
- Track cost in weekly review for visibility
- Set a daily budget ceiling (configurable, default $50) — if exceeded, switch to poll-only mode

### Superpilot-Down Fallback

If superpilot is unreachable:
- Agent skips email intelligence phases (no crash, no retry loop)
- Discord monitoring, calendar, and scheduled tasks continue normally
- Agent logs "superpilot unreachable" and includes it in next summary
- Retry on next cycle — no exponential backoff needed (cycles are already 30min apart)
- If down >2 hours, send one-time Telegram alert: "Superpilot has been unreachable for 2 hours — email processing paused"

### Kill Switch

Add to `src/config.ts`:
```typescript
EMAIL_INTELLIGENCE_ENABLED: boolean  // default true, set false to disable entirely
```

When disabled: no IPC processing for email events, no superpilot MCP calls, scheduled tasks (briefing, review) skip email sections. Discord and other channels continue normally.

### Discord Monitoring Scope

Configured subset of servers/channels in CLAUDE.md:

```markdown
## Discord Monitoring
Servers:
  - WhoisXML API: #product, #engineering, #general (mentions + action items)
  - Attaxion: #dev, #incidents (mentions only)

Watch mode:
  - mentions: alert when @Jonathan or keywords match
  - action-items: detect tasks aimed at you even without @mention
  - silent: include in daily digest only
```

---

## 9. Account Routing

Four Gmail accounts, routed via superpilot MCP:

| Alias | Email | Context |
|-------|-------|---------|
| **personal** | topcoder1@gmail.com | Personal |
| **whoisxml** | jonathan.zhang@whoisxmlapi.com | Work — WhoisXML API |
| **attaxion** | jonathan@attaxion.com | Work — Attaxion |
| **dev** | dev@whoisxmlapi.com | Dev/engineering |

Agent labels all outputs with `[personal]`, `[whoisxml]`, `[attaxion]`, or `[dev]`. Never cross-references between accounts unless explicitly asked.

---

## 10. Project Registry

Maps people and topics to `~/dev/*` repos. Lives in CLAUDE.md:

```markdown
## Known Projects
- product-center: product KB, market research → ~/dev/product-center
  People: [relevant contacts]
- attaxion_dev: ASM product roadmap → ~/dev/attaxion_dev
  People: [relevant contacts]
- inbox_superpilot: email AI product → ~/dev/inbox_superpilot
  People: [relevant contacts]
- trustclawd: AI assistant product → ~/dev/trustclawd
  People: [relevant contacts]
```

When the agent processes an email and recognizes a person/topic from this registry, it knows which project repo to read/update.

---

## 11. Implementation Phases

### Phase 1: Foundation (Week 1-2)
**Scope: Both NanoClaw and superpilot codebases.**

NanoClaw side:
- Add `processed_items` table to SQLite schema
- Add IPC handler for email trigger files
- Create main group CLAUDE.md with autonomy rules, contact profiles, notification settings
- Wire up basic agent session: gather emails → classify → propose on Telegram
- Add `EMAIL_INTELLIGENCE_ENABLED` kill switch

Superpilot side:
- Build `GET /kb/search` endpoint (~50 lines)
- Build `GET /api/triaged-emails?since=...&account=...` endpoint (~100 lines)
- Add IPC writer: after triage → write JSON to NanoClaw IPC dir (~30 lines)
- Add localhost service token auth (~20 lines)

MCP server:
- Build superpilot MCP server with initial 6 tools (~300 lines Python)
- Configure container networking (`SUPERPILOT_MCP_URL` env var)

### Phase 2: Autonomy Engine (Week 3-4)
- Implement trust tiers (AUTO/PROPOSE/ESCALATE) with graduation logic
- Build approval flow on Telegram (natural language parsing)
- Add storage discipline to agent instructions
- Implement basic KB read/write cycle
- Add remaining MCP tools (full 12-tool catalog)

### Phase 3: Value Features (Week 5-6)
- Morning briefing scheduled task (unify with existing Discord digest)
- Commitment tracking (detect + remind)
- Meeting prep packets
- Weekly review (including cost tracking)

### Phase 4: Deep Intelligence (Week 7-8)
- Cross-channel correlation (entity-based matching across email + Discord + calendar)
- Relationship pulse tracking
- Smart scheduling
- Knowledge consolidation and housekeeping task
- Notification intensity tuning

### Phase 5: Maturation (Ongoing)
- Trust tier graduation based on real usage
- Dial notification intensity from Verbose → Normal → Digest
- KB quality improvements from retrieval tracking
- Expand to more action domains as patterns emerge
- Cost optimization based on usage patterns

---

## Appendix A: Resolved Design Questions

| # | Question | Decision | Rationale |
|---|----------|----------|-----------|
| 1 | Superpilot MCP auth | Localhost service token via OneCLI vault | Both systems on same host; JWT is overkill for machine-to-machine |
| 2 | Container → project repos | Mount project dirs into container | Same approach as existing group folder mounts |
| 3 | Discord monitoring scope | Configured subset in CLAUDE.md | Not all servers/channels are relevant |
| 4 | Quiet hours | 11pm-7am CST | Jonathan's timezone |
| 5 | Push mechanism | IPC file-based (not HTTP) | NanoClaw has no HTTP server; IPC watcher already exists |
| 6 | Source of truth for processed items | NanoClaw SQLite `processed_items` table | NanoClaw owns the orchestration state |
| 7 | Session timeout | 15 min with priority ordering | 10 min too tight for research; graceful degradation at 12 min mark |
| 8 | Morning briefing vs Discord digest | Unified — Discord digest becomes a section of morning briefing | One message, not two |

## Appendix B: Open Items (non-blocking)

1. **Initial VIP list:** Which contacts should start in ESCALATE tier? (Populate during Phase 1 setup)
2. **Project registry population:** Fill in people → project mappings during Phase 1
3. **Superpilot KB metadata schema:** Add `nanoclaw_ttl_days` and `nanoclaw_last_retrieved` fields (needed for Phase 4 housekeeping, not Phase 1)
