# Email Intelligence — Remaining Superpilot Tasks + E2E Testing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the 5 remaining items (3 superpilot-side, 1 NanoClaw testing, 1 config) and verify the entire pipeline end-to-end.

**Architecture:** Tasks 3, 5, 6 are in `~/dev/inbox_superpilot` (FastAPI/Python backend). Task 7 is an integration test across both systems. Task 8 is skipped per user request.

**Tech Stack:** Python/FastAPI (superpilot), Celery, PostgreSQL/SQLAlchemy, SSE, Next.js (extension tests)

---

## Completed (this session)

- [x] Task 1: Agent processing — IPC triggers spawn agent sessions
- [x] Task 2: Subject/sender passthrough in NanoClaw SSE client
- [x] Task 4: Discord token reaching containers (readEnvFile fix)
- [x] Task 9: Cost tracking (logSessionCost + getTodaysCost)
- [x] Task 10: Budget ceiling ($50/day default)

All merged to main and pushed.

---

## Task 3: Fix SSE Keepalive (Superpilot)

**Problem:** SSE drops every ~30-100s due to Cloudflare proxy timeout.

**Finding:** The superpilot SSE endpoint already has a 30-second heartbeat (`backend/app/api/nanoclaw_bridge.py:191-194`), sending `: heartbeat\n\n` every 30 seconds. This should be sufficient for Cloudflare (100s default timeout). 

**Root cause hypothesis:** The heartbeat uses 3 cycles × 10s sleep (line 201), but `asyncio.sleep(10)` may not fire punctually under load, or Cloudflare's timeout may be shorter on this plan.

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py:139-211`

- [ ] **Step 1: Reduce heartbeat interval to 15 seconds**

In `nanoclaw_bridge.py`, find the heartbeat logic (around line 191). Change from 3 cycles × 10s (30s heartbeat) to sending a keepalive every 15 seconds:

```python
# Current: heartbeat_counter logic with 3 cycles
# Replace with: direct 15-second heartbeat

async def event_generator():
    cursor = since_iso
    while True:
        # ... existing poll logic ...
        
        # Send keepalive every iteration (15s sleep below)
        yield ": keepalive\n\n"
        await asyncio.sleep(15)
```

The key change: reduce the sleep from 10s to 15s and send keepalive every iteration instead of every 3rd iteration. Net effect: keepalive every 15s instead of 30s.

- [ ] **Step 2: Verify NanoClaw client handles keepalive comments**

NanoClaw's `src/email-sse.ts:105` already skips comments: `if (!part.trim() || part.startsWith(':')) continue;`. No changes needed.

- [ ] **Step 3: Deploy and monitor**

```bash
cd ~/dev/inbox_superpilot
git add backend/app/api/nanoclaw_bridge.py
git commit -m "fix: reduce SSE keepalive interval to 15s to prevent Cloudflare timeout"
git push
```

After deploy, monitor NanoClaw logs for 10+ minutes:
```bash
journalctl --user -u nanoclaw -f | grep SSE
```

Expected: No "SSE connection closed by server" messages within 10 minutes.

---

## Task 5: Wire Subject/Sender into Triaged Emails API (Superpilot)

**Problem:** The triaged-emails endpoint returns empty subject/sender. Comment at line 88-90 says: "subject and sender are not stored on EmailClassification; join to email_threads when available".

**Finding:** `EmailHistoryIndex` model has `subject` and `sender_email`/`sender_name` fields. Need to join via `gmail_message_id`.

**Files:**
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py:58-101`
- Modify: `~/dev/inbox_superpilot/backend/app/api/nanoclaw_bridge.py:139-211` (SSE events too)

- [ ] **Step 1: Find the EmailHistoryIndex model**

```bash
cd ~/dev/inbox_superpilot
grep -rn "class EmailHistoryIndex" backend/ --include="*.py"
```

Identify the join column (likely `gmail_message_id` or `message_id`).

- [ ] **Step 2: Add join to triaged-emails query**

In `nanoclaw_bridge.py` around line 70, update the query to join EmailHistoryIndex:

```python
from app.models import EmailClassification, EmailHistoryIndex

# Replace direct query with join
results = (
    db.query(EmailClassification, EmailHistoryIndex.subject, EmailHistoryIndex.sender_email)
    .outerjoin(EmailHistoryIndex, EmailClassification.gmail_message_id == EmailHistoryIndex.gmail_message_id)
    .filter(EmailClassification.user_id == user_id)
    .filter(EmailClassification.classified_at >= since_dt)
    .order_by(EmailClassification.classified_at.desc())
    .limit(50)
    .all()
)
```

Update the response mapping to include subject/sender from the join.

- [ ] **Step 3: Update SSE event payload to include subject/sender**

In the SSE event generator (around line 170-185), update the email payload to include subject/sender from the same join.

- [ ] **Step 4: Test locally**

```bash
cd ~/dev/inbox_superpilot
# Run backend locally
uvicorn backend.app.main:app --reload

# Test endpoint
curl -H "x-service-token: $NANOCLAW_SERVICE_TOKEN" \
  "http://localhost:8000/api/nanoclaw/triaged-emails?since=2026-04-01T00:00:00"
```

Verify subject/sender fields are populated.

- [ ] **Step 5: Commit and deploy**

```bash
git add backend/app/api/nanoclaw_bridge.py
git commit -m "fix: join EmailHistoryIndex to include subject/sender in triaged-emails and SSE events"
git push
```

---

## Task 6: Fix AuthGate Test (Superpilot Extension)

**Problem:** `AuthGate.test.tsx` fails, blocking full CI green.

**Finding:** The test file has 3 bug reproduction tests (BUG 1, 2, 3) related to per-account session checking and storage listener issues in the Chrome extension sidebar.

**Files:**
- Fix: `~/dev/inbox_superpilot/extension/src/sidebar/components/AuthGate.test.tsx`
- May need: `~/dev/inbox_superpilot/extension/src/sidebar/components/AuthGate.tsx`

- [ ] **Step 1: Run the test locally**

```bash
cd ~/dev/inbox_superpilot/extension
npm test -- --testPathPattern AuthGate 2>&1
```

Read the actual failure output.

- [ ] **Step 2: Read the test and component**

```bash
cat extension/src/sidebar/components/AuthGate.test.tsx
cat extension/src/sidebar/components/AuthGate.tsx | head -150
```

- [ ] **Step 3: Fix based on actual failure**

Common patterns:
- Mock setup doesn't match current component API
- Storage listener test needs async act() wrapping
- State update timing issues with React testing

- [ ] **Step 4: Verify fix**

```bash
npm test -- --testPathPattern AuthGate 2>&1
```

- [ ] **Step 5: Commit**

```bash
git add extension/src/sidebar/components/
git commit -m "fix: update AuthGate test to match current auth flow"
git push
```

---

## Task 7: End-to-End Integration Test

**Depends on:** Tasks 1 (done), 3, 5 deployed to production.

**Goal:** Verify the complete pipeline: email → superpilot triage → SSE → NanoClaw agent → clean proposal on Telegram.

- [ ] **Step 1: Deploy superpilot changes (Tasks 3, 5)**

Verify production deployment completed.

- [ ] **Step 2: Restart NanoClaw to pick up all changes**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
journalctl --user -u nanoclaw | tail -20
```

Verify startup logs show:
- SSE connected to superpilot
- Email intelligence enabled
- All channels connected

- [ ] **Step 3: Verify SSE stays alive**

```bash
journalctl --user -u nanoclaw -f | grep SSE &
sleep 300  # wait 5 minutes
```

No "SSE connection closed" messages should appear.

- [ ] **Step 4: Send a test email that triggers PROPOSE**

Send a real email to one of the monitored accounts (e.g., a question that needs a reply). Wait for triage.

- [ ] **Step 5: Verify agent processes the trigger**

Watch NanoClaw logs:
```bash
journalctl --user -u nanoclaw -f | grep -E "email_trigger|Email trigger|Container"
```

Expected sequence:
1. "SSE email trigger written" — SSE client writes IPC file
2. "Email trigger enqueued for agent processing" — IPC handler picks it up
3. Container spawns and processes
4. Agent output forwarded to Telegram

- [ ] **Step 6: Verify clean proposal on Telegram**

Check Telegram for a formatted proposal (not raw instructions). Should include:
- Email subject and sender
- Proposed action (reply draft, archive, escalate)
- Approval options (approve / edit / skip)

- [ ] **Step 7: Test approval flow**

Reply "approve" on Telegram. Verify:
- Agent receives the reply via message loop
- Action is executed
- `approval_log` table has entry:
```bash
sqlite3 ~/dev/nanoclaw/store/messages.db "SELECT * FROM approval_log ORDER BY timestamp DESC LIMIT 5;"
```

- [ ] **Step 8: Test rejection flow**

Trigger another email. When proposal arrives, reply "skip". Verify no action taken.

- [ ] **Step 9: Verify cost tracking**

```bash
sqlite3 ~/dev/nanoclaw/store/messages.db "SELECT * FROM session_costs ORDER BY started_at DESC LIMIT 10;"
```

Should show entries for the agent sessions.

- [ ] **Step 10: Verify Discord digest**

Trigger a morning briefing:
```
(on Telegram) run morning briefing
```

Verify Discord section is included (not an error).

---

## Verification Checklist

After all tasks:

- [ ] SSE connection stable >10 minutes (no drops)
- [ ] Triaged emails include subject and sender
- [ ] Agent processes email triggers (not raw forwarding)
- [ ] Clean proposal appears on Telegram
- [ ] "approve" triggers action execution
- [ ] "skip" prevents action
- [ ] Discord digest works
- [ ] `session_costs` table has entries
- [ ] Budget ceiling blocks when `DAILY_BUDGET_USD=0.01`
- [ ] Superpilot CI green (AuthGate test fixed)
