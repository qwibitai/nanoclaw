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
await createAgentGroup({
  id: 'finance',
  name: 'Finance',
  folder: 'finance',
  agent_provider: 'anthropic',
  container_config: JSON.stringify({
    mcpServers: {} // composio session URL added by provision-sessions step later
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

> **⚠️ Pre-check (load-bearing):** confirm that `src/channels/telegram.ts` and `src/channels/channel-registry.ts` support **multiple Telegram bots via per-bot env var** (e.g., `TELEGRAM_BOT_TOKEN_<NAME>`). If the codebase only supports a single `TELEGRAM_BOT_TOKEN`, you must extend the channel adapter first OR check whether `/add-telegram-swarm` already added this support. **Do not proceed until this is confirmed.** Read both files; if there's no enumeration of multiple tokens, this is a code-change blocker — surface to operator and pause Plan 1.

Once multi-bot support is confirmed:

Edit `.env`, add (or update if exists):

```env
TELEGRAM_BOT_TOKEN_FINANCE=<token from operator>
```

Then restart NanoClaw to pick up the env change:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# or
systemctl --user restart nanoclaw                  # Linux
```

**Verify:** check logs that the new bot started. The exact log path depends on your service config — for launchd, look at the `StandardOutPath` in `~/Library/LaunchAgents/com.nanoclaw.plist`; for systemd, `journalctl --user -u nanoclaw`.

```bash
# example, adapt to your log path
journalctl --user -u nanoclaw -n 100 | grep -iE 'telegram.*finance|JonasFinanceBot'
```

---

## Step 6 — Wire Telegram bot to agent group `finance`

Claude does this. Need a messaging group + an agent route.

The cleanest way: invoke `/manage-channels` (it knows the messaging_group / messaging_group_agent flow) and tell it: "wire the new Telegram bot for `finance` as DM-only, exclusive route, session_mode=shared."

Alternative (manual, if `/manage-channels` doesn't fit): write another one-shot script:

```typescript
// scripts/finance/_wire-bot.ts
import { createMessagingGroup } from '../../src/db/messaging-groups';
import { createMessagingGroupAgent } from '../../src/db/messaging-groups';

const messagingGroupId = 'mg-finance-tg';

await createMessagingGroup({
  id: messagingGroupId,
  channel: 'telegram',
  external_id: '<operator's Telegram user ID>', // DM only — operator's own user ID, not a group ID
  name: 'Finance DM',
  created_at: new Date().toISOString(),
});

await createMessagingGroupAgent({
  id: 'mga-finance',
  messaging_group_id: messagingGroupId,
  agent_group_id: 'finance',
  trigger_rules: null, // catch-all in this DM
  response_scope: 'all',
  session_mode: 'shared',
  priority: 0,
  created_at: new Date().toISOString(),
});

console.log('✅ Telegram bot wired to agent group finance');
```

Operator's Telegram user ID: ask operator to send `/start` to the bot. Server logs will show their user ID. Update `external_id` accordingly and rerun.

**Verify:** Operator sends "oi" to the bot. Bot should respond with the system prompt's persona-introduction line OR at minimum the agent should be invoked (check logs).

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
Abra Telegram, vá pro @JonasFinanceBot (ou o nome que escolheu).
Cole esse prompt inteiro como mensagem (sem cortar):

---
<paste the entire content of .claude/skills/add-finance/bootstrap-sheet-prompt.md here>
---

Espera o agente executar (~2-3 min — vai mandar updates de progresso).
Quando ele responder com "✅ Workbook criada com sucesso! SHEET_ID: ...", copia o SHEET_ID e me manda aqui.
```

The agent will use its `googlesheets` MCP tools to execute the 12 steps.

**Verify with operator:** SHEET_ID format is `1AbCdE...` (44 chars typically). URL opens a sheet titled "Finance — Jonas" with 9 tabs visible.

---

## Step 9 — Fill SHEET_ID into agent's CLAUDE.md

Claude does this.

```bash
SHEET_ID="<id from operator>"
SHEET_URL="https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit"

sed -i.bak "s|__SHEET_ID__|${SHEET_ID}|g; s|__SHEET_URL__|${SHEET_URL}|g" groups/finance/CLAUDE.md
rm groups/finance/CLAUDE.md.bak
```

(macOS sed needs `-i.bak`; Linux can use `-i ''`.)

**Verify:**

```bash
grep -E 'SHEET_ID|SHEET_URL' groups/finance/CLAUDE.md
```

Expected: lines show actual ID and URL (no `__...__` placeholders).

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
