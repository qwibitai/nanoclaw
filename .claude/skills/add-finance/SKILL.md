---
name: add-finance
description: Stand up a dedicated finance agent backed by Google Sheets, accessible via a dedicated Telegram bot. Creates the agent group, wires the bot, provisions the googlesheets toolkit on Composio, bootstraps a 9-tab workbook, and writes the agent's persona/system-prompt. Triggers on "add finance", "finance agent", "financeiro".
type: feature
---

# /add-finance

Standup of the finance agent. ~30 minutes end-to-end. Steps 1–11 below. Each step says **who** does it (Claude vs operator) and **how to verify** before moving on.

## Prerequisites

Before starting, confirm:

- [ ] NanoClaw v2 is running (`launchctl list | grep nanoclaw` or `systemctl --user status nanoclaw`)
- [ ] Composio is set up and `googlesheets` is in the catalog (check `groups/global/CLAUDE.md` toolkit table)
- [ ] Operator has access to BotFather on Telegram
- [ ] Operator's Google account is the one that should own the workbook

If any of these are missing, fix them first (`/setup`, `/customize`, etc.) and come back.

---

## Upgrade from Plan 1?

If `/add-finance` was already run (Plan 1) and the workbook + agent are working, **don't re-run this whole skill**. Instead:

1. Pull latest skill files (`git pull` to get Plan 2 templates)
2. Copy `.claude/skills/add-finance/system-prompt.md` to `groups/finance/system-prompt.md` (replaces the Plan 1 prompt with the new intents)
3. Operator pastes `migration-prompt.md` content into `@<bot>Bot` to apply schema changes to the existing sheet
4. Run `scripts/finance/register-cron-jobs.ts` to register the 5 cron jobs

Skip the whole "create agent group / bot / sheet" flow.

---

## Step 1 — Pick agent name (operator decides)

Default: `finance`. If the operator wants a different name (e.g., `money`, `grana`), use that everywhere below — but the rest of this document assumes `finance`.

Confirm with operator: "Vamos usar `finance` como nome do agent group, folder e Telegram bot? (sim/outro)"

---

## Step 2 — Create the agent group in DB

Claude does this. The agent group is the unit that owns the workspace folder, the Composio session, and the Telegram routing.

Run a Node script (inline, in `npm run dev`-equivalent context). The simplest path is to write a one-shot TS script and execute via `npx tsx`:

```typescript
// scripts/finance/_register-agent-group.ts (one-shot, can be deleted after)
import path from 'path';
import { initDb } from '../../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../../src/db/agent-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';

// Initialize DB
const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = initDb(dbPath);
runMigrations(db);

// Check if already exists
const existing = getAgentGroup('finance');
if (existing) {
  console.log('ℹ️ Agent group "finance" already exists');
  process.exit(0);
}

// Create agent group
// NOTE: agent_provider is intentionally OMITTED (NULL). The agent-runner only
// recognizes empty/null and dispatches to its default provider. Passing
// 'anthropic' literally crashes with "Unknown provider: anthropic".
createAgentGroup({
  id: 'finance',
  name: 'Finance', // internal name — different from persona name (Step 9)
  folder: 'finance',
  container_config: JSON.stringify({
    mcpServers: {}, // composio session URL added in Step 7
  }),
  created_at: new Date().toISOString(),
});

console.log('✅ Agent group "finance" created');
```

Then:

```bash
npx tsx scripts/finance/_register-agent-group.ts
```

**Verify:** Run the script and check for success message. Or query the DB directly:

```bash
sqlite3 data/v2.db "SELECT id, name, folder FROM agent_groups WHERE id='finance';"
```

Expected: 1 row with `finance | Finance | finance`.

---

## Step 3 — Create workspace folder

Claude does this.

```bash
mkdir -p groups/finance/scratch
cp .claude/skills/add-finance/claude-md-template.md groups/finance/CLAUDE.md
cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md
```

**Verify:**

```bash
ls -la groups/finance/
```

Expected: `CLAUDE.md`, `system-prompt.md`, `scratch/`.

`CLAUDE.md` still has placeholders `__SHEET_ID__` and `__SHEET_URL__` — those get filled in Step 9.

---

## Step 4 — Operator creates a new Telegram bot

Operator does this (Claude can't talk to BotFather).

Tell operator:

```
1. Abra Telegram, fala com @BotFather
2. /newbot
3. Nome (display): "Finance — Jonas" (ou o que quiser)
4. Username: termina em "bot", ex: JonasFinanceBot
5. Copia o token que ele te dá (formato 12345:ABC...)
6. Manda o token aqui
```

Wait for operator to paste the token before proceeding. Store it in memory of this session — it goes into `.env` next.

---

## Step 5 — Add bot token to .env and restart NanoClaw

Claude does this.

**Real pattern (verified in `src/channels/telegram.ts:222-260`):** Secondary Telegram bots are NOT loaded from per-bot env vars. They are loaded from each agent group's `container_config.telegramBotToken` field. On startup, `registerSecondaryBots()` scans `agent_groups`, finds those with a `telegramBotToken`, and registers an adapter named `telegram-<folder>` for each.

So you write the token directly into the DB:

```typescript
// scripts/finance/_set-token.ts (one-shot, delete after)
import path from 'path';
import { initDb, getDb } from '../../src/db/connection.js';
import { getAgentGroup } from '../../src/db/agent-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = initDb(dbPath);
runMigrations(db);

const TOKEN = '<token from operator>'; // from BotFather

const ag = getAgentGroup('finance');
if (!ag) {
  console.error('❌ Agent group "finance" not found. Run Step 2 first.');
  process.exit(1);
}

const cfg = ag.container_config ? JSON.parse(ag.container_config) : {};
cfg.telegramBotToken = TOKEN;

getDb()
  .prepare('UPDATE agent_groups SET container_config=? WHERE id=?')
  .run(JSON.stringify(cfg), 'finance');

console.log('✅ Token wired into agent_groups.finance.container_config');
```

Run it:

```bash
npx tsx scripts/finance/_set-token.ts
```

Then restart NanoClaw to pick up the new secondary bot:

```bash
systemctl restart nanoclaw          # Linux (system service)
# or
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

**Verify:** the secondary bot was registered and started:

```bash
grep -E 'agentGroup="finance"|channel="telegram-finance"' /root/nanoclaw/logs/nanoclaw.log | tail -5
```

Expected lines (in order):
- `Registering secondary Telegram bot agentGroup="finance" folder="finance" channelType="telegram-finance"`
- `Telegram adapter initialized { botUserId: '<numeric>', userName: '<botname>_bot' }`
- `Channel adapter started channel="telegram-finance"`

---

## Step 6 — Wire Telegram bot to agent group `finance`

Claude does this. Need a `messaging_groups` row (the DM channel) + a `messaging_group_agents` row (the wiring).

**Schema reality (verified — table column names matter):**
- `messaging_groups`: `(id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)` with `UNIQUE(channel_type, platform_id)`
- `messaging_group_agents`: `(id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)` with `UNIQUE(messaging_group_id, agent_group_id)`

For the new secondary bot, `channel_type='telegram-finance'` (matches `telegram-<folder>` from Step 5). `platform_id='telegram:<operator_user_id>'` — the operator's own Telegram user ID, which is the same as their DM chat ID. You can get it from existing wiring of another agent (e.g., Naia):

```bash
sqlite3 data/v2.db "SELECT DISTINCT platform_id FROM messaging_groups WHERE channel_type LIKE 'telegram-%' AND is_group=0;"
```

Or have operator send any message to a known bot and grep logs for `userId="telegram:<NUMERIC>"`.

Script:

```typescript
// scripts/finance/_wire-messaging.ts (one-shot, delete after)
import path from 'path';
import { initDb, getDb } from '../../src/db/connection.js';
import { runMigrations } from '../../src/db/migrations/index.js';

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = initDb(dbPath);
runMigrations(db);

const CHANNEL_TYPE = 'telegram-finance';
const PLATFORM_ID = '<telegram:OPERATOR_USER_ID>'; // e.g. telegram:8557164566
const MG_ID = 'mg-finance-dm';
const MGA_ID = 'mga-finance';
const sqlite = getDb();

const existingMg = sqlite
  .prepare('SELECT id FROM messaging_groups WHERE channel_type=? AND platform_id=?')
  .get(CHANNEL_TYPE, PLATFORM_ID) as { id: string } | undefined;

let mgId: string;
if (existingMg) {
  mgId = existingMg.id;
  console.log(`ℹ️  messaging_group already exists: ${mgId}`);
} else {
  sqlite
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, 0, 'strict', ?)`
    )
    .run(MG_ID, CHANNEL_TYPE, PLATFORM_ID, '<AgentName> DM', new Date().toISOString());
  mgId = MG_ID;
  console.log(`✅ messaging_group created: ${mgId}`);
}

const existingMga = sqlite
  .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id=? AND agent_group_id=?')
  .get(mgId, 'finance') as { id: string } | undefined;

if (!existingMga) {
  sqlite
    .prepare(
      `INSERT INTO messaging_group_agents
       (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
       VALUES (?, ?, ?, NULL, 'all', 'shared', 0, ?)`
    )
    .run(MGA_ID, mgId, 'finance', new Date().toISOString());
  console.log(`✅ messaging_group_agent created: ${MGA_ID}`);
} else {
  console.log(`ℹ️  messaging_group_agent already exists: ${existingMga.id}`);
}
```

Run it:

```bash
npx tsx scripts/finance/_wire-messaging.ts
```

**Verify:** Operator sends "oi" to the new bot. Check logs:

```bash
grep -E 'sess-.*agentGroupId="finance"|Message routed.*agentGroup="finance"' /root/nanoclaw/logs/nanoclaw.log | tail -5
```

Expected: log entries showing the session was created and routed to `agentGroup="finance"`. The bot should respond with the persona's intro line (e.g. "Oi, Jonas! Meu nome é Levis...").

---

## Step 7 — Add `googlesheets` to Composio matrix for `finance`

Claude does this.

Edit `scripts/composio-generate-auth-links.mjs`. Find the `MATRIX` object, add the new entry:

```js
const MATRIX = {
  // ...existing agents...
  finance: ['googlesheets'],  // NEW
};
```

Then run the standard Composio playbook (from `project_composio_auth.md`):

```bash
COMPOSIO_API_KEY=ak_... node scripts/composio-generate-auth-links.mjs
```

This outputs a connect URL. **Operator opens the URL, authenticates with their Google account.**

After operator confirms auth done:

```bash
COMPOSIO_API_KEY=ak_... node scripts/composio-audit-connections.mjs
```

Look for `user_id=finance` with `googlesheets` status `ACTIVE`.

Then:

```bash
COMPOSIO_API_KEY=ak_... node scripts/composio-provision-sessions.ts --agent-group finance
```

This creates the MCP session and writes its URL into `agent_groups.finance.container_config.mcpServers.composio`.

**Verify:**

```bash
sqlite3 data/v2.db "SELECT json_extract(container_config, '$.mcpServers.composio') FROM agent_groups WHERE id='finance';"
```

Expected: a `https://backend.composio.dev/tool_router/...` URL.

---

## Step 8 — Bootstrap the workbook (operator-triggered, agent-executed)

Operator does this on Telegram. Claude prepares the message.

Tell operator:

```
1. Copia o arquivo bootstrap-sheet-prompt.md pro workspace do Levis:
   cp .claude/skills/add-finance/bootstrap-sheet-prompt.md groups/finance/bootstrap.md

2. Abra Telegram, vá pro @<bot> Bot.
3. Cole a mensagem curta:
   "Leia /workspace/agent/bootstrap.md e execute todos os passos. Reporte SHEET_ID no final."

4. Espera ~5-10 min (12-step batch).
5. Quando ele responder com SHEET_ID, me manda aqui.
```

(O arquivo é colado no workspace porque Telegram limita ~4096 chars por mensagem; o prompt tem ~14KB.)

The agent will use its `googlesheets` MCP tools to execute the 12 steps.

**Verify with operator:** SHEET_ID format is `1AbCdE...` (44 chars typically). URL opens a sheet titled "Finance — Jonas" with 9 tabs visible.

---

## Step 9 — Fill SHEET_ID into agent's CLAUDE.md

Claude does this.

```bash
SHEET_ID="<id from operator>"
SHEET_URL="https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit"
AGENT_NAME="<persona name the bot uses, e.g. Levis>"  # ask operator: usually = the BotFather display name

sed -i.bak \
  -e "s|__SHEET_ID__|${SHEET_ID}|g" \
  -e "s|__SHEET_URL__|${SHEET_URL}|g" \
  -e "s|__AGENT_NAME__|${AGENT_NAME}|g" \
  groups/finance/CLAUDE.md groups/finance/system-prompt.md
rm -f groups/finance/CLAUDE.md.bak groups/finance/system-prompt.md.bak
```

(BSD sed on macOS uses `-i.bak`; GNU sed on Linux is compatible with the same syntax. Either works.)

**Verify:**

```bash
grep -c '__SHEET_ID__\|__SHEET_URL__\|__AGENT_NAME__' groups/finance/CLAUDE.md groups/finance/system-prompt.md
```

Expected: `0` for both files (no remaining placeholders).

---

## Step 9.5 — Register 5 cron jobs (Plan 2)

Claude does this. The 5 jobs use NanoClaw v2 recurring-message pattern (`insertTask()` into the agent's session inbox).

Pre-req: the operator has used the bot at least once, so a session exists. Find the session id:

```bash
sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='finance' ORDER BY created_at DESC LIMIT 1;"
```

Run the registration script:

```bash
npx tsx scripts/finance/register-cron-jobs.ts --session <session-id-from-above>
```

**Verify:**

```bash
# replace <session-id> with the actual id from above
sqlite3 data/v2-sessions/finance/<session-id>/inbound.db \
  "SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"
```

Expected: 5 rows with ids `task-finance-sweep|daily|weekly|monthly|rollover` and matching cron expressions.

---

## Step 10 — Restart finance agent session

Claude does this. Forces the agent to re-read its CLAUDE.md with the SHEET_ID now baked in.

```bash
sqlite3 data/v2.db "DELETE FROM sessions WHERE agent_group_id='finance';"
```

Next message to the bot starts a fresh session that loads CLAUDE.md fresh.

---

## Step 11 — Verification checklist (operator runs, on Telegram)

Operator goes through this checklist on Telegram. Each item, operator types the message and observes the result. Mark each ✅ or ❌.

### Sheet structure

- [ ] Open the sheet URL. 9 tabs visible: Dashboard, Lançamentos-PF, Lançamentos-PJ, Recorrentes, Orçamento, Projeção, Lembretes, Categorias, _Log
- [ ] `Categorias` has 15 rows (9 PF + 6 PJ)
- [ ] `Projeção!H1` exists with named range `SALDO_INICIAL` (Data > Named ranges menu)
- [ ] Headers in each tab match spec (row 1 bold + frozen)
- [ ] `Lançamentos-PF.tipo` shows dropdown when clicked (despesa/receita)
- [ ] `Lançamentos-PF.categoria` shows dropdown of 9 PF categories

### Agent behavior (chat with bot)

- [ ] Send "oi" → agent responds in PT-BR with persona
- [ ] Send "gastei 30 no café" → agent responds with confirmation card asking PF/PJ first time, then card with valor=R$30, categoria sugerida (Alimentação), botões [✓][✏️][❌]
- [ ] Tap ✓ → agent responds "✅ Lançado (lan-XXXXXX)" and a row appears in `Lançamentos-PF` (ou PJ se for esse o escopo)
- [ ] Send "todo dia 5 sai 100 do Spotify" → confirmação de recorrente, ✓ → linha em `Recorrentes` com `proxima_data` calculada (próximo dia 5)
- [ ] Send "desfaz" → última linha gravada some
- [ ] Send "quanto gastei hoje?" → resposta com valor (sem escrever)
- [ ] Set `SALDO_INICIAL` na sheet pra 1000 → abrir `Projeção` → 6 meses populados, saldo_acumulado começa de 1000 e ajusta por receitas/despesas dos recorrentes

If any item fails: stop, root-cause, fix. Do not declare install successful.

---

## Cleanup

After successful install, delete the throwaway scripts:

```bash
rm -f scripts/finance/_register-agent-group.ts scripts/finance/_wire-bot.ts
```

(These were one-shot — not needed once the DB rows are persisted.)

---

## What's NOT in this skill (intentionally)

- Cron jobs / digests / lembretes intraday → Plan 2 (`/add-finance-automation` skill, future)
- PDF/imagem ingestion → use `/add-pdf-reader` and `/add-image-vision` separately
- Multi-user → out of scope
- Bank/cartão integration → out of scope (use Composio Plaid/Pluggy in future)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot doesn't respond at all | Bot token not picked up | Restart NanoClaw + check logs |
| Bot responds but generic (Zory-like) | Routing wired wrong | Check `messaging_group_agents` table for `agent_group_id='finance'` |
| Bootstrap prompt fails on Step 1 | googlesheets not provisioned | Re-run Step 7 audit + provision |
| Bootstrap creates sheet but wrong tabs | Agent didn't follow prompt — re-prompt with "estava no passo X, continue" | |
| `categoria` dropdown empty | Categorias seed not done | Re-run Step 8 just for Passo 11 (seed) |
| Confirmação não aparece | system-prompt.md não carregou | Reinicia sessão (Step 10) |
