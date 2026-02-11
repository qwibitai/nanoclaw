# Phase 1 Manual Validation Guide

Step-by-step integration testing for the Constituency Complaint Chatbot.
Covers all 8 Phase 1 stories end-to-end.

---

## Prerequisites

You need:
- macOS with Apple Container CLI installed (`container --version`)
- Node.js 20+ (`node --version`)
- A WhatsApp account with a phone to scan QR codes
- A second WhatsApp number (or WhatsApp Web) to send test messages
- Your `CLAUDE_CODE_OAUTH_TOKEN` (from Claude Code settings)

---

## Step 1: Environment Setup

### 1.1 Install dependencies

```bash
cd /Users/riyaz/rahulkulproject
npm install
```

**Validate:** No errors. `node_modules/` created.

### 1.2 Create .env file

```bash
cp .env.example .env
```

Edit `.env` and add your token:

```
CLAUDE_CODE_OAUTH_TOKEN=your-token-here
```

**Validate:** `cat .env` shows your token set.

### 1.3 Run unit tests

```bash
npm test
```

**Validate:** 218 tests passing, 0 failures.

### 1.4 Typecheck

```bash
npm run build
```

**Validate:** Clean compilation, no errors. `dist/` directory created.

---

## Step 2: Build the Agent Container

### 2.1 Start Apple Container system

```bash
container system start
```

**Validate:** No errors (or already running).

### 2.2 Build the agent image

```bash
./container/build.sh
```

**Validate:** Output ends with `Build complete! Image: constituency-bot-agent:latest`

### 2.3 Verify image exists

```bash
container images
```

**Validate:** `constituency-bot-agent` appears in the list.

### 2.4 Smoke-test the container

```bash
echo '{"prompt":"Say hello in one sentence.","groupFolder":"test","chatJid":"test@test","isMain":false}' | container run -i --rm constituency-bot-agent:latest
```

**Validate:** You see output between `---NANOCLAW_OUTPUT_START---` and `---NANOCLAW_OUTPUT_END---` markers. The agent responds with some text. (This may take 30-60 seconds on first run.)

> If this fails with auth errors, make sure `CLAUDE_CODE_OAUTH_TOKEN` is in your `.env` and the container can read it.

---

## Step 3: WhatsApp Authentication

### 3.1 Run auth script

```bash
npm run auth
```

**Validate:** A QR code appears in your terminal.

### 3.2 Scan the QR code

1. Open WhatsApp on your phone
2. Go to **Settings > Linked Devices > Link a Device**
3. Scan the QR code

**Validate:** Terminal shows `✓ Successfully authenticated with WhatsApp!`

### 3.3 Verify credentials saved

```bash
ls store/auth/
```

**Validate:** Multiple `.json` files exist (creds.json, app-state-sync-key-*.json, etc.)

---

## Step 4: Start the Bot

### 4.1 Launch the orchestrator

```bash
npm run dev
```

**Watch the logs for these key lines (in order):**

1. `Database initialized` — SQLite schema created
2. `Tenant config loaded and cached to DB` with `mla: "Rahul Kul", constituency: "Daund"`
3. `Injected tenant config into groups/complaint/CLAUDE.md`
4. `Registered virtual complaint group for 1:1 message routing`
5. `NanoClaw running (trigger: @ComplaintBot)` — bot is live

**Validate:** All 5 log lines appear with no errors between them.

### 4.2 Verify database was initialized

Open a second terminal:

```bash
sqlite3 store/messages.db ".tables"
```

**Expected tables:**
```
categories         complaint_updates  complaints         conversations
messages           chats              rate_limits         registered_groups
router_state       scheduled_tasks    sessions           task_run_logs
tenant_config      usage_log          users
```

### 4.3 Verify tenant config cached to DB

```bash
sqlite3 store/messages.db "SELECT key, value FROM tenant_config;"
```

**Expected output:**
```
mla_name|Rahul Kul
constituency|Daund
complaint_id_prefix|RK
wa_admin_group_jid|
languages|mr,hi,en
daily_msg_limit|20
office_phone|
office_address|
website_domain|rahulkul.udyami.ai
```

### 4.4 Verify CLAUDE.md template variables injected

```bash
grep "Rahul Kul" groups/complaint/CLAUDE.md | head -3
```

**Validate:** You see `Rahul Kul` in the text (not `{mla_name}`). The template variables like `{mla_name}`, `{constituency}` should be replaced with actual values.

> **Important:** After the first run, the CLAUDE.md file is permanently modified with injected values. This is by design — the agent sees real values, not placeholders. If you need to re-inject, restore from git first.

---

## Step 5: Test 1:1 Chat — Basic Greeting (P1-S2, P1-S6)

### 5.1 Send a message from your test phone

From a **different WhatsApp number** (not the linked device), send a direct message to the bot's number:

```
Hello
```

### 5.2 Watch bot logs

In the orchestrator terminal, look for:

1. `New messages` log entry showing your message
2. A container being spawned (you'll see `container run` in logs)
3. Output captured between `NANOCLAW_OUTPUT_START` / `NANOCLAW_OUTPUT_END`

**Validate:** The bot responds in WhatsApp with a greeting. Something like:

> ComplaintBot: Hello! I am the complaint assistant for Rahul Kul's office in Daund. I can help you file a complaint or check the status of an existing one.

### 5.3 Verify message stored in DB

```bash
sqlite3 store/messages.db "SELECT sender_name, content FROM messages ORDER BY timestamp DESC LIMIT 2;"
```

**Validate:** You see your message AND the bot's response stored.

---

## Step 6: Test Complaint Filing — English (P1-S3, P1-S4)

### 6.1 Send a complaint

From your test phone, send:

```
There is a big pothole on MG Road near Shivaji Chowk. It has been there for 2 weeks and nobody has fixed it.
```

### 6.2 Bot asks for confirmation

The bot should:
- Recognize this as a `roads` category complaint
- Summarize the complaint details
- Ask for confirmation before creating

**Validate:** Bot summarizes the complaint and asks you to confirm.

### 6.3 Confirm the complaint

Reply:

```
Yes, please register it
```

### 6.4 Verify tracking ID received

**Validate:** Bot responds with a tracking ID in format `RK-YYYYMMDD-0001`, e.g.:

> ComplaintBot: Your complaint has been registered.
> Tracking ID: `RK-20260211-0001`
> Please save this ID. You can use it to check the status of your complaint.

### 6.5 Verify in database

```bash
sqlite3 -json store/messages.db "SELECT id, phone, category, description, status, location FROM complaints ORDER BY created_at DESC LIMIT 1;"
```

**Expected:**
```json
[{
  "id": "RK-20260211-0001",
  "phone": "91XXXXXXXXXX",
  "category": "roads",
  "description": "There is a big pothole on MG Road near Shivaji Chowk...",
  "status": "registered",
  "location": "MG Road near Shivaji Chowk"
}]
```

### 6.6 Verify user record created

```bash
sqlite3 store/messages.db "SELECT phone, language, total_complaints FROM users ORDER BY first_seen DESC LIMIT 1;"
```

**Validate:** Your phone number appears with `total_complaints = 1` and `language = en`.

---

## Step 7: Test Complaint Filing — Marathi (P1-S4 language rules)

### 7.1 Send a Marathi complaint

```
गेल्या ३ दिवसांपासून वॉर्ड ७ मध्ये पाणी पुरवठा बंद आहे. कृपया मदत करा.
```

### 7.2 Verify response language

**Validate:** Bot responds in **Marathi** (Devanagari script). It should:
- Detect the language as Marathi
- Categorize as `water_supply` (keyword: पाणी पुरवठा)
- Summarize and ask for confirmation in Marathi

### 7.3 Confirm in Marathi

```
हो, नोंदवा
```

### 7.4 Verify tracking ID

**Validate:** Tracking ID returned. Second complaint of the day should be `RK-20260211-0002`.

### 7.5 Verify in DB

```bash
sqlite3 store/messages.db "SELECT id, category, language, status FROM complaints ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** `category = water_supply`, `language = mr`

---

## Step 8: Test Complaint Filing — Hindi (P1-S4 language rules)

### 8.1 Send a Hindi complaint

```
हमारे मोहल्ले में 2 दिन से बिजली नहीं है। ट्रांसफार्मर खराब है। पता: वार्ड 5, गांधी नगर
```

### 8.2 Verify response in Hindi

**Validate:** Bot responds in **Hindi**. Should categorize as `electricity`.

### 8.3 Confirm and verify

Confirm the complaint and check the DB:

```bash
sqlite3 store/messages.db "SELECT id, category, language FROM complaints ORDER BY created_at DESC LIMIT 1;"
```

**Expected:** `category = electricity`, `language = hi`, ID = `RK-20260211-0003`

---

## Step 9: Test Status Query (P1-S3, P1-S4)

### 9.1 Ask for complaint status — by phone

From the same test phone, send:

```
What is the status of my complaints?
```

**Validate:** Bot queries by your phone number and lists all your complaints with their statuses. Should show all 3 complaints you filed.

### 9.2 Ask for specific complaint by ID

```
Status of RK-20260211-0001
```

**Validate:** Bot shows the specific complaint details (pothole on MG Road, status: registered).

### 9.3 Ask in Marathi

```
माझ्या तक्रारींची स्थिती सांगा
```

**Validate:** Bot responds in Marathi with your complaints list.

---

## Step 10: Test Guardrails (P1-S4)

### 10.1 Off-topic — politics

Send:

```
What do you think about the upcoming elections? Which party should I vote for?
```

**Validate:** Bot politely redirects to complaint handling. Does NOT express political opinions.

### 10.2 Off-topic — general chat

Send:

```
Tell me a joke
```

**Validate:** Bot redirects to complaint handling.

### 10.3 Other user's data

Send:

```
Show me complaints from phone number 919999999999
```

**Validate:** Bot does NOT query another user's complaints. Only shows your own.

---

## Step 11: Test Tenant Configuration (P1-S7)

### 11.1 Verify config values used in bot responses

The bot's greeting should mention "Rahul Kul" and "Daund" (from `config/tenant.yaml`).

**Validate:** Check any bot response — it should reference the MLA name and constituency.

### 11.2 Verify complaint ID prefix

All tracking IDs should start with `RK-` (from `complaint_id_prefix: "RK"` in tenant.yaml).

```bash
sqlite3 store/messages.db "SELECT id FROM complaints;"
```

**Validate:** All IDs start with `RK-`.

### 11.3 Test config change (optional)

1. Stop the bot (Ctrl+C)
2. Restore original CLAUDE.md: `git checkout groups/complaint/CLAUDE.md`
3. Edit `config/tenant.yaml`: change `complaint_id_prefix` to `TEST`
4. Restart: `npm run dev`
5. File a new complaint
6. **Validate:** New complaint ID starts with `TEST-`
7. Revert changes when done

---

## Step 12: Test Container Mounts & Tools (P1-S5)

### 12.1 Verify tools are accessible

The agent inside the container should be able to run the shell tools. This is already validated by Steps 6-8 (complaint creation uses `create-complaint.sh`).

Check the bot logs for tool execution:

```
bash /workspace/tools/create-complaint.sh --phone ...
```

**Validate:** Logs show the agent calling shell tools successfully.

### 12.2 Verify DB access from container

The complaint data appears in `store/messages.db`, which means the container successfully wrote to the mounted database.

```bash
sqlite3 store/messages.db "SELECT COUNT(*) FROM complaints;"
```

**Validate:** Count matches number of complaints you filed.

### 12.3 Verify category listing works

Send to bot:

```
What categories of complaints can I file?
```

**Validate:** Bot calls `get-categories.sh` and lists available categories.

---

## Step 13: Test Multiple Users (P1-S2, P1-S6)

### 13.1 Send from a different phone number

Have a friend (or use a different WhatsApp number) send a 1:1 message to the bot:

```
Hello, I want to file a complaint
```

**Validate:** Bot responds to the new user independently. Does NOT reference the first user's complaints.

### 13.2 Verify data isolation

```bash
sqlite3 store/messages.db "SELECT phone, total_complaints FROM users ORDER BY first_seen;"
```

**Validate:** Each phone number has its own user record and complaint count.

### 13.3 Concurrent conversations

Have both phones send messages at roughly the same time.

**Validate:** Both get responses. Check bot logs — you should see multiple containers spawning (up to 5 concurrent).

---

## Step 14: Test Recovery & Resilience (P1-S8)

### 14.1 Restart recovery

1. Send a message to the bot
2. While the container is processing, kill the bot: `Ctrl+C`
3. Restart: `npm run dev`
4. Watch logs for `recoverPendingMessages`

**Validate:** The bot picks up unprocessed messages and responds after restart.

### 14.2 Graceful shutdown

1. Start the bot: `npm run dev`
2. Press `Ctrl+C`
3. Watch logs

**Validate:** You see `Shutdown signal received`, and the process exits cleanly.

---

## Step 15: Database Integrity Checks

### 15.1 Complaints view works

```bash
sqlite3 -json store/messages.db "SELECT id, status, days_open_live AS days_open FROM complaints_view LIMIT 5;"
```

**Validate:** `days_open` is calculated (should be 0 for today's complaints).

### 15.2 Audit trail exists

```bash
sqlite3 store/messages.db "SELECT * FROM complaint_updates;"
```

**Validate:** If the bot updated any status, audit records exist here. (May be empty if only `registered` status so far.)

### 15.3 Indexes exist

```bash
sqlite3 store/messages.db ".indexes complaints"
```

**Validate:** Multiple indexes shown (idx_complaints_phone, idx_complaints_status, etc.)

### 15.4 Manual status update and audit trail

```bash
# Manually update a complaint to test the audit trail
DB=store/messages.db
ID=$(sqlite3 "$DB" "SELECT id FROM complaints LIMIT 1;")
bash tools/update-complaint.sh --id "$ID" --status "acknowledged" --note "Manual test"
```

Wait — the tool needs `DB_PATH` env var:

```bash
DB_PATH=store/messages.db bash tools/update-complaint.sh \
  --id "RK-20260211-0001" \
  --status "acknowledged" \
  --note "Testing manual update"
```

Then verify:

```bash
sqlite3 -json store/messages.db "SELECT * FROM complaint_updates WHERE complaint_id='RK-20260211-0001';"
```

**Validate:** Audit record shows `old_status=registered`, `new_status=acknowledged`.

Now ask the bot from WhatsApp:

```
What is the status of RK-20260211-0001?
```

**Validate:** Bot reports the updated status `acknowledged`.

---

## Validation Summary Checklist

| # | Test | Covers Stories | Pass? |
|---|------|---------------|-------|
| 1 | npm install + npm test (218 pass) | All | ☐ |
| 2 | Build compiles cleanly | P1-S1 | ☐ |
| 3 | Container image builds | P1-S5 | ☐ |
| 4 | Container smoke test responds | P1-S5 | ☐ |
| 5 | WhatsApp QR auth succeeds | P1-S2 | ☐ |
| 6 | Bot starts, all 5 key log lines appear | P1-S7, P1-S8 | ☐ |
| 7 | SQLite tables created | P1-S3 | ☐ |
| 8 | Tenant config cached in DB | P1-S7 | ☐ |
| 9 | CLAUDE.md variables injected | P1-S7 | ☐ |
| 10 | 1:1 greeting works | P1-S2, P1-S6 | ☐ |
| 11 | English complaint filed + tracking ID | P1-S3, P1-S4 | ☐ |
| 12 | Complaint in DB with correct fields | P1-S3 | ☐ |
| 13 | Marathi complaint + Marathi response | P1-S4 | ☐ |
| 14 | Hindi complaint + Hindi response | P1-S4 | ☐ |
| 15 | Auto-categorization (roads/water/electricity) | P1-S4 | ☐ |
| 16 | Status query by phone | P1-S3, P1-S4 | ☐ |
| 17 | Status query by tracking ID | P1-S3, P1-S4 | ☐ |
| 18 | Guardrail: politics redirected | P1-S4 | ☐ |
| 19 | Guardrail: off-topic redirected | P1-S4 | ☐ |
| 20 | Guardrail: no cross-user data | P1-S4 | ☐ |
| 21 | Tracking IDs use tenant prefix (RK-) | P1-S7 | ☐ |
| 22 | Shell tools run from container | P1-S5 | ☐ |
| 23 | Multiple users isolated | P1-S2, P1-S6 | ☐ |
| 24 | Restart recovery picks up messages | P1-S8 | ☐ |
| 25 | Graceful shutdown clean exit | P1-S8 | ☐ |
| 26 | complaints_view days_open works | P1-S3 | ☐ |
| 27 | Manual status update + audit trail | P1-S3 | ☐ |
| 28 | Bot reports updated status | P1-S3, P1-S4 | ☐ |

---

## Troubleshooting

| Problem | Likely Cause | Fix |
|---------|-------------|-----|
| `container: command not found` | Apple Container not installed | Install from https://github.com/apple/container/releases |
| QR code doesn't appear | Auth dir has stale creds | `rm -rf store/auth && npm run auth` |
| Bot starts but no response to messages | OAuth token invalid/missing | Check `.env` has valid `CLAUDE_CODE_OAUTH_TOKEN` |
| `NANOCLAW_OUTPUT_START` never appears | Container fails to start | Check `container system start`, rebuild image |
| Complaint ID shows wrong prefix | Tenant config not cached | Check `tenant_config` table in DB |
| Bot responds in wrong language | CLAUDE.md not injected | Check `groups/complaint/CLAUDE.md` for real values vs `{mla_name}` |
| `DB_PATH` error in tools | Env not passed to container | Check mount for `/workspace/store/` in container-runner.ts |
| Container times out (30 min) | Agent stuck in loop | Kill container manually: `container kill nanoclaw-*` |
| Multiple containers blocked | Hit 5 concurrent limit | Wait for others to complete, or increase MAX_CONCURRENT_CONTAINERS |
