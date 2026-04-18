# Email Intelligence — Full Implementation Plan (Phases 1b–5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the email intelligence system from Phase 1 foundation through Phase 5 maturation — wiring stubs to real data, building the autonomy engine, value features, deep intelligence, and operational maturity.

**Architecture:** NanoClaw (brain) ↔ Superpilot MCP (6 tools) ↔ Superpilot FastAPI (email pipeline + KB). Phase 1 foundation is already built (10 commits across both repos). This plan covers everything remaining.

**Tech Stack:** Python 3.11+ (superpilot), Node.js/TypeScript (NanoClaw), SQLite (NanoClaw state), PostgreSQL + ChromaDB (superpilot), Celery (superpilot async tasks)

**Spec:** [`docs/EMAIL-INTELLIGENCE-SPEC.md`](../EMAIL-INTELLIGENCE-SPEC.md)
**Phase 1 Plan:** [`2026-04-10-email-intelligence-phase1.md`](./2026-04-10-email-intelligence-phase1.md)

**What's already built (Phase 1):**
- NanoClaw: `EMAIL_INTELLIGENCE_ENABLED` kill switch, `processed_items` table, `email_trigger` IPC handler, CLAUDE.md with autonomy rules, `SUPERPILOT_MCP_URL` in container runner
- Superpilot: service token auth, bridge API stubs, IPC writer module, MCP server (6 tools)

---

## Phase 1b: Wire Stubs to Real Data

### Task 1: Wire `get_triaged_emails` to Real DB

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py`

The stub currently returns empty. Wire it to query the `email_classifications` table.

- [ ] **Step 1: Read the classification model**

Read `~/dev/inbox_superpilot/backend/app/models/email_classification.py` to understand the ORM model. Key fields: `email_id`, `user_id`, `email_type`, `needs_reply`, `needs_action`, `priority_tags`, `classified_at`, `primary_intent`.

- [ ] **Step 2: Implement the query in nanoclaw_bridge.py**

Replace the stub `get_triaged_emails` endpoint with a real query:

```python
from app.models.email_classification import EmailClassification
from datetime import datetime

@router.get("/triaged-emails", response_model=TriagedEmailsResponse)
async def get_triaged_emails(
    since: str = Query(..., description="ISO timestamp"),
    account: str | None = Query(None, description="Filter by account alias"),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    since_dt = datetime.fromisoformat(since.replace("Z", "+00:00"))
    query = db.query(EmailClassification).filter(
        EmailClassification.user_id == current_user.id,
        EmailClassification.classified_at >= since_dt,
    )
    if account:
        # Account filtering requires joining with gmail account config
        # For now filter by email_id prefix pattern if accounts are tagged
        pass
    rows = query.order_by(EmailClassification.classified_at.desc()).limit(50).all()

    emails = []
    for row in rows:
        emails.append(TriagedEmail(
            thread_id=row.email_id,
            account=account or "unknown",
            subject=getattr(row, "subject", ""),
            sender=getattr(row, "sender_email", ""),
            sender_email=getattr(row, "sender_email", ""),
            received_at=row.classified_at.isoformat() if row.classified_at else "",
            email_type=row.email_type.value if row.email_type else None,
            priority=None,  # Derive from priority_tags if needed
            needs_reply=bool(row.needs_reply),
            suggested_action=row.primary_intent.value if row.primary_intent else None,
            action_items=[],  # Populated from understanding cache in Phase 2
        ))
    return TriagedEmailsResponse(emails=emails, count=len(emails))
```

Adapt field names to match the actual model — the above is a template. Read the model first.

- [ ] **Step 3: Test manually**

```bash
cd ~/dev/inbox_superpilot/backend
# Start the server, then:
curl -H "x-service-token: $NANOCLAW_SERVICE_TOKEN" \
  "http://localhost:8000/api/nanoclaw/triaged-emails?since=2026-04-01T00:00:00Z"
```

Expected: JSON with real classified emails (or empty if none classified recently).

- [ ] **Step 4: Commit**

```bash
cd ~/dev/inbox_superpilot
git add backend/app/api/nanoclaw_bridge.py
git commit -m "feat: wire get_triaged_emails to real email_classifications table"
```

---

### Task 2: Wire `kb/search` to Real ChromaDB Search

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py`

- [ ] **Step 1: Read the RAG search service**

Read `~/dev/inbox_superpilot/backend/app/services/rag.py` — the `search_kb()` function. Signature:
```python
async def search_kb(user_id, query, db, top_k=5, min_score=0.3, use_hybrid=True) -> list[dict]
```

- [ ] **Step 2: Wire the search endpoint**

Replace the stub `search_kb` endpoint:

```python
from app.services.rag import search_kb as rag_search_kb

@router.get("/kb/search", response_model=KBSearchResponse)
async def search_kb(
    q: str = Query(...),
    tags: str | None = Query(None),
    limit: int = Query(10, ge=1, le=50),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    raw_results = await rag_search_kb(
        user_id=current_user.id,
        query=q,
        db=db,
        top_k=limit,
    )
    results = [
        KBSearchResult(
            document_id=r.get("document_id", ""),
            title=r.get("title", ""),
            content_preview=r.get("content", "")[:500],
            relevance_score=r.get("score", 0.0),
            tags=r.get("tags", []) if isinstance(r.get("tags"), list) else [],
        )
        for r in raw_results
    ]
    return KBSearchResponse(results=results, query=q, count=len(results))
```

Adapt to actual return format from `rag_search_kb` — read the function to see what dict keys it returns.

- [ ] **Step 3: Test manually**

```bash
curl -H "x-service-token: $NANOCLAW_SERVICE_TOKEN" \
  "http://localhost:8000/api/nanoclaw/kb/search?q=pricing&limit=5"
```

- [ ] **Step 4: Commit**

```bash
git add backend/app/api/nanoclaw_bridge.py
git commit -m "feat: wire kb/search to ChromaDB hybrid search"
```

---

### Task 3: Hook IPC Writer into Gmail Push Pipeline

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/celery_app/tasks.py`

- [ ] **Step 1: Read the Gmail push processing flow**

Read `~/dev/inbox_superpilot/backend/app/celery_app/tasks.py` around line 3608 — the `_process_gmail_push_async` function. This is where new emails are fetched and processed after a push notification.

Find the point after triage/classification completes — that's where we insert the IPC writer call.

- [ ] **Step 2: Add IPC trigger after classification**

After the email is classified (look for where `EmailClassification` is created/saved), add:

```python
from app.services.ipc_writer import write_email_trigger

# After classification is saved to DB:
write_email_trigger([{
    "thread_id": email_id,
    "account": account_alias,  # derive from the Gmail account
    "subject": subject,
    "sender": sender_email,
}])
```

The exact variable names depend on what's available in scope. Read the function to find them.

**Important:** This should be best-effort (try/except with logging) — a failed IPC write should never break the email processing pipeline.

```python
try:
    write_email_trigger([{...}])
except Exception as e:
    logger.warning(f"NanoClaw IPC trigger failed (non-fatal): {e}")
```

- [ ] **Step 3: Test by sending yourself an email**

Send a test email to one of your Gmail accounts. Check:
1. Superpilot receives the push notification
2. Email gets classified
3. IPC file appears in `~/dev/nanoclaw/data/ipc/main/tasks/`

- [ ] **Step 4: Commit**

```bash
git add backend/app/celery_app/tasks.py
git commit -m "feat: trigger NanoClaw IPC after email classification"
```

---

### Task 4: Generate and Store Service Token

- [ ] **Step 1: Generate token**

```bash
cd ~/dev/wxa-secrets
uv run python -m wxa_secrets set NANOCLAW_SERVICE_TOKEN "$(openssl rand -hex 32)"
```

- [ ] **Step 2: Add to superpilot env**

```bash
# Get the token value
cd ~/dev/wxa-secrets && uv run python -m wxa_secrets get NANOCLAW_SERVICE_TOKEN

# Add to ~/dev/inbox_superpilot/backend/.env:
# NANOCLAW_SERVICE_TOKEN=<value>
# NANOCLAW_SERVICE_USER=topcoder1@gmail.com
```

- [ ] **Step 3: Add to NanoClaw env (for MCP server)**

```bash
# Add to ~/dev/nanoclaw/.env:
# NANOCLAW_SERVICE_TOKEN=<same value>
```

- [ ] **Step 4: Verify auth works**

```bash
TOKEN=$(cd ~/dev/wxa-secrets && uv run python -m wxa_secrets get NANOCLAW_SERVICE_TOKEN)
curl -H "x-service-token: $TOKEN" http://localhost:8000/api/nanoclaw/triaged-emails?since=2026-01-01T00:00:00Z
```

Expected: 200 OK with JSON response (not 401).

---

### Task 5: Populate CLAUDE.md — VIP List + Project Registry

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

- [ ] **Step 1: Add VIP escalation contacts**

In the ESCALATE section of the autonomy rules, populate the VIP contacts list. Ask Jonathan which contacts should always be escalated.

- [ ] **Step 2: Add project registry**

Append the Known Projects section with people → repo mappings:

```markdown
## Known Projects
- product-center: product KB, market research → ~/dev/product-center
- attaxion_dev: ASM product roadmap → ~/dev/attaxion_dev
- inbox_superpilot: email AI product → ~/dev/inbox_superpilot
- trustclawd: AI assistant product → ~/dev/trustclawd
- wxa-jake-ai: WXA AI chat → ~/dev/wxa-jake-ai
- netflow_core: network flow analysis → ~/dev/netflow_core
```

- [ ] **Step 3: Commit**

```bash
cd ~/dev/nanoclaw
git add groups/main/CLAUDE.md
git commit -m "feat: populate VIP contacts and project registry in CLAUDE.md"
```

---

### Task 6: End-to-End Integration Test

- [ ] **Step 1: Start both systems**

```bash
# Terminal 1: NanoClaw
cd ~/dev/nanoclaw && npm run dev

# Terminal 2: Superpilot backend
cd ~/dev/inbox_superpilot/backend && uvicorn app.main:app --reload

# Terminal 3: Superpilot MCP server (optional for this test)
cd ~/dev/inbox_superpilot/mcp_server && uv run python server.py
```

- [ ] **Step 2: Write a manual IPC trigger**

```bash
mkdir -p ~/dev/nanoclaw/data/ipc/main/tasks
cat > ~/dev/nanoclaw/data/ipc/main/tasks/test_$(date +%s).json << 'EOF'
{
  "type": "email_trigger",
  "emails": [{
    "thread_id": "test_thread_001",
    "account": "personal",
    "subject": "Test: Q2 pricing update",
    "sender": "mike@example.com"
  }]
}
EOF
```

- [ ] **Step 3: Verify the pipeline**

Check NanoClaw logs for:
- `Email trigger dispatched to main group`
- Container agent spawns
- Agent reads email intelligence instructions
- Agent calls superpilot MCP tools (or logs errors if MCP not reachable)
- Agent sends proposal to Telegram

- [ ] **Step 4: Test kill switch**

Set `EMAIL_INTELLIGENCE_ENABLED=false` in `.env`, restart, write another trigger. Verify: `Email intelligence disabled, skipping trigger` in logs.

- [ ] **Step 5: Test idempotency**

Write the same trigger again. Agent should check `processed_items` and skip.

---

## Phase 2: Autonomy Engine

### Task 7: Trust Graduation Logic

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`
- Modify: `~/dev/nanoclaw/src/db.ts`

The graduation logic lives in the agent's instructions (CLAUDE.md) + a tracking table in SQLite.

- [ ] **Step 1: Add approval_log table to db.ts**

```sql
CREATE TABLE IF NOT EXISTS approval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_type TEXT NOT NULL,
  action_detail TEXT,
  outcome TEXT NOT NULL,  -- 'approved', 'approved_with_edits', 'rejected', 'skipped'
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approval_type ON approval_log(action_type, timestamp);
```

- [ ] **Step 2: Add CRUD functions**

```typescript
export function logApproval(actionType: string, actionDetail: string, outcome: string): void {
  db.prepare(
    'INSERT INTO approval_log (action_type, action_detail, outcome, timestamp) VALUES (?, ?, ?, ?)',
  ).run(actionType, actionDetail, outcome, new Date().toISOString());
}

export function getRecentApprovals(actionType: string, limit: number = 5): Array<{outcome: string; timestamp: string}> {
  return db.prepare(
    'SELECT outcome, timestamp FROM approval_log WHERE action_type = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(actionType, limit) as Array<{outcome: string; timestamp: string}>;
}

export function getGraduationCandidates(): Array<{action_type: string; consecutive_approvals: number}> {
  // Returns action types with 5+ consecutive approvals without edits/rejections
  return db.prepare(`
    WITH ranked AS (
      SELECT action_type, outcome,
        ROW_NUMBER() OVER (PARTITION BY action_type ORDER BY timestamp DESC) as rn
      FROM approval_log
    ),
    streaks AS (
      SELECT action_type, COUNT(*) as consecutive_approvals
      FROM ranked
      WHERE rn <= 5 AND outcome = 'approved'
      GROUP BY action_type
      HAVING COUNT(*) = 5
    )
    SELECT * FROM streaks
  `).all() as Array<{action_type: string; consecutive_approvals: number}>;
}
```

- [ ] **Step 3: Add graduation instructions to CLAUDE.md**

Append to the Email Intelligence section:

```markdown
### Trust Graduation

After each approval/rejection, log it to the approval_log table via IPC.
After 5 consecutive approvals of the same action type without edits:
- Propose graduating that action type to AUTO
- Example: "I've successfully auto-handled 5 meeting request replies. Graduate to AUTO?"
- If approved, update the Autonomy Rules section above

After 1 rejection or significant edit:
- Demote that action type back to PROPOSE
- Log the reason
```

- [ ] **Step 4: Add tests for approval_log**

- [ ] **Step 5: Build, test, commit**

---

### Task 8: Telegram Approval Flow

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

This is primarily an instruction change — the agent already has `send_message` capability. The approval flow is conversational: agent proposes, user replies, agent interprets.

- [ ] **Step 1: Add approval flow instructions to CLAUDE.md**

```markdown
### Approval Flow

When proposing an action (PROPOSE tier), format it clearly on Telegram:

```
[whoisxml] Reply to Mike re: Q2 pricing

Draft:
"Hi Mike, thanks for the updated pricing. I've reviewed the numbers
and they look good. Let's proceed with Tier 2 for the enterprise plan."

→ approve | edit: [instructions] | skip | on it | details
```

Parse the user's Telegram response:
- "approve" / "yes" / "send it" / "go" / "ok" → execute the action
- "edit: make it shorter" → revise and re-propose
- "skip" / "ignore" / "no" → don't act, no trust demotion
- "on it" / "I'll handle it" → stand down, user handling it
- "details" / "more" / "context" → provide additional info

If the response doesn't match any pattern, ask for clarification.
After each outcome, log to approval_log via IPC.
```

- [ ] **Step 2: Commit**

```bash
git add groups/main/CLAUDE.md
git commit -m "feat: add approval flow + trust graduation instructions"
```

---

### Task 9: KB Read/Write Cycle

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

- [ ] **Step 1: Add KB usage instructions**

```markdown
### Using the Knowledge Base

**When to read KB (search_kb):**
- Before drafting any reply — search for context about the sender/company
- When processing a new contact — check if we have history
- When a project name is mentioned — search for related notes

**When to write KB (upload_to_kb):**
- After completing research — store findings with project tags
- After important email threads conclude — store a summary
- When learning new facts about a contact/company — store as a note

**Tag conventions:**
- `project:product-center` — project association
- `contact:mike@example.com` — contact association  
- `type:research` / `type:summary` / `type:decision` — content type
- `account:whoisxml` — which Gmail account
```

- [ ] **Step 2: Commit**

---

### Task 10: Expand MCP Tools to Full Catalog

**Files:**
- Modify: `~/dev/inbox_superpilot/mcp_server/server.py`

Add 4 more tools beyond the initial 6:

- [ ] **Step 1: Add `classify_email` tool**

```python
@mcp.tool()
async def classify_email(email_id: str) -> str:
    """Get the classification of a specific email (type, priority, intent)."""
    async with _client() as client:
        resp = await client.get(f"/api/email-category/vnext/{email_id}")
        resp.raise_for_status()
        return resp.text
```

- [ ] **Step 2: Add `get_contact_memory` tool**

```python
@mcp.tool()
async def get_contact_memory(contact_email: str) -> str:
    """Get stored memory/context about a specific contact."""
    async with _client() as client:
        resp = await client.get(f"/api/contacts/{contact_email}/memory")
        resp.raise_for_status()
        return resp.text
```

- [ ] **Step 3: Add `get_contact_voice_profile` tool**

```python
@mcp.tool()
async def get_contact_voice_profile(contact_email: str) -> str:
    """Get the learned voice/writing style profile for a contact."""
    async with _client() as client:
        resp = await client.get(f"/api/contacts/{contact_email}/voice-profile")
        resp.raise_for_status()
        return resp.text
```

- [ ] **Step 4: Add `list_kb_documents` tool**

```python
@mcp.tool()
async def list_kb_documents(limit: int = 20) -> str:
    """List documents in the knowledge base."""
    async with _client() as client:
        resp = await client.get("/api/kb", params={"limit": limit})
        resp.raise_for_status()
        return resp.text
```

- [ ] **Step 5: Verify all 10 tools load**

```bash
cd ~/dev/inbox_superpilot/mcp_server
uv run python -c "import server; print('Import OK')"
```

- [ ] **Step 6: Commit**

```bash
git add mcp_server/server.py
git commit -m "feat: expand superpilot MCP to 10 tools"
```

---

## Phase 3: Value Features

### Task 11: Morning Briefing Scheduled Task

**Files:**
- Create: `~/dev/nanoclaw/container/skills/morning-briefing/SKILL.md`
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md` (add briefing task creation instructions)

The morning briefing replaces the standalone Discord digest. It runs as a NanoClaw scheduled task at 7:30 AM CST.

- [ ] **Step 1: Create the morning briefing container skill**

Create `container/skills/morning-briefing/SKILL.md`:

```markdown
# Morning Briefing

Generate a comprehensive morning briefing and send to Telegram.

## What to include

1. **Calendar today** — list all events, note upcoming meetings with prep hints
2. **Emails needing response** — use get_awaiting_reply() and get_triaged_emails(since=yesterday)
3. **Commitments due** — search KB for commitment-related entries due today/this week
4. **Discord overnight** — summarize Discord activity since last briefing
5. **Meeting prep** — for the first meeting today, pull attendee email history + KB context

## Format

Send via send_message to Telegram. Keep it scannable:
- Section headers with counts
- Bullet points, not paragraphs
- Most urgent items first within each section
- Total length: aim for under 50 lines
```

- [ ] **Step 2: Add scheduled task creation to CLAUDE.md**

Add instructions for setting up the briefing task:

```markdown
### Morning Briefing

Schedule a daily briefing task:
- schedule_type: cron
- schedule_value: "30 7 * * *"  (7:30 AM CST)
- prompt: "Run the morning-briefing skill. Send results to Telegram."
- context_mode: group (access to CLAUDE.md and KB tools)
```

- [ ] **Step 3: Migrate existing Discord digest into the briefing**

The existing `scripts/discord-digest.py` runs standalone via launchd. Options:
- Keep it as a data source the agent calls during briefing (simpler)
- Rewrite as a container skill the agent executes inline

Recommended: Keep the Python script, have the agent exec it during briefing and include its output.

Add to the skill:
```markdown
## Discord Digest

Run the existing Discord digest script and include its output:
```bash
python3 /workspace/project/scripts/discord-digest.py --output-only
```
```

- [ ] **Step 4: Commit**

```bash
git add container/skills/morning-briefing/
git add groups/main/CLAUDE.md
git commit -m "feat: add morning briefing scheduled task skill"
```

---

### Task 12: Commitment Tracking

**Files:**
- Modify: `~/dev/nanoclaw/src/db.ts` (commitments table)
- Modify: `~/dev/nanoclaw/src/types.ts`
- Create: `~/dev/nanoclaw/container/skills/commitment-tracker/SKILL.md`

- [ ] **Step 1: Add commitments table**

```sql
CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  direction TEXT NOT NULL,  -- 'mine' or 'theirs'
  person TEXT NOT NULL,
  person_email TEXT,
  due_date TEXT,
  source TEXT,             -- 'email:thread_123' or 'discord:msg_456'
  status TEXT DEFAULT 'open',  -- 'open', 'completed', 'overdue', 'cancelled'
  created_at TEXT NOT NULL,
  completed_at TEXT
);
```

- [ ] **Step 2: Add CRUD functions**

```typescript
export interface Commitment {
  id: string;
  description: string;
  direction: 'mine' | 'theirs';
  person: string;
  person_email: string | null;
  due_date: string | null;
  source: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

export function createCommitment(c: Omit<Commitment, 'completed_at'>): void { ... }
export function getOpenCommitments(): Commitment[] { ... }
export function getOverdueCommitments(): Commitment[] { ... }
export function completeCommitment(id: string): void { ... }
```

- [ ] **Step 3: Create commitment tracker skill**

```markdown
# Commitment Tracker

Detect and track commitments from emails and messages.

## Detection patterns

**Your commitments (direction: mine):**
- "I'll send that over by Friday"
- "I will follow up on Monday"
- "Let me get back to you on that"

**Their commitments (direction: theirs):**
- "Mike will have specs ready Monday"
- "She'll send the contract by EOW"

## Actions

When a commitment is detected:
1. Create it in the commitments table via IPC
2. If it has a due date, note it

When checking overdue commitments:
- Mine: remind me before the deadline
- Theirs: if 1 day overdue, draft a gentle follow-up for approval
```

- [ ] **Step 4: Tests, build, commit**

---

### Task 13: Meeting Prep Packets

**Files:**
- Create: `~/dev/nanoclaw/container/skills/meeting-prep/SKILL.md`

This runs as a scheduled task 15 minutes before each calendar event.

- [ ] **Step 1: Create the meeting prep skill**

```markdown
# Meeting Prep

Generate a preparation packet for an upcoming meeting.

## Trigger

Scheduled 15 min before calendar events with 2+ attendees.

## What to include

1. **Attendee context** — for each attendee, search KB + recent emails
2. **Open items** — commitments involving attendees
3. **Last interaction** — most recent email/message with each attendee
4. **KB context** — any relevant KB entries about the meeting topic
5. **Action items** — unresolved items from previous meetings with these people

## Format

Send via send_message. Keep under 30 lines.
```

- [ ] **Step 2: Add meeting prep task scheduling to CLAUDE.md**

The agent should check the calendar at 7:30 AM (during morning briefing) and schedule one-time tasks for each meeting:

```markdown
### Meeting Prep

During the morning briefing, check today's calendar. For each meeting with 2+ attendees:
- Schedule a one-time task 15 minutes before the meeting
- prompt: "Run meeting-prep skill for [event]. Attendees: [list]."
```

- [ ] **Step 3: Commit**

---

### Task 14: Weekly Review

**Files:**
- Create: `~/dev/nanoclaw/container/skills/weekly-review/SKILL.md`

- [ ] **Step 1: Create the weekly review skill**

```markdown
# Weekly Review

Generate a comprehensive week-in-review report. Runs Friday 5 PM.

## What to include

1. **Activity stats** — count processed_items by action_taken for the week
2. **Autonomy stats** — % auto-handled vs proposed vs escalated
3. **Open commitments** — what's due next week
4. **Knowledge stats** — KB entries added, consolidated, expired
5. **Graduation candidates** — action types ready for AUTO promotion
6. **Cost estimate** — count agent sessions this week, estimate cost

## Format

Send via send_message to Telegram.
```

- [ ] **Step 2: Schedule the task**

Add to CLAUDE.md:
```markdown
### Weekly Review
- schedule_type: cron
- schedule_value: "0 17 * * 5"  (Friday 5 PM CST)
- prompt: "Run weekly-review skill."
```

- [ ] **Step 3: Commit**

---

## Phase 4: Deep Intelligence

### Task 15: Cross-Channel Correlation

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`
- Modify: `~/dev/nanoclaw/container/skills/morning-briefing/SKILL.md`

This is instruction-driven — the agent uses existing tools (superpilot MCP + Discord data) to correlate.

- [ ] **Step 1: Add correlation instructions to CLAUDE.md**

```markdown
### Cross-Channel Correlation

When processing emails or Discord messages, look for connections:
- Same person mentioned across email + Discord + calendar
- Same topic/project discussed in multiple channels
- Email thread + Discord thread + calendar event about the same thing

When a correlation is found, present it as a unified thread:
"Connected threads — [topic]: [list sources]"

Implementation: Use entity matching on person names, company names, project names.
Match against the Known Projects registry for project detection.
```

- [ ] **Step 2: Update morning briefing to include correlations**

- [ ] **Step 3: Commit**

---

### Task 16: Relationship Pulse

**Files:**
- Modify: `~/dev/nanoclaw/src/db.ts` (contact_activity table)
- Create: `~/dev/nanoclaw/container/skills/relationship-pulse/SKILL.md`

- [ ] **Step 1: Add contact_activity tracking table**

```sql
CREATE TABLE IF NOT EXISTS contact_activity (
  contact_email TEXT NOT NULL,
  contact_name TEXT,
  last_inbound TEXT,      -- last email/message FROM them
  last_outbound TEXT,     -- last email/message TO them
  typical_cadence_days INTEGER,  -- learned from history
  interaction_count INTEGER DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (contact_email)
);
```

- [ ] **Step 2: Create relationship pulse skill**

Weekly task that checks contact_activity for:
- Contacts with `last_inbound` significantly past `typical_cadence_days`
- Contacts you owe a reply to
- New frequent contacts not yet in the registry

- [ ] **Step 3: Add scheduled task (weekly, runs with weekly review)**

- [ ] **Step 4: Tests, commit**

---

### Task 17: Smart Scheduling

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

Instruction-driven — agent uses GCal MCP tools already available.

- [ ] **Step 1: Add smart scheduling instructions**

```markdown
### Smart Scheduling

When an email contains a meeting request:
1. Extract the requested duration and topic
2. Use GCal tools to check your availability this week
3. Draft a reply with 3 available time slots
4. Send as a PROPOSE action for approval

When proposing times, prefer:
- Afternoons for external meetings
- Mornings for internal sync
- Avoid back-to-back with existing meetings (15 min buffer)
```

- [ ] **Step 2: Commit**

---

### Task 18: Knowledge Housekeeping Task

**Files:**
- Create: `~/dev/nanoclaw/container/skills/kb-housekeeping/SKILL.md`
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py` (add TTL metadata)

- [ ] **Step 1: Add TTL metadata fields to KB documents**

In the superpilot bridge API, extend the `upload_to_kb` to accept TTL metadata:

Add to the MCP server's `upload_to_kb` tool the ability to pass `nanoclaw_ttl_days` in the metadata.

- [ ] **Step 2: Create housekeeping skill**

```markdown
# KB Housekeeping

Weekly maintenance of the knowledge base. Runs Sunday 10 AM.

## Tasks

1. **Expire**: Search KB for entries older than their TTL with no recent retrieval
2. **Consolidate**: Find multiple entries about the same project/topic, merge into one
3. **Budget check**: Count entries per project, prune if over 50
4. **Report**: Summarize what was expired, consolidated, pruned
```

- [ ] **Step 3: Schedule as weekly task**

- [ ] **Step 4: Commit**

---

### Task 19: Notification Intensity Controls

**Files:**
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`
- Modify: `~/dev/nanoclaw/src/db.ts` (notification_config table, optional)

- [ ] **Step 1: Add notification config section to CLAUDE.md**

The notification intensity config is already in CLAUDE.md from Phase 1. Now add the behavior instructions:

```markdown
### Notification Behavior

Before sending any message, check the intensity level for that feature:
- **silent**: do not send, log only, include in weekly review
- **digest**: batch into morning briefing or daily summary, do not send individually
- **normal**: send as part of batched summary per cycle
- **verbose**: send individually

Smart throttling: if >5 outbound messages in the last hour, batch remaining into one summary.
Exception: ESCALATE always sends immediately regardless of intensity or throttling.

As trust grows and more actions graduate to AUTO, propose reducing intensity:
"Your auto-handled rate is 70%. Want to dial proposals from verbose to normal?"
```

- [ ] **Step 2: Commit**

---

## Phase 5: Maturation & Operational

### Task 20: Cost Tracking

**Files:**
- Modify: `~/dev/nanoclaw/src/db.ts` (session_costs table)

- [ ] **Step 1: Add session_costs table**

```sql
CREATE TABLE IF NOT EXISTS session_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_type TEXT NOT NULL,  -- 'email_trigger', 'scheduled', 'message', 'poll'
  group_folder TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER,
  estimated_cost_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_session_costs_date ON session_costs(started_at);
```

- [ ] **Step 2: Add cost logging in container-runner.ts**

After a container agent completes, log the session:
- Estimate cost from duration + model (rough: $0.10/min as baseline)
- Store in session_costs table

- [ ] **Step 3: Add daily budget check**

In the IPC handler / scheduled task runner, before spawning a container:
- Sum today's estimated costs from session_costs
- If over $50 (configurable), skip non-escalation sessions and log warning
- Alert on Telegram: "Daily budget exceeded — switching to essential-only mode"

- [ ] **Step 4: Include cost in weekly review**

The weekly review skill should query session_costs and include a cost section.

- [ ] **Step 5: Tests, commit**

---

### Task 21: Superpilot-Down Fallback

**Files:**
- Modify: `~/dev/nanoclaw/src/db.ts` (system_state table)
- Modify: `~/dev/nanoclaw/groups/main/CLAUDE.md`

- [ ] **Step 1: Track superpilot connectivity in system_state**

Add a `system_state` table:
```sql
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Track `superpilot_last_ok` and `superpilot_alerted` timestamps.

- [ ] **Step 2: Add fallback instructions to CLAUDE.md**

```markdown
### Superpilot Fallback

If superpilot MCP tools fail (connection refused, timeout, 5xx):
- Skip email intelligence phases entirely (no crash, no retry)
- Continue Discord, calendar, and other features normally
- Log "superpilot unreachable" to system_state
- If unreachable for >2 hours (check system_state), send ONE Telegram alert:
  "Superpilot has been unreachable for 2+ hours — email processing paused"
- Do not send repeated alerts — check superpilot_alerted timestamp
```

- [ ] **Step 3: Commit**

---

### Task 22: Add NanoClaw to Work-Life-Wiki

**Files:**
- Modify: `~/dev/work-life-wiki/map/project-index.md`
- Modify: `~/dev/work-life-wiki/map/system-architecture.md`
- Modify: `~/dev/work-life-wiki/domains/ai-products.md`

- [ ] **Step 1: Add NanoClaw to project index**

- [ ] **Step 2: Add NanoClaw to system architecture diagram**

In the AI Products section, add NanoClaw alongside trustclawd:
```
nanoclaw ←── personal assistant (WhatsApp, Telegram, Discord)
    │
    └── inbox_superpilot (email pipeline + KB via MCP)
```

- [ ] **Step 3: Add NanoClaw to ai-products.md**

- [ ] **Step 4: Commit (in work-life-wiki repo)**

---

### Task 23: Cleanup Stale Branches

**Files:**
- NanoClaw git branches

- [ ] **Step 1: Delete stale local branches**

```bash
cd ~/dev/nanoclaw
git branch -d claude/naughty-mccarthy
git branch -d claude/determined-cori
```

- [ ] **Step 2: Remove dead Gmail channel code (optional)**

The Gmail channel in `src/channels/gmail.ts` is disabled and will never be re-enabled (email goes through superpilot). Consider removing it to reduce confusion. Check if any tests depend on it first.

---

## Verification Plan

### Per-Phase Verification

| Phase | Verification |
|-------|-------------|
| **1b** | Manual curl test of triaged-emails + kb/search with real data. IPC trigger from Gmail push creates NanoClaw agent session. |
| **2** | Send test email → agent proposes on Telegram → reply "approve" → agent sends reply. Reply "skip" → no action. Check approval_log table. |
| **3** | Morning briefing arrives at 7:30 AM with calendar + emails + Discord. Weekly review arrives Friday with stats. Commitment reminder fires before deadline. |
| **4** | Cross-channel correlation shown in briefing. Relationship pulse identifies stale contacts. Smart scheduling proposes 3 time slots. KB housekeeping prunes stale entries. |
| **5** | Cost tracking in weekly review. Budget ceiling works (blocks non-essential after $50). Superpilot-down alert after 2 hours. NanoClaw in work-life-wiki. |

### End-to-End Golden Path Test

After all phases:

1. Send yourself a meeting request email
2. Superpilot triages → IPC trigger → NanoClaw agent wakes
3. Agent checks calendar, drafts reply with available times
4. Sends PROPOSE to Telegram: "Meeting request from X. Here are 3 slots. Draft reply attached."
5. Reply "approve" on Telegram
6. Agent sends the reply email via superpilot
7. Agent creates calendar event
8. Agent stores meeting context in KB
9. 15 min before meeting → meeting prep packet on Telegram
10. Morning briefing next day includes the meeting
11. Weekly review shows: 1 email processed, 1 calendar event created, 1 commitment tracked

---

## Summary

| Phase | Tasks | What it delivers |
|-------|-------|-----------------|
| **1b** | 1-6 | Real data flowing through stubs, service token, IPC from Gmail push |
| **2** | 7-10 | Trust graduation, Telegram approval flow, KB read/write, 10 MCP tools |
| **3** | 11-14 | Morning briefing, commitment tracking, meeting prep, weekly review |
| **4** | 15-19 | Cross-channel correlation, relationship pulse, smart scheduling, KB housekeeping, notification tuning |
| **5** | 20-23 | Cost tracking, budget ceiling, superpilot fallback, wiki update, branch cleanup |
| **Total** | 23 tasks | Full email intelligence system as spec'd |
