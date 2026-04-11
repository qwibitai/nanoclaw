# Email Intelligence — Final Fixes + Exhaustive QA

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the remaining 3 issues (subject/sender data, approval flow, Discord digest), then run an exhaustive QA across every component of the email intelligence system.

**Architecture:** Subject/sender requires enabling the EmailHistoryIndex backfill pipeline in superpilot (per-account API call). Approval flow and Discord digest are runtime tests against the live system. QA covers all 10 subsystems.

**Tech Stack:** Python/FastAPI (superpilot), Node.js (NanoClaw), SQLite, Docker, Telegram, Discord

---

## Already Fixed This Session

| Issue | Fix | Status |
|-------|-----|--------|
| Agent forwards raw prompts | `enqueueEmailTrigger` spawns container agent | ✅ Deployed |
| SSE drops (Cloudflare) | 15s keepalive on superpilot | ✅ Deployed, 9min+ stable |
| Discord/service tokens not reaching containers | `readEnvFile` fix | ✅ Deployed |
| DB read-only in containers | `store/` mounted read-write | ✅ Deployed |
| `<internal>` tags leaking to Telegram | `formatOutbound()` in IPC + onResult paths | ✅ Deployed |
| Empty From/Subject in prompts | Fallback to "unknown sender"/"(no subject)" | ✅ Deployed |
| Cost tracking | `logSessionCost` in runAgent + runTask | ✅ Deployed |
| Budget ceiling | `DAILY_BUDGET_USD` ($50/day) | ✅ Deployed |
| Superpilot CI red (AuthGate test) | Fixed mock, CI fully green | ✅ Deployed |

---

## Task 1: Enable EmailHistoryIndex Backfill for All Accounts

**Problem:** Subject/sender fields are empty because EmailHistoryIndex has zero matching rows. The indexing pipeline exists and works but requires explicit enablement per account via `POST /email-history/enable`.

**Root cause:** EmailHistoryIndex backfill was never enabled for any Gmail accounts. The superpilot API needs a call per account to start the backfill.

**Files:** No code changes — API calls only.

- [ ] **Step 1: Enable backfill for all 3 Gmail accounts**

Call the superpilot API for each account:

```bash
NANOCLAW_TOKEN=$(cd ~/dev/wxa-secrets && uv run python -m wxa_secrets get NANOCLAW_SERVICE_TOKEN)

# Personal
curl -X POST "https://app.inboxsuperpilot.com/api/email-history/enable" \
  -H "x-service-token: $NANOCLAW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_email": "topcoder1@gmail.com", "window_days": 30}'

# WhoisXML
curl -X POST "https://app.inboxsuperpilot.com/api/email-history/enable" \
  -H "x-service-token: $NANOCLAW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_email": "jonathan.zhang@whoisxmlapi.com", "window_days": 30}'

# Attaxion
curl -X POST "https://app.inboxsuperpilot.com/api/email-history/enable" \
  -H "x-service-token: $NANOCLAW_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"account_email": "jonathan@attaxion.com", "window_days": 30}'
```

Expected: Each returns `{"status": "enabled", "backfill_status": "pending", "window_days": 30}`

NOTE: The service token auth may not work for this endpoint (it may require a real user session). If so, use the superpilot web UI or call from a context with a valid user session.

- [ ] **Step 2: Monitor backfill progress**

Wait 5-10 minutes for the Celery beat scheduler to pick up the pending backfills. Check progress:

```bash
# Check if backfill tasks are running
curl -s -H "x-service-token: $NANOCLAW_TOKEN" \
  "https://app.inboxsuperpilot.com/api/email-history/status?account_email=topcoder1@gmail.com"
```

Or check Celery logs on the production server.

- [ ] **Step 3: Verify subject/sender populates**

After backfill completes (may take 10-30 minutes depending on email volume):

```bash
curl -s -H "x-service-token: $NANOCLAW_TOKEN" \
  "https://app.inboxsuperpilot.com/api/nanoclaw/triaged-emails?since=2026-04-11T00:00:00" | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
with_subject = sum(1 for e in data['emails'] if e['subject'])
print(f'Total: {data[\"count\"]}, With subject: {with_subject}')
if with_subject: print(f'Example: {data[\"emails\"][0][\"subject\"]} from {data[\"emails\"][0][\"sender\"]}')
"
```

Expected: Non-zero "With subject" count.

- [ ] **Step 4: Verify SSE events include subject/sender**

Wait for the next real email to arrive. Check NanoClaw logs:
```bash
tail -f /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log | grep "trigger"
```

When a trigger fires, check the IPC file to see if subject/sender are populated:
```bash
ls -la /Users/topcoder1/dev/nanoclaw/data/ipc/whatsapp_main/tasks/
cat /Users/topcoder1/dev/nanoclaw/data/ipc/whatsapp_main/tasks/sse_trigger_*.json | python3 -m json.tool | tail -20
```

---

## Task 2: Test Approval Flow End-to-End

**Depends on:** Task 1 (agent needs subject/sender for useful proposals), store/ mount fix (agent can write processed_items).

- [ ] **Step 1: Trigger an email that should generate PROPOSE**

Send a real email to topcoder1@gmail.com from an external address asking a question that needs a reply. Example: ask about a meeting time or request information.

Wait for superpilot to triage it (1-5 minutes).

- [ ] **Step 2: Watch NanoClaw process the trigger**

```bash
tail -f /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log | grep -E "trigger|Spawning|container|agent"
```

Expected sequence:
1. "SSE email trigger written"
2. "Email trigger enqueued for agent processing"
3. "Spawning container agent"
4. Container output streamed

- [ ] **Step 3: Verify clean proposal on Telegram**

Check Telegram for a formatted proposal. Should include:
- Email subject and sender (if backfill completed)
- Classification (AUTO/PROPOSE/ESCALATE)
- Proposed action
- Approval options (approve / edit / skip)

Should NOT include:
- Raw "## Email Intelligence Trigger" instructions
- `<internal>...</internal>` tags
- Blank From/Subject

- [ ] **Step 4: Test "approve" response**

Reply "approve" on Telegram. Watch logs:
```bash
tail -f /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log | grep -E "approve|action|processed"
```

Verify:
- Agent receives the reply
- Action is executed (email reply sent, or whatever was proposed)
- `approval_log` table has entry:
```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/messages.db "SELECT * FROM approval_log ORDER BY timestamp DESC LIMIT 3;"
```

- [ ] **Step 5: Test "skip" response**

Wait for another trigger, then reply "skip". Verify:
- No action taken
- `approval_log` logs rejection
- Email marked as processed (no re-trigger)

- [ ] **Step 6: Verify processed_items populated**

```bash
sqlite3 /Users/topcoder1/dev/nanoclaw/store/messages.db "SELECT * FROM processed_items ORDER BY processed_at DESC LIMIT 5;"
```

Expected: Entries for processed emails.

---

## Task 3: Verify Discord Digest

- [ ] **Step 1: Trigger morning briefing manually**

Send on Telegram: `run morning briefing`

Or trigger directly via NanoClaw container:
```bash
# Create an IPC task to run the morning briefing skill
cat > /Users/topcoder1/dev/nanoclaw/data/ipc/whatsapp_main/tasks/manual_briefing.json << 'EOF'
{
  "type": "schedule_task",
  "id": "manual-morning-briefing",
  "group_folder": "whatsapp_main",
  "chat_jid": "tg:6580029392",
  "prompt": "Run the morning-briefing skill. Generate a comprehensive morning briefing covering calendar, emails needing response, commitments due, Discord overnight activity, and meeting prep. Send via send_message.",
  "schedule_type": "once",
  "schedule_value": "2026-04-11T10:35:00Z",
  "context_mode": "group"
}
EOF
```

- [ ] **Step 2: Watch for Discord-related output**

```bash
tail -f /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.log | grep -i "discord\|briefing\|morning"
```

Verify:
- Container spawns for morning briefing
- Discord section appears (not "DISCORD_BOT_TOKEN not found" error)
- Briefing arrives on Telegram with Discord activity section

- [ ] **Step 3: Check for Discord errors**

```bash
tail -20 /Users/topcoder1/dev/nanoclaw/logs/nanoclaw.error.log | grep -i discord
```

Expected: No Discord-related errors.

---

## Exhaustive QA Checklist

After all fixes are verified, run through every subsystem systematically.

### QA-1: SSE Connection Stability
- [ ] SSE connected and stable for 10+ minutes (no reconnect log entries)
- [ ] Verify keepalive comments flowing (no "connection closed by server")
- [ ] Check error log for SSE-related warnings

### QA-2: Email Trigger Pipeline
- [ ] SSE event received → IPC file written → IPC handler processes
- [ ] Agent container spawns from email trigger (not raw message)
- [ ] Agent output forwarded to Telegram (clean, no raw instructions)
- [ ] `<internal>` tags stripped from all outbound messages
- [ ] Empty subject/sender shows "unknown sender"/"(no subject)" (not blank)

### QA-3: Subject/Sender Data
- [ ] Triaged emails API returns subject and sender when EmailHistoryIndex has data
- [ ] SSE events include subject and sender
- [ ] NanoClaw IPC trigger files include subject and sender
- [ ] Agent prompt includes readable email summaries

### QA-4: Processed Items (Idempotency)
- [ ] Agent marks emails as processed in `processed_items` table
- [ ] Re-triggered emails are skipped (no double-processing)
- [ ] `processed_items` has entries with correct item_id, source, action_taken

### QA-5: Approval Flow
- [ ] PROPOSE-tier emails generate clean proposals on Telegram
- [ ] "approve" → action executed, logged to `approval_log`
- [ ] "skip" → no action, logged as rejected
- [ ] "edit: [changes]" → agent revises and re-proposes (if implemented)

### QA-6: Cost Tracking
- [ ] `session_costs` table has entries after agent sessions
- [ ] Entries have correct session_type (message/task), group_folder, duration_ms
- [ ] `estimated_cost_usd` is non-zero and reasonable

### QA-7: Budget Ceiling
- [ ] Set `DAILY_BUDGET_USD=0.01` temporarily → verify agent blocked
- [ ] Check log: "Daily budget exceeded, blocking agent invocation"
- [ ] Task scheduler logs "skipped" with "Budget exceeded" error
- [ ] Reset to normal budget after test

### QA-8: Discord Integration
- [ ] `DISCORD_BOT_TOKEN` reaches container (readEnvFile fix)
- [ ] Morning briefing includes Discord activity section
- [ ] No "token not found" errors in container logs

### QA-9: Scheduled Tasks
- [ ] Morning briefing scheduled (7:30 AM, next_run correct)
- [ ] Weekly review scheduled (Friday 5 PM)
- [ ] KB housekeeping scheduled (Sunday 10 AM)
- [ ] All tasks have status "active" and valid next_run timestamps
- [ ] Task runs log to `task_run_logs` with correct status and duration

### QA-10: Container Security
- [ ] Project root mounted read-only (except store/)
- [ ] `.env` shadowed by `/dev/null` mount
- [ ] Store directory writable (agent can write processed_items)
- [ ] Per-group IPC namespace isolation
- [ ] OneCLI gateway applies credential injection

### QA-11: Channel Routing
- [ ] Telegram receives agent output (email proposals)
- [ ] Discord bot connected (verify in startup logs)
- [ ] WhatsApp connected (verify in startup logs)
- [ ] Messages from all channels stored in DB

### QA-12: Database Schema Integrity
- [ ] All email intelligence tables exist: processed_items, approval_log, commitments, contact_activity, session_costs, system_state
- [ ] Indexes exist on processed_items(processed_at), approval_log(action_type, timestamp), commitments(status, due_date)
- [ ] session_costs(started_at) index exists

### QA-13: Error Handling
- [ ] SSE reconnects on disconnect (exponential backoff)
- [ ] Agent error → notification sent to Telegram ("⚠️ Email intelligence trigger failed")
- [ ] Budget exceeded → graceful skip (no crash)
- [ ] Stale session detection works (clears corrupt session IDs)

### QA-14: Superpilot CI
- [ ] All CI jobs green: Lint Backend, Lint Frontend, Test Backend, Test Web, Test Shared
- [ ] Deploy to production succeeded
- [ ] AuthGate tests passing (all 3 bug reproduction tests)
