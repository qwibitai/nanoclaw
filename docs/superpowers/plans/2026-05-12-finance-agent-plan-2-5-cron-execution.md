# Finance Agent — Plan 2.5: Cron Execution Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 5 finance cron jobs (`finance-sweep`, `finance-daily`, `finance-weekly`, `finance-monthly`, `finance-rollover`) execute their procedural instructions literally — not as chat. Fix the silent-drop in the transport layer (the agent currently receives an empty prompt), inject an override block + rewrite the 5 prompts to procedural Step N — tool style, and clean up Composio tool-slug drift that propagated from earlier plans.

**Architecture:** Three independent layers, all isolated to `.claude/skills/add-finance/` and `scripts/finance/` (no changes to shared `container/agent-runner/` or `src/`):
1. **Transport** — `register-cron-jobs.ts` writes `kind='task'` (not `'scheduled'`) with content `JSON.stringify({prompt:…})`, piggybacking the existing `formatTaskMessage()` envelope. Fixes the silent-drop without touching the formatter.
2. **Override block** — fixed `prompts/_override-block.md` (~15 lines) prefixed to every cron prompt by the registration script. Tells the agent: non-interactive, no greeting, no confirmation cards, output must be exactly `<message to="jonas">…</message>` or `<internal>silent run: …</internal>`.
3. **Procedural prompts** — rewrite the 5 prompts in `Step N — Tool: …` style with exact Composio slugs, replacing narrative pt-br.

**Tech Stack:** TypeScript + vitest (NanoClaw v2), `better-sqlite3` against `:memory:` for tests, Composio `googlesheets` MCP (slugs confirmed against active matrix), `cron-parser` (already a dep).

**Spec:** [docs/superpowers/specs/2026-05-12-finance-cron-execution-design.md](../specs/2026-05-12-finance-cron-execution-design.md) (commit `c4ff5bc`).

---

## File Structure

### Skill template files — updated/added in this plan

```
.claude/skills/add-finance/
├── SKILL.md                          # MODIFY: Step 9.5 verify kind='task'; Plan 2 → 2.5 upgrade note
├── system-prompt.md                  # MODIFY: 2 slug fixes (lines 183, 241) — keep CRON section
├── claude-md-template.md             # MODIFY: 4 slug fixes (lines 69, 71, 72, 73)
├── cron-jobs.json                    # MODIFY: kind 'scheduled' → 'task' in 5 entries
└── prompts/
    ├── _override-block.md            # NEW: fixed override prefix
    ├── sweep-reminder.md             # REWRITE: procedural Step style
    ├── daily-digest.md               # REWRITE
    ├── weekly-closing.md             # REWRITE
    ├── monthly-closing.md            # REWRITE
    └── rollover.md                   # REWRITE
```

### Scripts — modified in this plan

```
scripts/finance/
├── register-cron-jobs.ts             # MODIFY: read override block, prepend to each prompt, write JSON content with kind='task'; add TODO pointing at formatter.ts:80-105
├── unregister-cron-jobs.ts           # MODIFY: no logic change; remove stale 'scheduled' comment if any
└── __tests__/
    └── register-cron-jobs.test.ts    # MODIFY: update 3 existing tests; add 4th (idempotency seq stability is already covered, add: content is JSON + has override + procedural marker)
```

### Live runtime files — updated by operator during migration

```
groups/finance/
├── CLAUDE.md                         # operator: targeted in-place edit of lines 69-73 (4 slug fixes)
├── system-prompt.md                  # operator: cp from skill template (full overwrite)
└── workbook on Google Drive          # operator: confirm _Log tab exists with headers
```

### Live runtime — DB substitution

```
data/v2-sessions/finance/<session>/inbound.db   # operator: unregister + re-register cron rows (replaces 5 'scheduled' rows with 5 'task' rows)
```

### What's NOT in this plan

- Adding `kind='system_task'` or any new kind to the generic formatter.
- Any change to `container/agent-runner/`, `src/host-sweep.ts`, `src/db/session-db.ts`.
- Backfilling the formatter bug fix for other (non-finance) agents — documented via inline TODO only.
- Adjusting cron schedules from Plan 2 (`0 8-22 * * *` etc) — remain as-is.
- Plaid / open-finance / brokerage / multi-currency — same exclusions as Plan 2.

---

## Naming and conventions

- **JSON content shape:** `{"prompt": "<override-block-text>\n\n<procedural-prompt-text>"}` — exact JSON, no extra fields. The container's `formatTaskMessage()` reads `content.prompt` and renders it after `[SCHEDULED TASK]\n\nInstructions:\n`.
- **Canonical Composio slugs** (confirmed against active matrix for user `googlesheets_battle-bahoe`):
  - `GOOGLESHEETS_VALUES_GET` — read range
  - `GOOGLESHEETS_BATCH_GET` — read multiple ranges
  - `GOOGLESHEETS_UPDATE_VALUES_BATCH` — update many cells
  - `GOOGLESHEETS_VALUES_UPDATE` — update single range
  - `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` — append row
  - `GOOGLESHEETS_CLEAR_VALUES` — clear range
  - `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` — lookup by value
- **`_Log` referenced as `'_Log'!A:E`** with single quotes (leading underscore in tab name; Composio recommends quoting in A1).

---

## Phase 1 — Skill template updates

### Task 1: Create the override block file

**Files:**
- Create: `.claude/skills/add-finance/prompts/_override-block.md`

- [ ] **Step 1.1: Write the override block**

Create `.claude/skills/add-finance/prompts/_override-block.md` with exactly this content:

````markdown
[SYSTEM TASK — NON-INTERACTIVE]

Este é um cron job automatizado, não uma mensagem do Jonas. Regras de execução:

1. NÃO cumprimente. NÃO peça confirmação. NÃO pergunte esclarecimento.
2. NÃO mostre cards de confirmação. NÃO use os templates "📝 Confirma?".
3. Os princípios "Confirme antes de escrever" e "Pergunte se ambíguo" NÃO se aplicam — siga os Steps literalmente.
4. Output deve ser exatamente UM destes formatos:
   - `<message to="jonas">{conteúdo entregue ao usuário}</message>` — quando o cron produz info útil
   - `<internal>silent run: {motivo curto}</internal>` — quando não há nada pra entregar
5. SEMPRE registre 1 linha em `_Log!A:E` ao final via `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`: `[ISO timestamp, job_name, status, qtd_processada, detalhes]`.
6. Se algum Step falhar: log error em `_Log` + emita `<message to="jonas">⚠️ Cron {nome}: {erro curto}</message>` (1 frase).
7. Não tente "recuperar criativamente" — falha → log + reporta + para.

Execute os Steps abaixo na ordem. Cada Step é uma tool-call explícita ou ação determinística.

---
````

- [ ] **Step 1.2: Verify**

```bash
wc -l .claude/skills/add-finance/prompts/_override-block.md
test -s .claude/skills/add-finance/prompts/_override-block.md && echo OK
```

Expected: ~17 lines, file exists and is non-empty.

- [ ] **Step 1.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/_override-block.md
git commit -m "feat(finance): add prompts/_override-block.md (Plan 2.5)"
```

---

### Task 2: Rewrite `sweep-reminder.md` in procedural style

**Files:**
- Modify: `.claude/skills/add-finance/prompts/sweep-reminder.md`

- [ ] **Step 2.1: Replace the file content**

Overwrite `.claude/skills/add-finance/prompts/sweep-reminder.md` with:

````markdown
[CRON: finance-sweep]

Job: enviar lembretes vencidos do Jonas.

**Step 1 — Ler Lembretes**
Tool: `GOOGLESHEETS_VALUES_GET`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `range`: `Lembretes!A2:E1000`

Se a resposta for vazia → pula direto pro Step 5 com `qtd_processada=0`.

**Step 2 — Filtrar vencidos (em memória)**
Mantenha apenas linhas onde:
- col C (`quando`) ≤ datetime atual
- col E (`enviado_em`) está vazia/nula

Resultado: array `vencidos = [{row_index, mensagem, quando}, ...]` (`row_index` é 1-based, contando o header — então a primeira linha de dados é row 2).
Se `vencidos.length === 0` → Step 5 com `qtd_processada=0`.

**Step 3 — Enviar mensagens**
Para cada item em `vencidos`, em ordem, emita exatamente:
`<message to="jonas">🔔 Lembrete: {mensagem}</message>`

**Step 4 — Marcar como enviado**
Tool: `GOOGLESHEETS_UPDATE_VALUES_BATCH`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `valueInputOption`: `USER_ENTERED`
- `data`: array com 1 entrada por item em `vencidos`:
  - `range`: `Lembretes!E{row_index}`
  - `values`: `[[<ISO timestamp atual>]]`

Uma única chamada batch com todas as células.

**Step 5 — Log**
Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `'_Log'!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: `[[<ISO timestamp atual>, "finance-sweep", "success", <vencidos.length>, ""]]`

**Step 6 — Output final**
- `vencidos.length > 0` → já emitiu N `<message>` no Step 3. Não emita mais nada.
- `vencidos.length === 0` → emita `<internal>silent run: 0 lembretes vencidos</internal>`.

**Erro em qualquer Step:**
- Append linha em `_Log` com `status="error"` e `detalhes=<msg curta>` (mesmo tool do Step 5).
- Emita `<message to="jonas">⚠️ Cron finance-sweep: <erro curto></message>`.
- Não tente "recuperar criativamente".
````

- [ ] **Step 2.2: Verify**

```bash
grep -c '^\*\*Step' .claude/skills/add-finance/prompts/sweep-reminder.md
grep -q 'GOOGLESHEETS_VALUES_GET' .claude/skills/add-finance/prompts/sweep-reminder.md && echo OK_get
grep -q 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND' .claude/skills/add-finance/prompts/sweep-reminder.md && echo OK_append
```

Expected: 6 Step headers, `OK_get`, `OK_append`.

- [ ] **Step 2.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/sweep-reminder.md
git commit -m "feat(finance): rewrite sweep-reminder.md in procedural Step style"
```

---

### Task 3: Rewrite `daily-digest.md` in procedural style

**Files:**
- Modify: `.claude/skills/add-finance/prompts/daily-digest.md`

- [ ] **Step 3.1: Replace the file content**

Overwrite `.claude/skills/add-finance/prompts/daily-digest.md` with:

````markdown
[CRON: finance-daily]

Job: gerar e enviar o digest matinal do dia anterior + próximos 7 dias.

**Step 1 — Coletar dados (1 chamada batch)**
Tool: `GOOGLESHEETS_BATCH_GET`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `ranges`: array com:
  - `Lançamentos-PF!A2:L10000`
  - `Lançamentos-PJ!A2:L10000`
  - `Recorrentes!A2:I1000`
  - `Recebiveis!A2:G1000`
  - `Orçamento!A2:F1000`
  - `Contas!A2:F100`

Se qualquer range vier vazio, trate como `[]` e siga.

**Step 2 — Filtrar em memória**
Calcule `ontem` = data atual − 1 dia (formato `yyyy-mm-dd`), `hoje7` = data atual + 7 dias.

- `lançamentos_ontem_PF` = linhas de `Lançamentos-PF` com `data == ontem`.
- `lançamentos_ontem_PJ` = idem para PJ.
- `recorrentes_proximos` = linhas de `Recorrentes` com `ativo=TRUE` (col I) e `proxima_data` (col G) entre hoje e `hoje7` e `pago_no_mes=FALSE` (col H).
- `recebiveis_proximos` = linhas de `Recebiveis` com `status='esperado'` (col F) e `data_prevista` (col E) entre hoje e `hoje7`.
- `orçamentos_alerta` = linhas de `Orçamento` com `status` (col F) em `["⚠️ 80%", "❌ estourou"]`.
- `saldos` = todas linhas de `Contas` com `ativo=TRUE` (col F).

**Step 3 — Compor mensagem**
Monte string usando este molde (substitua placeholders por valores; omita seções inteiramente vazias):

```
☀️ Bom dia, Jonas!

📊 Ontem ({dd/mm}):
• {N} lançamentos: -R${total_despesa_PF+PJ} +R${total_receita_PF+PJ}
• Top categoria: {categoria mais frequente} (R${valor})

📅 Próximos 7 dias:
{para cada item em recorrentes_proximos + recebiveis_proximos, ordenado por data: "• {dd/mm}: {nome} R${valor}"}

⚠️ Alertas:
{para cada item em orçamentos_alerta: "• {categoria}: {valor_atual}/{teto} ({status})"}

💰 Saldos PF: {nome_PF1} R${saldo} • {nome_PF2} R${saldo} • {nome_PF3} R${saldo}
💰 Saldos PJ: {nome_PJ1} R${saldo} • {nome_PJ2} R${saldo} • {nome_PJ3} R${saldo}
```

Se TODAS estas condições forem verdadeiras: `lançamentos_ontem_PF + lançamentos_ontem_PJ` vazios, `recorrentes_proximos + recebiveis_proximos` vazios, `orçamentos_alerta` vazio → use versão curta:

```
☀️ Tudo quieto — sem movimento ontem, sem vencimentos próximos.

💰 Saldos PF: ...
💰 Saldos PJ: ...
```

**Step 4 — Enviar**
Emita exatamente: `<message to="jonas">{mensagem montada no Step 3}</message>`.

**Step 5 — Log**
Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `'_Log'!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: `[[<ISO timestamp atual>, "finance-daily", "success", <lançamentos_ontem_PF.length + lançamentos_ontem_PJ.length>, ""]]`

**Erro em qualquer Step:**
- Append linha em `_Log` com `status="error"` e `detalhes=<msg curta>`.
- Emita `<message to="jonas">⚠️ Cron finance-daily: <erro curto></message>`.
````

- [ ] **Step 3.2: Verify**

```bash
grep -c '^\*\*Step' .claude/skills/add-finance/prompts/daily-digest.md
grep -q 'GOOGLESHEETS_BATCH_GET' .claude/skills/add-finance/prompts/daily-digest.md && echo OK_batch_get
```

Expected: 5 Step headers, `OK_batch_get`.

- [ ] **Step 3.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/daily-digest.md
git commit -m "feat(finance): rewrite daily-digest.md in procedural Step style"
```

---

### Task 4: Rewrite `weekly-closing.md` in procedural style

**Files:**
- Modify: `.claude/skills/add-finance/prompts/weekly-closing.md`

- [ ] **Step 4.1: Replace the file content**

Overwrite `.claude/skills/add-finance/prompts/weekly-closing.md` with:

````markdown
[CRON: finance-weekly]

Job: gerar fechamento da semana (domingo 19h) — últimos 7 dias.

**Step 1 — Coletar dados**
Tool: `GOOGLESHEETS_BATCH_GET`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `ranges`:
  - `Lançamentos-PF!A2:L10000`
  - `Lançamentos-PJ!A2:L10000`
  - `Contas!A2:F100`
  - `Orçamento!A2:F1000`

**Step 2 — Filtrar em memória**
Calcule `inicio` = data atual − 7 dias, `fim` = data atual.
- `lan_PF` = linhas de `Lançamentos-PF` com `data` entre `inicio` e `fim` (inclusive).
- `lan_PJ` = idem para PJ.
- `saldos` = todas linhas de `Contas` com `ativo=TRUE`.
- `orçamento` = todas linhas de `Orçamento`.

Agregue:
- `despesas_PF`, `receitas_PF` (soma de col D filtrada por col C = "despesa"/"receita")
- idem PF → PJ
- `diff_PF` = `receitas_PF − despesas_PF`; idem PJ
- `top3_PF` = top 3 categorias por total de despesa (col E + col D)
- `top3_PJ` = idem PJ
- `orc_ok`, `orc_alerta`, `orc_estourou` = contagens por `status` (col F)

**Step 3 — Compor mensagem**

```
📅 Resumo da semana ({inicio:dd/mm} a {fim:dd/mm})

PF: -R${despesas_PF} • +R${receitas_PF} • saldo da semana R${diff_PF}
PJ: -R${despesas_PJ} • +R${receitas_PJ} • saldo da semana R${diff_PJ}

Top 3 categorias PF: {top3_PF[0].cat} (R${v}) • {top3_PF[1]...} • {top3_PF[2]...}
Top 3 categorias PJ: {top3_PJ[0]...} • {top3_PJ[1]...} • {top3_PJ[2]...}

Orçamento: {orc_ok} OK • {orc_alerta} alerta • {orc_estourou} estouradas

Saldos atuais:
PF: {nome_PF1} R${s} • {nome_PF2} R${s} • {nome_PF3} R${s}
PJ: {nome_PJ1} R${s} • {nome_PJ2} R${s} • {nome_PJ3} R${s}
```

**Step 4 — Enviar**
Emita: `<message to="jonas">{mensagem do Step 3}</message>`.

**Step 5 — Log**
Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `'_Log'!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: `[[<ISO timestamp atual>, "finance-weekly", "success", <lan_PF.length + lan_PJ.length>, ""]]`

**Erro em qualquer Step:**
- Append linha em `_Log` com `status="error"` e `detalhes=<msg curta>`.
- Emita `<message to="jonas">⚠️ Cron finance-weekly: <erro curto></message>`.
````

- [ ] **Step 4.2: Verify**

```bash
grep -c '^\*\*Step' .claude/skills/add-finance/prompts/weekly-closing.md
```

Expected: 5.

- [ ] **Step 4.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/weekly-closing.md
git commit -m "feat(finance): rewrite weekly-closing.md in procedural Step style"
```

---

### Task 5: Rewrite `monthly-closing.md` in procedural style

**Files:**
- Modify: `.claude/skills/add-finance/prompts/monthly-closing.md`

- [ ] **Step 5.1: Replace the file content**

Overwrite `.claude/skills/add-finance/prompts/monthly-closing.md` with:

````markdown
[CRON: finance-monthly]

Job: fechamento mensal (último dia do mês 21h).

**Step 1 — Verificar se hoje é o último dia do mês**
Cron schedule é `0 21 28-31 * *` — dispara nos dias 28-31. Compute `amanhã = data atual + 1 dia`. Se `amanhã.mes == hoje.mes` → NÃO é último dia.

Se NÃO for último dia:
- NÃO emita `<message>`. NÃO escreva em `_Log` (silent skip, não é success nem error).
- Emita: `<internal>silent run: hoje não é o último dia do mês</internal>`. PARE.

Se for último dia, prossiga.

**Step 2 — Coletar dados**
Tool: `GOOGLESHEETS_BATCH_GET`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `ranges`:
  - `Lançamentos-PF!A2:L10000`
  - `Lançamentos-PJ!A2:L10000`
  - `Recorrentes!A2:I1000`
  - `Orçamento!A2:F1000`
  - `Recebiveis!A2:G1000`
  - `Contas!A2:F100`

**Step 3 — Filtrar e agregar em memória**
Calcule `mes_atual` = primeiro dia do mês (yyyy-mm-01).
- `lan_PF_mes` = linhas de `Lançamentos-PF` com `data ≥ mes_atual`.
- idem PJ.
- `receitas_PF`, `despesas_PF`, `saldo_PF_mes` = `receitas − despesas`.
- idem PJ.
- `top5_PF`, `top5_PJ` = top 5 categorias por total despesa.
- `rec_pagos` = linhas de `Recorrentes` com `ativo=TRUE` e `pago_no_mes=TRUE`.
- `rec_pendentes` = linhas de `Recorrentes` com `ativo=TRUE` e `pago_no_mes=FALSE`.
- `orc_ok`, `orc_alerta`, `orc_estourou` = contagens por status.
- `receb_recebidos`, `receb_atrasados`, `receb_cancelados` = contagens por status em `Recebiveis` no mês.
- `saldos` = `Contas.saldo_atual` por linha onde `ativo=TRUE`.

**Step 4 — Compor mensagem (15-25 linhas)**

```
📊 Fechamento de {mes_extenso}/{yyyy}

PF
─ Receitas: R${receitas_PF}
─ Despesas: R${despesas_PF}
─ Saldo do mês: R${saldo_PF_mes}
─ Top 5: {top5_PF formatado: "cat (R$ valor)"}

PJ
─ Receitas: R${receitas_PJ}
─ Despesas: R${despesas_PJ}
─ Saldo do mês: R${saldo_PJ_mes}
─ Top 5: {top5_PJ formatado}

Recorrentes:
─ Pagos: {rec_pagos.length}/{rec_pagos.length + rec_pendentes.length}
─ Pendentes: {lista de rec_pendentes.nome}

Orçamento:
─ OK: {orc_ok}
─ Alerta: {orc_alerta} ({lista})
─ Estourou: {orc_estourou} ({lista})

Recebíveis do mês:
─ Recebidos: {receb_recebidos.length} (R${total_recebido})
─ Atrasados: {receb_atrasados.length}
─ Cancelados: {receb_cancelados.length}

Saldos finais:
PF: {nome} R${saldo}, ...
PJ: {nome} R${saldo}, ...
```

**Step 5 — Enviar**
Emita: `<message to="jonas">{mensagem}</message>`.

**Step 6 — Log**
Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `'_Log'!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: `[[<ISO timestamp>, "finance-monthly", "success", <lan_PF_mes.length + lan_PJ_mes.length>, ""]]`

**Erro em qualquer Step (exceto Step 1 que pula silenciosamente):**
- Append em `_Log` com `status="error"`.
- Emita `<message to="jonas">⚠️ Cron finance-monthly: <erro curto></message>`.
````

- [ ] **Step 5.2: Verify**

```bash
grep -c '^\*\*Step' .claude/skills/add-finance/prompts/monthly-closing.md
```

Expected: 6.

- [ ] **Step 5.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/monthly-closing.md
git commit -m "feat(finance): rewrite monthly-closing.md in procedural Step style"
```

---

### Task 6: Rewrite `rollover.md` in procedural style

**Files:**
- Modify: `.claude/skills/add-finance/prompts/rollover.md`

- [ ] **Step 6.1: Replace the file content**

Overwrite `.claude/skills/add-finance/prompts/rollover.md` with:

````markdown
[CRON: finance-rollover]

Job: virada de mês (dia 1, 00:30) — reset `pago_no_mes` em Recorrentes + materialize lembretes do mês.

**Step 1 — Ler Recorrentes**
Tool: `GOOGLESHEETS_VALUES_GET`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `range`: `Recorrentes!A2:I1000`

Filtre em memória: `ativos = linhas com col I (ativo) == TRUE`.
Se `ativos.length === 0` → pula direto pro Step 5 com `qtd_processada=0` (silent run).

**Step 2 — Reset `pago_no_mes` em todos os Recorrentes ativos**
Tool: `GOOGLESHEETS_UPDATE_VALUES_BATCH`
- `spreadsheet_id`: <conforme CLAUDE.md>
- `valueInputOption`: `USER_ENTERED`
- `data`: array com 1 entrada por item em `ativos`:
  - `range`: `Recorrentes!H{row_index}` (col H = `pago_no_mes`; `row_index` = 1-based, header é row 1)
  - `values`: `[[false]]`

Uma única chamada batch.

**Step 3 — Materializar Lembretes pro mês**
Para cada `rec` em `ativos`, calcule:
- `id_lembrete` = `lem-rec-{rec.id}-{yyyy-mm}` (yyyy-mm = mês corrente)
- `data_vencimento` = `{yyyy}-{mm}-{rec.dia_do_mes}` (col F do `Recorrentes`)
- `quando` = `{data_vencimento} 09:00:00`
- `mensagem` = `Vence hoje: {rec.nome} R${rec.valor}`
- `linhagem` = `recorrente:{rec.id}`
- `enviado_em` = `""`

Antes de inserir, leia `Lembretes!A2:A10000` (col A = id) via `GOOGLESHEETS_VALUES_GET` e descarte `rec`s cujo `id_lembrete` já existe.

**Step 4 — Inserir Lembretes não-duplicados**
Se `lembretes_para_inserir.length > 0`:

Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `Lembretes!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: array de linhas, cada uma `[id_lembrete, quando, mensagem, linhagem, enviado_em]`

Se `lembretes_para_inserir.length === 0` → pula esta tool call.

**Step 5 — Log**
Tool: `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND`
- `spreadsheetId`: <conforme CLAUDE.md>
- `range`: `'_Log'!A:E`
- `valueInputOption`: `USER_ENTERED`
- `values`: `[[<ISO timestamp>, "finance-rollover", "success", <ativos.length>, "<lembretes_para_inserir.length> lembretes novos"]]`

**Step 6 — Enviar mensagem**
Emita: `<message to="jonas">🗓️ Novo mês começou. {ativos.length} recorrentes resetados, {lembretes_para_inserir.length} lembretes agendados pro mês.</message>`.

**Erro em qualquer Step:**
- Append em `_Log` com `status="error"` e `detalhes=<msg curta>`.
- Emita `<message to="jonas">⚠️ Cron finance-rollover: <erro curto></message>`.
````

- [ ] **Step 6.2: Verify**

```bash
grep -c '^\*\*Step' .claude/skills/add-finance/prompts/rollover.md
grep -q 'GOOGLESHEETS_UPDATE_VALUES_BATCH' .claude/skills/add-finance/prompts/rollover.md && echo OK_update
grep -q 'GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND' .claude/skills/add-finance/prompts/rollover.md && echo OK_append
```

Expected: 6, `OK_update`, `OK_append`.

- [ ] **Step 6.3: Commit**

```bash
git add .claude/skills/add-finance/prompts/rollover.md
git commit -m "feat(finance): rewrite rollover.md in procedural Step style"
```

---

### Task 7: Update `cron-jobs.json` — kind `scheduled` → `task`

**Files:**
- Modify: `.claude/skills/add-finance/cron-jobs.json`

- [ ] **Step 7.1: Replace the file content**

Overwrite `.claude/skills/add-finance/cron-jobs.json` with:

```json
{
  "jobs": [
    {
      "id": "task-finance-sweep",
      "kind": "task",
      "recurrence": "0 8-22 * * *",
      "promptFile": "sweep-reminder.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-daily",
      "kind": "task",
      "recurrence": "0 8 * * *",
      "promptFile": "daily-digest.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-weekly",
      "kind": "task",
      "recurrence": "0 19 * * 0",
      "promptFile": "weekly-closing.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-monthly",
      "kind": "task",
      "recurrence": "0 21 28-31 * *",
      "promptFile": "monthly-closing.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-rollover",
      "kind": "task",
      "recurrence": "30 0 1 * *",
      "promptFile": "rollover.md",
      "firstRunOffsetMs": 60000
    }
  ]
}
```

- [ ] **Step 7.2: Verify**

```bash
node -e 'const j=require("./.claude/skills/add-finance/cron-jobs.json"); console.log(j.jobs.length, j.jobs.every(x=>x.kind==="task"))'
```

Expected: `5 true`.

- [ ] **Step 7.3: Commit**

```bash
git add .claude/skills/add-finance/cron-jobs.json
git commit -m "feat(finance): cron-jobs.json kind 'scheduled' -> 'task'"
```

---

### Task 8: Fix tool-slug drift in `system-prompt.md`

**Files:**
- Modify: `.claude/skills/add-finance/system-prompt.md`

- [ ] **Step 8.1: Read current state to confirm line numbers**

```bash
grep -n 'GOOGLESHEETS_' .claude/skills/add-finance/system-prompt.md
```

Expected output (3 lines):
```
150:2. Cheque com `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` se esse `id` existe na aba
183:Para `GOOGLESHEETS_BATCH_UPDATE`, sempre use `first_cell_location: "A<linha>"` e `values: [[<12 elementos>]]`.
241:- Desfazer = `GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER` na linha pelo `id`
```

If line numbers differ, adjust the next step accordingly.

- [ ] **Step 8.2: Replace the 2 outdated slugs**

Use the `Edit` tool with these exact replacements:

Replacement 1 (line 183):
- old_string: `` Para `GOOGLESHEETS_BATCH_UPDATE`, sempre use `first_cell_location: "A<linha>"` e `values: [[<12 elementos>]]`. ``
- new_string: `` Para `GOOGLESHEETS_UPDATE_VALUES_BATCH`, sempre passe `data` como array de `{range, values}` com `values: [[<12 elementos>]]` e `valueInputOption: "USER_ENTERED"`. ``

Replacement 2 (line 241):
- old_string: `` - Desfazer = `GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER` na linha pelo `id` ``
- new_string: `` - Desfazer = `GOOGLESHEETS_CLEAR_VALUES` na range exata da linha (use `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` para descobrir `row_index` pelo `id`, depois clear `range='Lançamentos-{escopo}!A{row_index}:L{row_index}'`) ``

- [ ] **Step 8.3: Verify no legacy slugs remain**

```bash
grep -E 'BATCH_UPDATE\b|BY_DATA_FILTER' .claude/skills/add-finance/system-prompt.md
```

Expected: empty output (no matches). `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` on line 150 stays.

- [ ] **Step 8.4: Commit**

```bash
git add .claude/skills/add-finance/system-prompt.md
git commit -m "fix(finance): system-prompt — canonical Composio slugs (Plan 2.5)"
```

---

### Task 9: Fix tool-slug drift in `claude-md-template.md`

**Files:**
- Modify: `.claude/skills/add-finance/claude-md-template.md`

- [ ] **Step 9.1: Read current state to confirm line numbers**

```bash
grep -n 'GOOGLESHEETS_' .claude/skills/add-finance/claude-md-template.md
```

Expected output (4 lines around 69-73):
```
69:- `GOOGLESHEETS_BATCH_UPDATE` (escrita em lote — preferir sempre que possível)
70:- `GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW` (busca por valor de coluna)
71:- `GOOGLESHEETS_INSERT_DIMENSION` + `GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER`
72:- `GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER` (apagar linha — usado por "desfazer")
73:- `GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER` (leituras)
```

- [ ] **Step 9.2: Replace the outdated lines**

Use the `Edit` tool with these exact replacements:

Replacement 1 (line 69):
- old_string: `` - `GOOGLESHEETS_BATCH_UPDATE` (escrita em lote — preferir sempre que possível) ``
- new_string: `` - `GOOGLESHEETS_UPDATE_VALUES_BATCH` (escrita em lote multi-range — preferir sempre que possível) ``

Replacement 2 (line 71):
- old_string: `` - `GOOGLESHEETS_INSERT_DIMENSION` + `GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER` ``
- new_string: `` - `GOOGLESHEETS_INSERT_DIMENSION` + `GOOGLESHEETS_UPDATE_VALUES_BATCH` (inserir linha vazia e depois preencher) ``

Replacement 3 (line 72):
- old_string: `` - `GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER` (apagar linha — usado por "desfazer") ``
- new_string: `` - `GOOGLESHEETS_CLEAR_VALUES` (apagar conteúdo de uma range específica — usado por "desfazer", informe a range A1 da linha exata) ``

Replacement 4 (line 73):
- old_string: `` - `GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER` (leituras) ``
- new_string: `` - `GOOGLESHEETS_VALUES_GET` (leitura de uma range A1) / `GOOGLESHEETS_BATCH_GET` (várias ranges em uma chamada) ``

- [ ] **Step 9.3: Verify no legacy slugs remain**

```bash
grep -E 'BATCH_UPDATE\b|BY_DATA_FILTER|GET_SPREADSHEET\b' .claude/skills/add-finance/claude-md-template.md
```

Expected: empty.

- [ ] **Step 9.4: Commit**

```bash
git add .claude/skills/add-finance/claude-md-template.md
git commit -m "fix(finance): claude-md-template — canonical Composio slugs (Plan 2.5)"
```

---

## Phase 2 — Script + tests

### Task 10: Update `register-cron-jobs.ts` for new transport

**Files:**
- Modify: `scripts/finance/register-cron-jobs.ts`

- [ ] **Step 10.1: Replace the file content**

Overwrite `scripts/finance/register-cron-jobs.ts` with:

```typescript
/**
 * Register the 5 finance cron jobs as recurring 'task' messages in the agent's session inbox.
 *
 * Usage:
 *   npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>
 *
 * The script:
 *   1. Reads cron-jobs.json (the 5 task definitions)
 *   2. Reads _override-block.md (shared non-interactive instructions)
 *   3. Reads each prompt file referenced by promptFile
 *   4. Builds content = JSON.stringify({prompt: <override>+<prompt>})
 *   5. Inserts each as a recurring row with kind='task' (idempotent via INSERT OR REPLACE)
 *
 * TODO(formatter-bug): the container's container/agent-runner/src/formatter.ts:80-105
 * has a generic silent-drop bug — any messages_in row with `kind` not in
 * (chat | chat-sdk | task | webhook | system) produces an empty prompt. We use
 * kind='task' here to piggyback the existing envelope, but a future plan should
 * either add a 'scheduled' / 'system_task' case to the formatter or document
 * the supported kinds at the schema level.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export interface RegisterOptions {
  inboundDbPath: string;
  configPath: string;
  promptsDir: string;
}

interface JobConfig {
  id: string;
  kind: string;
  recurrence: string;
  promptFile: string;
  firstRunOffsetMs: number;
}

export function registerCronJobs(opts: RegisterOptions): void {
  const config = JSON.parse(fs.readFileSync(opts.configPath, 'utf8')) as { jobs: JobConfig[] };
  const overridePath = path.join(opts.promptsDir, '_override-block.md');
  const overrideBlock = fs.readFileSync(overridePath, 'utf8');

  const db = new Database(opts.inboundDbPath);

  // Compute seq base — use even seq (per nextEvenSeq pattern from session-db.ts)
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  let seq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

  const now = Date.now();

  // SQLite-friendly UTC datetime: 'YYYY-MM-DD HH:MM:SS' (matches datetime('now')).
  // CRITICAL: do NOT use Date.toISOString() — 'T' > ' ' breaks process_after comparisons.
  const toSqliteUtc = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

  for (const job of config.jobs) {
    const procedural = fs.readFileSync(path.join(opts.promptsDir, job.promptFile), 'utf8');
    const prompt = overrideBlock + '\n\n' + procedural;
    const content = JSON.stringify({ prompt });

    const processAfter = toSqliteUtc(new Date(now + job.firstRunOffsetMs));
    const timestamp = toSqliteUtc(new Date());

    db.prepare(
      `INSERT OR REPLACE INTO messages_in
       (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content, process_after, recurrence)
       VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?, ?)`,
    ).run(job.id, seq, job.kind, timestamp, content, processAfter, job.recurrence);

    seq += 2;
  }

  db.close();
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const sessionIdx = args.indexOf('--session');
  if (sessionIdx === -1 || !args[sessionIdx + 1]) {
    console.error('Usage: npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>');
    process.exit(1);
  }
  const sessionId = args[sessionIdx + 1];

  const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', 'finance', sessionId, 'inbound.db');
  if (!fs.existsSync(inboundDbPath)) {
    console.error(`Inbound DB not found: ${inboundDbPath}`);
    console.error('Make sure the session exists. Run: sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id=\'finance\';"');
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), '.claude', 'skills', 'add-finance', 'cron-jobs.json');
  const promptsDir = path.join(process.cwd(), '.claude', 'skills', 'add-finance', 'prompts');

  registerCronJobs({ inboundDbPath, configPath, promptsDir });

  console.log(`✅ 5 cron jobs registered in ${inboundDbPath}`);
  console.log('   Verify: sqlite3 ' + inboundDbPath + ' "SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"');
}
```

- [ ] **Step 10.2: Verify the file parses**

```bash
npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext scripts/finance/register-cron-jobs.ts
```

Expected: exit 0, no output.

- [ ] **Step 10.3: Commit**

```bash
git add scripts/finance/register-cron-jobs.ts
git commit -m "feat(finance): register-cron-jobs — kind='task' + override-block injection (Plan 2.5)"
```

---

### Task 11: Update existing tests for new transport

**Files:**
- Modify: `scripts/finance/__tests__/register-cron-jobs.test.ts`

- [ ] **Step 11.1: Replace the file content**

Overwrite `scripts/finance/__tests__/register-cron-jobs.test.ts` with:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerCronJobs, type RegisterOptions } from '../register-cron-jobs';

describe('registerCronJobs', () => {
  let tmpDir: string;
  let inboundPath: string;
  let promptsDir: string;
  let opts: RegisterOptions;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finance-cron-'));
    inboundPath = path.join(tmpDir, 'inbound.db');

    // Create empty inbound.db with messages_in schema
    const db = new Database(inboundPath);
    db.exec(`
      CREATE TABLE messages_in (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        platform_id TEXT,
        channel_type TEXT,
        thread_id TEXT,
        content TEXT NOT NULL,
        process_after TEXT,
        recurrence TEXT
      );
    `);
    db.close();

    // Create prompt files (procedural markers used in T3 assertions)
    promptsDir = path.join(tmpDir, 'prompts');
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(
      path.join(promptsDir, '_override-block.md'),
      [
        '[SYSTEM TASK — NON-INTERACTIVE]',
        '',
        'Rule 1: NÃO cumprimente. NÃO peça confirmação. NÃO pergunte esclarecimento.',
        'Rule 2: NÃO mostre cards de confirmação.',
        'Rule 3: princípios de confirmação NÃO se aplicam.',
        'Rule 4: Output: <message to="jonas">…</message> ou <internal>silent run: …</internal>.',
        'Rule 5: SEMPRE registre 1 linha em `_Log!A:E`.',
        'Rule 6: Erro → log + <message ⚠️>.',
        'Rule 7: Não tente "recuperar criativamente".',
        '',
        '---',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(promptsDir, 'sweep-reminder.md'), '[CRON: finance-sweep]\n\n**Step 1 — Ler Lembretes**');
    fs.writeFileSync(path.join(promptsDir, 'daily-digest.md'), '[CRON: finance-daily]\n\n**Step 1 — Coletar dados**');
    fs.writeFileSync(path.join(promptsDir, 'weekly-closing.md'), '[CRON: finance-weekly]\n\n**Step 1 — Coletar dados**');
    fs.writeFileSync(path.join(promptsDir, 'monthly-closing.md'), '[CRON: finance-monthly]\n\n**Step 1 — Verificar se hoje é o último dia do mês**');
    fs.writeFileSync(path.join(promptsDir, 'rollover.md'), '[CRON: finance-rollover]\n\n**Step 1 — Ler Recorrentes**');

    // Create cron-jobs.json
    fs.writeFileSync(
      path.join(tmpDir, 'cron-jobs.json'),
      JSON.stringify({
        jobs: [
          { id: 'task-finance-sweep', kind: 'task', recurrence: '0 8-22 * * *', promptFile: 'sweep-reminder.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-daily', kind: 'task', recurrence: '0 8 * * *', promptFile: 'daily-digest.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-weekly', kind: 'task', recurrence: '0 19 * * 0', promptFile: 'weekly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-monthly', kind: 'task', recurrence: '0 21 28-31 * *', promptFile: 'monthly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-rollover', kind: 'task', recurrence: '30 0 1 * *', promptFile: 'rollover.md', firstRunOffsetMs: 60000 },
        ],
      }),
    );

    opts = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };
  });

  it('T1 schema — inserts 5 rows with kind=task and JSON content', () => {
    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const rows = db.prepare(
      "SELECT id, kind, recurrence, content, process_after FROM messages_in WHERE recurrence IS NOT NULL ORDER BY id",
    ).all() as Array<{ id: string; kind: string; recurrence: string; content: string; process_after: string }>;
    db.close();

    expect(rows).toHaveLength(5);
    expect(rows.map(r => r.id).sort()).toEqual([
      'task-finance-daily', 'task-finance-monthly', 'task-finance-rollover',
      'task-finance-sweep', 'task-finance-weekly',
    ]);
    for (const r of rows) {
      expect(r.kind).toBe('task');
      expect(() => JSON.parse(r.content)).not.toThrow();
      const parsed = JSON.parse(r.content);
      expect(typeof parsed.prompt).toBe('string');
      expect(parsed.prompt.length).toBeGreaterThan(0);
      // SQLite-friendly UTC format: 'YYYY-MM-DD HH:MM:SS'
      expect(r.process_after).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
    expect(rows.find(r => r.id === 'task-finance-sweep')!.recurrence).toBe('0 8-22 * * *');
    expect(rows.find(r => r.id === 'task-finance-daily')!.recurrence).toBe('0 8 * * *');
  });

  it('T2 override block — every prompt starts with the 7 rules', () => {
    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const rows = db.prepare("SELECT content FROM messages_in WHERE recurrence IS NOT NULL").all() as Array<{ content: string }>;
    db.close();

    for (const r of rows) {
      const prompt = JSON.parse(r.content).prompt as string;
      expect(prompt.startsWith('[SYSTEM TASK — NON-INTERACTIVE]')).toBe(true);
      // 7 enumerated rules from the override block
      expect(prompt).toContain('Rule 1');
      expect(prompt).toContain('Rule 7');
    }
  });

  it('T3 procedural prompt included — each job has its [CRON: …] header + a Step', () => {
    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const rows = db.prepare("SELECT id, content FROM messages_in WHERE recurrence IS NOT NULL").all() as Array<{ id: string; content: string }>;
    db.close();

    const cases: Array<[string, string, string]> = [
      ['task-finance-sweep', '[CRON: finance-sweep]', '**Step 1 — Ler Lembretes**'],
      ['task-finance-daily', '[CRON: finance-daily]', '**Step 1 — Coletar dados**'],
      ['task-finance-weekly', '[CRON: finance-weekly]', '**Step 1 — Coletar dados**'],
      ['task-finance-monthly', '[CRON: finance-monthly]', '**Step 1 — Verificar se hoje é o último dia do mês**'],
      ['task-finance-rollover', '[CRON: finance-rollover]', '**Step 1 — Ler Recorrentes**'],
    ];

    for (const [id, header, step] of cases) {
      const row = rows.find(r => r.id === id);
      expect(row, `missing row ${id}`).toBeDefined();
      const prompt = JSON.parse(row!.content).prompt as string;
      expect(prompt).toContain(header);
      expect(prompt).toContain(step);
    }
  });

  it('T4 idempotency — re-running keeps 5 rows, seq stable per id, process_after refreshed', () => {
    registerCronJobs(opts);

    const db1 = new Database(inboundPath, { readonly: true });
    const first = db1.prepare("SELECT id, seq, process_after FROM messages_in WHERE recurrence IS NOT NULL ORDER BY id").all() as Array<{ id: string; seq: number; process_after: string }>;
    db1.close();

    // Wait > 1 sec so process_after differs noticeably on second run
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
    return sleep(1100).then(() => {
      registerCronJobs(opts);

      const db2 = new Database(inboundPath, { readonly: true });
      const second = db2.prepare("SELECT id, seq, process_after FROM messages_in WHERE recurrence IS NOT NULL ORDER BY id").all() as Array<{ id: string; seq: number; process_after: string }>;
      const count = (db2.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE recurrence IS NOT NULL").get() as { c: number }).c;
      db2.close();

      expect(count).toBe(5);
      expect(second).toHaveLength(5);
      // Same seq values (INSERT OR REPLACE preserves PK row identity but resets columns;
      // the script recomputes seq from MAX(seq), and on a re-run the max is the last seq
      // from the prior insert, so seq grows. Assert it's monotonic & spaced by 2.)
      for (let i = 1; i < second.length; i++) {
        expect(second[i].seq - second[i - 1].seq).toBe(2);
      }
      // process_after refreshed (later than first run)
      for (const row of second) {
        const firstRow = first.find(f => f.id === row.id)!;
        expect(row.process_after >= firstRow.process_after).toBe(true);
      }
    });
  });
});
```

- [ ] **Step 11.2: Run failing tests (the new file shapes mismatch the prior implementation if Task 10 wasn't done; assuming Task 10 already done, all 4 should pass)**

```bash
npx vitest run scripts/finance/__tests__/register-cron-jobs.test.ts
```

Expected: 4 pass, 0 fail.

If any test fails: read the diff, fix the script (Task 10) or the test, re-run.

- [ ] **Step 11.3: Commit**

```bash
git add scripts/finance/__tests__/register-cron-jobs.test.ts
git commit -m "test(finance): register-cron-jobs — 4 tests for kind='task' transport (Plan 2.5)"
```

---

### Task 12: Drop stale `'scheduled'` from `unregister-cron-jobs.ts` comments

**Files:**
- Modify: `scripts/finance/unregister-cron-jobs.ts`

- [ ] **Step 12.1: Check whether stale references exist**

```bash
grep -n "scheduled" scripts/finance/unregister-cron-jobs.ts
```

If output is empty → no change needed. Skip to Step 12.3. If lines appear, they're stale references — edit them.

- [ ] **Step 12.2 (conditional, only if stale references found): Edit**

Use the `Edit` tool to remove or update any `'scheduled'` mentions in comments. The deletion logic is by id only and does not change.

- [ ] **Step 12.3: Verify the script still parses + deletes correctly**

```bash
npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext scripts/finance/unregister-cron-jobs.ts
```

Expected: exit 0.

- [ ] **Step 12.4: Commit (only if changes made)**

```bash
git add scripts/finance/unregister-cron-jobs.ts
git commit -m "chore(finance): unregister-cron-jobs — drop stale 'scheduled' refs"
```

If no changes: skip the commit.

---

## Phase 3 — SKILL.md install playbook updates

### Task 13: Update SKILL.md with Plan 2.5 verification + upgrade path

**Files:**
- Modify: `.claude/skills/add-finance/SKILL.md`

- [ ] **Step 13.1: Find Step 9.5 and the "Upgrade from Plan 1?" section**

```bash
grep -n 'Step 9.5\|Upgrade from Plan 1' .claude/skills/add-finance/SKILL.md
```

Expected: line refs for both. Record them.

- [ ] **Step 13.2: Update Step 9.5 verification command**

Find the verification block under Step 9.5 (it currently reads `SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;`). Update to assert `kind='task'`:

Use the `Edit` tool with:

- old_string: `` Expected: 5 rows with ids `task-finance-sweep|daily|weekly|monthly|rollover` and matching cron expressions. ``
- new_string: `` Expected: 5 rows with ids `task-finance-sweep|daily|weekly|monthly|rollover`, all with `kind='task'` (not `scheduled`), and matching cron expressions. ``

If the exact text differs, adjust the `old_string` to match what's actually in the file.

- [ ] **Step 13.3: Replace "Upgrade from Plan 1?" with "Upgrade from Plan 1 or Plan 2"**

Find the existing upgrade section. Use the `Edit` tool:

- old_string: `` ## Upgrade from Plan 1?

If `/add-finance` was already run (Plan 1) and the workbook + agent are working, **don't re-run this whole skill**. Instead:

1. Pull latest skill files (`git pull` to get Plan 2 templates)
2. Copy `.claude/skills/add-finance/system-prompt.md` to `groups/finance/system-prompt.md` (replaces the Plan 1 prompt with the new intents)
3. Operator pastes `migration-prompt.md` content into `@<bot>Bot` to apply schema changes to the existing sheet
4. Run `scripts/finance/register-cron-jobs.ts` to register the 5 cron jobs

Skip the whole "create agent group / bot / sheet" flow. ``

- new_string: `` ## Upgrade from previous Plan?

If `/add-finance` was already run (Plan 1 or Plan 2) and the workbook + agent are working, **don't re-run this whole skill**. Instead:

### From Plan 1 → current
1. `git pull` to get the latest skill templates.
2. Copy `.claude/skills/add-finance/system-prompt.md` to `groups/finance/system-prompt.md`.
3. Operator pastes `migration-prompt.md` content into `@<bot>Bot` to apply Plan 2 schema changes to the existing sheet (3 new tabs + 3 new columns in Lançamentos).
4. Operator confirms the `_Log` tab exists; if not, ask the bot to create it with headers `[timestamp, job, status, qtd_processada, detalhes]`.
5. Run `scripts/finance/unregister-cron-jobs.ts` then `scripts/finance/register-cron-jobs.ts` to install the 5 cron jobs (now with `kind='task'` + override block, Plan 2.5).
6. In Telegram, send `/clear` to the bot so it reloads the updated `system-prompt.md` + `CLAUDE.md`.

### From Plan 2 → Plan 2.5 only
1. `git pull`.
2. Confirm the `_Log` tab exists (Plan 2 should have created it).
3. In `groups/finance/CLAUDE.md`, replace the 4 outdated tool slugs (lines around 69-73): `GOOGLESHEETS_BATCH_UPDATE` → `GOOGLESHEETS_UPDATE_VALUES_BATCH`; `GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER` → `GOOGLESHEETS_UPDATE_VALUES_BATCH`; `GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER` → `GOOGLESHEETS_CLEAR_VALUES`; `GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER` → `GOOGLESHEETS_VALUES_GET`.
4. `cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md` (full overwrite — the live file is a mirror, not a customization).
5. Run `scripts/finance/unregister-cron-jobs.ts` then `scripts/finance/register-cron-jobs.ts` to replace the 5 `kind='scheduled'` rows with `kind='task'` rows.
6. In Telegram, send `/clear` to the bot.

Skip the whole "create agent group / bot / sheet" flow. ``

- [ ] **Step 13.4: Verify**

```bash
grep -n 'kind=.task.' .claude/skills/add-finance/SKILL.md
grep -n 'From Plan 2 → Plan 2.5' .claude/skills/add-finance/SKILL.md
```

Both should match.

- [ ] **Step 13.5: Commit**

```bash
git add .claude/skills/add-finance/SKILL.md
git commit -m "docs(finance): SKILL.md — Plan 2.5 verify kind='task' + upgrade path"
```

---

## Phase 4 — Operator migration on the live agent

This phase is operator-executed against the running Levis. Each step is a manual action; the agent CANNOT do this itself.

### Task 14: Operator applies skill template updates to live workspace

**Pre-req:** the operator has already run `git pull` (or pulled this branch into the running install).

- [ ] **Step 14.1: Mirror updated system-prompt.md to live workspace**

Operator runs:

```bash
cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md
```

- [ ] **Step 14.2: Patch live CLAUDE.md tool list in place**

Operator opens `groups/finance/CLAUDE.md` and replaces the 4 outdated slug lines (around lines 69-73) using these exact substitutions:

```bash
# in-place edit: 4 substitutions
sed -i \
  -e 's/`GOOGLESHEETS_BATCH_UPDATE`/`GOOGLESHEETS_UPDATE_VALUES_BATCH`/g' \
  -e 's/`GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER`/`GOOGLESHEETS_UPDATE_VALUES_BATCH`/g' \
  -e 's/`GOOGLESHEETS_BATCH_CLEAR_VALUES_BY_DATA_FILTER`/`GOOGLESHEETS_CLEAR_VALUES`/g' \
  -e 's/`GOOGLESHEETS_GET_SPREADSHEET_BY_DATA_FILTER`/`GOOGLESHEETS_VALUES_GET`/g' \
  groups/finance/CLAUDE.md
```

- [ ] **Step 14.3: Verify drift gone**

```bash
grep -E 'BATCH_UPDATE\b|BY_DATA_FILTER|GET_SPREADSHEET\b' groups/finance/CLAUDE.md groups/finance/system-prompt.md
```

Expected: empty.

---

### Task 15: Operator verifies `_Log` tab exists

**Pre-req:** the operator has access to the bot via Telegram.

- [ ] **Step 15.1: Ask Levis to confirm `_Log` exists**

Operator sends to `@LevisBot`:

```
Levis, lê os nomes das abas do workbook. A aba `_Log` existe? Se sim, mostra os headers da linha 1.
```

Expected response: yes, `_Log` exists with headers `[timestamp, job, status, qtd_processada, detalhes]`.

- [ ] **Step 15.2: If `_Log` missing, ask Levis to create it**

If Step 15.1 returns "não existe", operator sends:

```
Levis, cria a aba `_Log` com headers na linha 1: timestamp, job, status, qtd_processada, detalhes. Aplica bold + frozen na linha 1.
```

Expected: confirmation that the tab was created.

---

### Task 16: Operator unregisters old crons + registers new ones

**Pre-req:** the operator knows the finance session id.

- [ ] **Step 16.1: Find the session id**

Operator runs:

```bash
sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='finance' ORDER BY created_at DESC LIMIT 1;"
```

Record the returned session id; call it `<id>` below.

- [ ] **Step 16.2: Unregister the 5 Plan 2 cron rows**

Operator runs:

```bash
npx tsx scripts/finance/unregister-cron-jobs.ts --session <id>
```

Expected: `✅ Removed 5 cron task(s) from data/v2-sessions/finance/<id>/inbound.db`.

- [ ] **Step 16.3: Register the 5 new Plan 2.5 cron rows**

Operator runs:

```bash
npx tsx scripts/finance/register-cron-jobs.ts --session <id>
```

Expected: `✅ 5 cron jobs registered in data/v2-sessions/finance/<id>/inbound.db`.

- [ ] **Step 16.4: Verify the new rows have kind='task' + JSON content**

Operator runs:

```bash
sqlite3 "data/v2-sessions/finance/<id>/inbound.db" \
  "SELECT id, kind, substr(content, 1, 40) FROM messages_in WHERE recurrence IS NOT NULL;"
```

Expected: 5 rows; `kind` column = `task`; content starts with `{"prompt":"[SYSTEM TASK`.

---

### Task 17: Operator clears the live session

- [ ] **Step 17.1: Send `/clear` to the bot via Telegram**

Operator sends `/clear` to `@LevisBot`. Expected reply: `Session cleared.`.

This forces the agent to drop its prior continuation and reload `system-prompt.md` + `CLAUDE.md` on the next message.

---

## Phase 5 — Smoke + acceptance

### Task 18: Smoke S1 — sweep silent (0 reminders)

- [ ] **Step 18.1: Trigger sweep manually**

Operator runs (replace `<id>` with the session id from Task 16):

```bash
sqlite3 "data/v2-sessions/finance/<id>/inbound.db" \
  "UPDATE messages_in SET process_after=datetime('now','-2 minutes'), status='pending' WHERE id='task-finance-sweep';"
```

- [ ] **Step 18.2: Wait 90s**

Operator waits ~90 seconds for host-sweep to detect, wake the container, and the agent to execute.

- [ ] **Step 18.3: Verify Telegram silent**

Confirm `@LevisBot` did NOT send a message after the trigger. If it sent any text (e.g. "Pode mandar!" or "🔔 Lembrete: …"), S1 fails — record the exact text in the smoke report and STOP (do not proceed to Task 19).

- [ ] **Step 18.4: Verify `_Log` row**

Operator asks Levis on Telegram:

```
Levis, lê as últimas 3 linhas de `_Log`.
```

Expected: one row matching `[<recent ISO ts>, "finance-sweep", "success", 0, ""]`. If absent → S1 fails: agent might have ignored the override block. Record + STOP.

- [ ] **Step 18.5: Verify the row was marked completed + respawned**

```bash
sqlite3 "data/v2-sessions/finance/<id>/inbound.db" \
  "SELECT id, status, datetime(process_after) FROM messages_in WHERE id LIKE 'task-finance-sweep%' ORDER BY rowid DESC LIMIT 5;"
```

Expected: at least 1 row with `status='completed'` (the one we triggered) and 1 new pending row with a future `process_after` (~next hour 0).

- [ ] **Step 18.6: Mark S1**

Record `S1: ✅` or `S1: ❌ <reason>` in the smoke report.

---

### Task 19: Smoke S3 — daily-digest formatted

- [ ] **Step 19.1: Trigger daily-digest manually**

```bash
sqlite3 "data/v2-sessions/finance/<id>/inbound.db" \
  "UPDATE messages_in SET process_after=datetime('now','-2 minutes'), status='pending' WHERE id='task-finance-daily';"
```

- [ ] **Step 19.2: Wait 90s**

- [ ] **Step 19.3: Verify Telegram delivery**

Telegram should receive 1 message matching the daily-digest molde from Task 3 (headers `☀️ Bom dia, Jonas!`, `📊 Ontem`, `📅 Próximos 7 dias`, `💰 Saldos PF`, etc), OR the short version (`☀️ Tudo quieto …`) if there's no activity. NOT a casual "Pode mandar!".

- [ ] **Step 19.4: Verify `_Log` row**

Ask Levis: `Levis, lê as últimas 3 linhas de _Log.` Expected: row `[ts, "finance-daily", "success", <N>, ""]`.

- [ ] **Step 19.5: Mark S3**

Record `S3: ✅` or `S3: ❌ <reason>`.

---

### Task 20 (optional): Smoke S2 — sweep with 1 reminder vencido

This is optional but recommended to verify Step 3 of `sweep-reminder.md` (actual reminder emission) works end-to-end. If S1 + S3 already passed, you can defer S2 to a later sanity check.

- [ ] **Step 20.1: Insert a vencido reminder**

Operator asks Levis on Telegram:

```
Levis, insere uma linha em `Lembretes`:
- id: `lem-smoke-001`
- quando: data/hora 5 min no passado (ISO)
- mensagem: Teste smoke S2 — sweep com 1 vencido
- linhagem: manual:smoke
- enviado_em: (vazio)
```

- [ ] **Step 20.2: Trigger sweep**

Same as Task 18.1.

- [ ] **Step 20.3: Wait 90s + verify**

Expected:
- Telegram receives exactly: `🔔 Lembrete: Teste smoke S2 — sweep com 1 vencido`
- The `Lembretes` row's `enviado_em` is now filled with an ISO timestamp
- `_Log` row: `[ts, "finance-sweep", "success", 1, ""]`

- [ ] **Step 20.4: Cleanup**

Operator asks Levis to delete the smoke row:

```
Levis, apaga a linha em Lembretes com id = lem-smoke-001.
```

- [ ] **Step 20.5: Mark S2**

Record `S2: ✅` or `S2: ❌`.

---

### Task 21 (optional): Smoke S4 — failure mode (`_Log` missing)

Optional — exercises the error path.

- [ ] **Step 21.1: Temporarily rename `_Log`**

Operator asks Levis:

```
Levis, renomeia a aba `_Log` pra `_LogX` temporariamente. Não escreva nada nela.
```

- [ ] **Step 21.2: Trigger sweep**

Same as Task 18.1.

- [ ] **Step 21.3: Wait 90s + verify**

Expected: Telegram receives `⚠️ Cron finance-sweep: <error>` (some error mentioning `_Log` not found or 400 parse range). NOT a casual response.

- [ ] **Step 21.4: Restore `_Log`**

Operator asks Levis:

```
Levis, renomeia `_LogX` de volta pra `_Log`.
```

- [ ] **Step 21.5: Mark S4**

Record `S4: ✅` or `S4: ❌`.

---

### Task 22: Final code review + Plan 2.5 wrap

- [ ] **Step 22.1: Dispatch code reviewer subagent (optional)**

Use the Agent tool with subagent_type=Explore (or general-purpose) with this prompt:

```
Review Plan 2.5's code changes against the spec at
docs/superpowers/specs/2026-05-12-finance-cron-execution-design.md.

Focus on:
- Does scripts/finance/register-cron-jobs.ts correctly inject the override
  block, set kind='task', and write JSON content?
- Are the 5 prompts in .claude/skills/add-finance/prompts/ procedural
  (Step N — Tool format) and using canonical Composio slugs?
- Are system-prompt.md and claude-md-template.md free of the 4 legacy
  Composio slugs?
- Does the inline TODO in register-cron-jobs.ts mention
  container/agent-runner/src/formatter.ts:80-105?

Report findings as a punch list of issues. Be concise.
```

- [ ] **Step 22.2: Address findings**

For each finding from Step 22.1, decide: (a) fix now (inline edits + commits), or (b) defer to Plan 2.6 (record in a new "Plan 2.5 — known issues" section at the bottom of the spec).

- [ ] **Step 22.3: Update plan completion**

In this file (the plan), mark each `- [ ]` in the Acceptance checklist (below) as `- [x]` for items confirmed passing.

- [ ] **Step 22.4: Commit Plan 2.5 closeout**

```bash
git add docs/superpowers/plans/2026-05-12-finance-agent-plan-2-5-cron-execution.md
git commit -m "chore(plans): mark Plan 2.5 complete"
```

---

## Acceptance criteria

- [ ] vitest green: 4 tests in `scripts/finance/__tests__/register-cron-jobs.test.ts` (T1 schema, T2 override block, T3 procedural prompt, T4 idempotency)
- [ ] 5 rows in `data/v2-sessions/finance/<id>/inbound.db` with `kind='task'` and JSON content starting with `{"prompt":"[SYSTEM TASK`
- [ ] No legacy slugs (`BATCH_UPDATE`, `*_BY_DATA_FILTER`, `GET_SPREADSHEET_BY_DATA_FILTER`) anywhere in `.claude/skills/add-finance/system-prompt.md`, `.claude/skills/add-finance/claude-md-template.md`, `groups/finance/CLAUDE.md`, or `groups/finance/system-prompt.md`
- [ ] `_Log` tab exists in live workbook with correct headers
- [ ] S1 passes (sweep silent, `_Log` row appended, recurrence respawn)
- [ ] S3 passes (daily-digest formatted, `_Log` row appended)
- [ ] "Tasks automáticos (CRON)" section in `system-prompt.md` (from commit `a0925dd`) preserved verbatim
- [ ] TODO comment in `scripts/finance/register-cron-jobs.ts` references `container/agent-runner/src/formatter.ts:80-105`
- [ ] (optional) S2 passes
- [ ] (optional) S4 passes

---

## Troubleshooting

- **Cron didn't fire?** First check host-sweep is running (look for `Host sweep started` in service logs). Then check that the cron row's `process_after` is in the past: `sqlite3 inbound.db "SELECT id, datetime(process_after), datetime('now') FROM messages_in WHERE id='task-finance-sweep';"`.
- **Agent answered casually anyway after Plan 2.5?** Defense-in-depth failed at all 3 layers. Pull `_Log` — if no row, the agent never reached Step 5. Read `data/v2-sessions/finance/<id>/<provider>.jsonl` (or stderr container logs) to see the exact prompt the SDK received. If the override block is there but ignored, escalate to Plan 2.6: generic `kind='system_task'` in formatter with poll-loop prompt-override.
- **Vitest can't open `:memory:`?** This plan uses a tempdir-based DB, not `:memory:`. If the test file errors with `unable to open database file`, check `os.tmpdir()` writability.
- **`_Log` rows appearing twice per tick?** The recurrence respawn ran while the original was still processing. Check `host-sweep.ts handleRecurrence()` only fires for completed rows; if it's firing on `processing`, that's a host bug (out of Plan 2.5 scope).
- **Tool slugs still wrong after Phase 4?** The live agent is reading from its container's session continuation (which has its own message history). `/clear` (Task 17) is mandatory to force a fresh load of `system-prompt.md` and `CLAUDE.md`.
