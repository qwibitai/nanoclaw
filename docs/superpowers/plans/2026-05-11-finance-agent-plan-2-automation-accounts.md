# Finance Agent — Plan 2: Automation + Accounts + Receivables + Interaction

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the running Levis (`finance`) agent with: (a) account-and-balance tracking, (b) future receivables, (c) image-receipt parsing, (d) 5 cron jobs for digests + lembretes sweep + monthly rollover, (e) install-playbook polish that captures lessons from Plan 1 install rehearsal. End state: Levis tracks real balances across 6 accounts, alerts on incoming receivables, parses receipts from iPhone photos, sends daily/weekly/monthly digests automatically, and a fresh `/add-finance` run produces a clean install with no manual patching.

**Architecture:** Schema-first — extend Lançamentos columns + add 3 tabs (`Contas`, `MeiosPagamento`, `Recebiveis`) via in-place migration on the live sheet. Cron via v2 native pattern: recurring messages in `inbound.db` with `recurrence` cron expression; host-sweep auto-respawns next occurrence after completion. Image receipts hook into existing `add-image-vision` infra; system-prompt teaches the agent to OCR-read receipts and pre-fill `registrar_despesa`.

**Tech Stack:** TypeScript (NanoClaw v2), `insertTask` from `src/db/session-db.ts`, `cron-parser` (already a dep), Composio googlesheets MCP, `sharp` host-side resize (already installed), Whisper transcription (already wired in `src/transcription.ts`).

**Spec:** Plan 1 spec + this plan extends scope to include accounts/receivables/cron/receipt-parsing.

---

## File Structure

### Skill template files — updated/added in this plan

```
.claude/skills/add-finance/
├── SKILL.md                          # MODIFY: add new install steps (cron registration, migration for upgrades)
├── system-prompt.md                  # MODIFY: 4 new intents (cadastrar_conta, cadastrar_recebivel,
│                                     #         confirmar_recebivel, processar_comprovante),
│                                     #         update registrar_despesa/receita to require conta+meio
├── bootstrap-sheet-prompt.md         # MODIFY: 3 new tabs (Contas, MeiosPagamento, Recebiveis),
│                                     #         3 new cols in Lançamentos, seed accounts
├── migration-prompt.md (NEW)         # for in-place migration of an existing Plan 1 sheet
├── cron-jobs.json (NEW)              # 5 cron task definitions
└── prompts/                          # NEW directory
    ├── sweep-reminder.md             # hourly 08-22h — check Lembretes due now
    ├── daily-digest.md               # 08:00 — yesterday + today + 7d ahead
    ├── weekly-closing.md             # sun 19:00 — week summary
    ├── monthly-closing.md            # last day of month 21:00 — month summary
    └── rollover.md                   # day 1 00:30 — reset pago_no_mes, materialize recorrentes into Lembretes
```

### Scripts — added in this plan

```
scripts/finance/                      # NEW directory (was cleaned in Plan 1)
├── register-cron-jobs.ts             # inserts 5 recurring task rows into finance session inbox
└── unregister-cron-jobs.ts           # removes them (for testing/teardown)

scripts/finance/__tests__/
└── register-cron-jobs.test.ts        # vitest — insert + query + assert
```

### Live runtime files — updated by the operator running migration

```
groups/finance/                       # gitignored; updated in-place
├── CLAUDE.md                         # ADD: Contas schema, MeiosPagamento schema, Recebiveis schema
└── system-prompt.md                  # MIRROR of skill template, copied during install
```

### What's NOT in this plan (out of scope)

- Plaid / Pluggy / Open Finance auto-import — manual entry only
- Investment/brokerage tracking — not a Sheet's job
- Multi-currency — BRL only
- Credit card statement reconciliation — model is "despesa imediata na data da compra" (per user choice)
- Tax / Receita Federal integration

---

## Naming and IDs

- Cron task IDs: `task-finance-sweep`, `task-finance-daily`, `task-finance-weekly`, `task-finance-monthly`, `task-finance-rollover`
- Recurrence (cron): `0 8-22 * * *` (sweep), `0 8 * * *` (daily), `0 19 * * 0` (weekly), `0 21 28-31 * *` + day-of-month check in prompt (monthly), `30 0 1 * *` (rollover)
- New account types in `Contas`: `BTG D` (PF), `Inter` (PF), `Next` (PF), `BTG` (PJ), `Hotmart` (PJ), `C6` (PJ)
- New `MeiosPagamento`: `PIX`, `Boleto`, `Dinheiro`, `Cartão C1` (Hotmart), `Cartão C2` (Hotmart), `Cartão C3` (Hotmart)

---

## Phase 1 — Schema files

### Task 1: Extend system-prompt with 4 new intents + conta/meio in existing

**Files:**
- Modify: `.claude/skills/add-finance/system-prompt.md`
- Mirror to live: `groups/finance/system-prompt.md` (operator handles in Phase 3)

- [ ] **Step 1.1: Read current state**

```bash
wc -l .claude/skills/add-finance/system-prompt.md
```

Expected: ~133 lines (Plan 1 final state with sugerir_economias, analise_inteligente, marcar_pago+recorrente_id).

- [ ] **Step 1.2: Update the intent table — add 4 rows + modify 2**

In the intents table (around line 17-30), modify and append. The full new intents table should be:

```markdown
| Intent | Sinais | Ação |
|---|---|---|
| `registrar_despesa` | "gastei X", "paguei X em Y", "comprei", "saiu" | Card de confirmação com `conta_origem` E `meio_pagamento` → linha em `Lançamentos-{escopo}` (preenche cols `conta_origem` e `meio_pagamento`) |
| `registrar_receita` | "recebi X", "entrou X", "caiu X" | Card com `conta_destino` → linha em `Lançamentos-{escopo}` (preenche col `conta_destino`) |
| `cadastrar_conta` | "criar conta X", "adicionar conta Y PF/PJ", "nova conta" | Card → linha em `Contas` com nome, escopo, saldo_inicial=0 (ou valor informado) |
| `cadastrar_recorrente` | "todo mês", "mensal", "fixo", "todo dia X" | Card → linha em `Recorrentes` |
| `cadastrar_recebivel` | "vai entrar X dia Y", "vou receber Z de W", "esperando R$..." | Card → linha em `Recebiveis` com descricao, valor, conta_destino, data_prevista, status='esperado' |
| `confirmar_recebivel` | "caiu o pagamento da X", "recebi da Hotmart" + recebível pendente conhecido | Card → marca `Recebiveis[X].status='recebido'` + `recebido_em=NOW()` + cria `Lançamento` receita correspondente |
| `marcar_pago` | "paguei o X" (referindo a um recorrente conhecido) | Card → seta `Recorrentes[X].pago_no_mes=TRUE` + cria `Lançamento` com `origem='recorrente'` E `recorrente_id=<id do recorrente>` E `conta_origem` E `meio_pagamento` |
| `agendar_lembrete` | "me lembra dia X", "me avisa quando" | Card → linha em `Lembretes` com `quando=<timestamp ISO>`, `mensagem`, `linhagem='manual:user'` |
| `consulta` | "quanto gastei em X?", "qual meu saldo?", "saldo BTG", "lista os fixos" | Lê sheet (incluindo `Contas.saldo_atual` quando perguntado por saldo), responde, **não escreve** |
| `sugerir_economias` | "onde economizar?", "cortar gastos", "tô gastando muito" | Lê últimos 30-90d, agrega por categoria, sugere 2-4 cortes específicos. **Não escreve**. |
| `analise_inteligente` | "analisa meu mês", "como tô financeiramente?", "tendências" | Lê sheet, gera narrative report (receitas vs despesas, top cats, MoM, alertas, projeção fim de mês, saldos por conta). **Não escreve**. |
| `processar_comprovante` | (mensagem com **imagem** anexada) | Roda OCR mental no recibo, extrai valor/data/merchant/sugestão de categoria → trata como `registrar_despesa` com pre-fill. Card de confirmação |
| `definir_orcamento` | "limite X em Y", "orçamento de X pra Y" | Card → upsert em `Orçamento` |
| `editar_lancamento` | "muda o último X pra Y", "corrige o último" | Card → update por `id` |
| `desfazer` | "desfaz", "cancela", "apaga o último" | Apaga última linha gravada **nesta sessão** (não pode desfazer de sessão anterior) |
```

- [ ] **Step 1.3: Update the confirmation card formats**

Find the "Card de confirmação (formato)" section. Add `conta` and `meio_pagamento` lines to despesa/receita card. Replace the existing `registrar_despesa`/`receita` block with:

````markdown
Para `registrar_despesa`:

```
📝 Confirma?
💸 Despesa {PF ou PJ} — R$ {valor}
📅 {dd/mm} ({hoje|ontem|dia da semana})
🏷️ {categoria}
🏦 {conta_origem} ({meio_pagamento})
📝 {descricao}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```

Para `registrar_receita`:

```
📝 Confirma?
💰 Receita {PF ou PJ} — R$ {valor}
📅 {dd/mm}
🏷️ {categoria}
🏦 {conta_destino}
📝 {descricao}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```
````

- [ ] **Step 1.4: Add new card formats for new intents**

After the `marcar_pago` card section, add:

````markdown
Para `cadastrar_conta`:

```
📝 Confirmar nova conta?
🏦 {nome} ({PF ou PJ})
💰 Saldo inicial: R$ {valor}
[✓ Sim]  [❌ Cancelar]
```

Para `cadastrar_recebivel`:

```
📝 Confirmar recebível futuro?
💰 R$ {valor} de {origem}
📅 {data_prevista}
🏦 Cai em: {conta_destino}
📝 {descricao}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```

Para `confirmar_recebivel`:

```
📝 Confirmar recebimento?
✅ {descricao} — R$ {valor}
🏦 {conta_destino}
Vai marcar Recebível como recebido + lançar receita.
[✓ Sim]  [❌ Cancelar]
```

Para `processar_comprovante` (após OCR):

```
📝 É despesa? Extraí do comprovante:
💸 Despesa {PF ou PJ} — R$ {valor extraído}
📅 {data extraída ou hoje}
🏷️ {categoria sugerida}
🏦 {conta_origem ?} ({meio_pagamento ?})
📝 {merchant extraído}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```

Se faltar `conta_origem` ou `meio_pagamento` na imagem (raramente um recibo diz isso), PERGUNTE antes do card final.
````

- [ ] **Step 1.5: Add new ambiguity resolution rules**

Find the "Resolução de ambiguidades" table. Add these rows at the end:

```markdown
| conta não especificada em despesa/receita | "Qual conta? **BTG D / Inter / Next**" (lista as do escopo) |
| meio de pagamento não especificado em despesa | "Como pagou? **PIX / Cartão C1 / Boleto / Dinheiro**" |
| recebível com conta destino ambígua | "Vai cair em qual conta?" |
| imagem recebida não parece comprovante | "É comprovante de despesa, ou outra coisa?" (não chute) |
```

- [ ] **Step 1.6: Add section on receipt parsing (after Idempotência section)**

Add new section:

````markdown
## Comprovantes (imagens)

Quando chegar uma imagem:

1. **Classifica:** é recibo / nota fiscal / fatura / comprovante PIX? Ou é outra coisa (screenshot de chat, foto de paisagem)? Se for "outra coisa", pergunta: "É comprovante de despesa, ou outra coisa?"

2. **Se for comprovante:**
   - Procura **valor total** (palavras "TOTAL", "Total a pagar", "Valor pago", ou o maior número formatado como BRL)
   - Procura **data** (formato `dd/mm/yyyy` ou `dd/mm/yy`; se não achar, usa `hoje`)
   - Procura **merchant** (header da nota, nome do estabelecimento)
   - Sugere **categoria** baseada no merchant (ex: "iFood" → Alimentação, "Uber" → Transporte)
   - **Não chute conta_origem nem meio_pagamento** — pergunte ao user (a maioria dos recibos não traz essa info)

3. **Card de confirmação:** mostre os campos extraídos + os 2 perguntados (conta + meio). Use formato `processar_comprovante` acima.

4. **Confiança baixa em algum campo?** Marca com `?` no card e enfatiza no texto ("Não tenho certeza do valor — confirme: R$ X?").

5. **Múltiplos comprovantes na mesma mensagem?** Processa um por vez, com 1 card por imagem.
````

- [ ] **Step 1.7: Verify line count**

```bash
wc -l .claude/skills/add-finance/system-prompt.md
```

Expected: 175–220 lines (grew from 133).

- [ ] **Step 1.8: Commit**

```bash
git add .claude/skills/add-finance/system-prompt.md
git commit -m "feat(finance): system-prompt — contas, meios, recebíveis, comprovantes (Plan 2 schema)"
```

---

### Task 2: Extend bootstrap-sheet-prompt with 3 new tabs + 3 new columns

**Files:**
- Modify: `.claude/skills/add-finance/bootstrap-sheet-prompt.md`

- [ ] **Step 2.1: Add tabs to Passo 3**

Find "Passo 3 — Criar as 9 abas" — change to **12 abas**. Update the `addSheet` request list to include the 3 new tabs:

```json
[
  {"updateSheetProperties": {"properties": {"sheetId": 0, "title": "Dashboard"}, "fields": "title"}},
  {"addSheet": {"properties": {"title": "Lançamentos-PF"}}},
  {"addSheet": {"properties": {"title": "Lançamentos-PJ"}}},
  {"addSheet": {"properties": {"title": "Recorrentes"}}},
  {"addSheet": {"properties": {"title": "Orçamento"}}},
  {"addSheet": {"properties": {"title": "Projeção"}}},
  {"addSheet": {"properties": {"title": "Lembretes"}}},
  {"addSheet": {"properties": {"title": "Categorias"}}},
  {"addSheet": {"properties": {"title": "Contas"}}},
  {"addSheet": {"properties": {"title": "MeiosPagamento"}}},
  {"addSheet": {"properties": {"title": "Recebiveis"}}},
  {"addSheet": {"properties": {"title": "_Log"}}}
]
```

Update section header `## Passo 3 — Criar as 9 abas` → `## Passo 3 — Criar as 12 abas`.

- [ ] **Step 2.2: Update Passo 4 (headers) — add 3 columns to Lançamentos + 3 new tabs**

Replace the Lançamentos rows in the headers table:

| Aba | Range | Linha 1 |
|---|---|---|
| `Lançamentos-PF` | `A1:L1` | `id`, `data`, `tipo`, `valor`, `categoria`, `descricao`, `origem`, `recorrente_id`, `criado_em`, `conta_origem`, `conta_destino`, `meio_pagamento` |
| `Lançamentos-PJ` | `A1:L1` | (same) |

Add 3 new tabs to the headers section:

| Aba | Range | Linha 1 |
|---|---|---|
| `Contas` | `A1:F1` | `id`, `escopo`, `nome`, `saldo_inicial`, `saldo_atual`, `ativo` |
| `MeiosPagamento` | `A1:D1` | `id`, `nome`, `vinculado_a_conta`, `ativo` |
| `Recebiveis` | `A1:G1` | `id`, `descricao`, `valor`, `conta_destino`, `data_prevista`, `status`, `criado_em` |

- [ ] **Step 2.3: Add Passo 6 row for BRL on `Contas.saldo_inicial` and `saldo_atual`**

In Passo 6 (formatação numérica BRL), add `Contas` (cols D, E) and `Recebiveis` (col C) and `Recebiveis.data_prevista` (col E) as DATE format.

- [ ] **Step 2.4: Add Passo 7 dropdowns for new tabs**

In Passo 7 (data validation), add:

- **`Contas.escopo` (col B):** dropdown PF/PJ
- **`Contas.ativo` (col F):** checkbox
- **`MeiosPagamento.ativo` (col D):** checkbox
- **`Recebiveis.status` (col F):** dropdown ONE_OF_LIST `["esperado", "recebido", "atrasado", "cancelado"]`
- **`Lançamentos-{PF,PJ}.conta_origem` (col J):** dropdown ONE_OF_RANGE `=Contas!$C$2:$C` (nomes das contas)
- **`Lançamentos-{PF,PJ}.conta_destino` (col K):** dropdown ONE_OF_RANGE `=Contas!$C$2:$C`
- **`Lançamentos-{PF,PJ}.meio_pagamento` (col L):** dropdown ONE_OF_RANGE `=MeiosPagamento!$B$2:$B`

- [ ] **Step 2.5: Add Passo 8 formula for `Contas.saldo_atual`**

After the Projeção formulas section, add:

````markdown
### `Contas.saldo_atual` (col E, ROW 2 a 1000)

```
=ARRAYFORMULA(IF(C2:C1000="";"";
  D2:D1000
  + SUMIFS(IF(B2:B1000="PF";'Lançamentos-PF'!D:D;'Lançamentos-PJ'!D:D);
           IF(B2:B1000="PF";'Lançamentos-PF'!K:K;'Lançamentos-PJ'!K:K); C2:C1000;
           IF(B2:B1000="PF";'Lançamentos-PF'!C:C;'Lançamentos-PJ'!C:C); "receita")
  - SUMIFS(IF(B2:B1000="PF";'Lançamentos-PF'!D:D;'Lançamentos-PJ'!D:D);
           IF(B2:B1000="PF";'Lançamentos-PF'!J:J;'Lançamentos-PJ'!J:J); C2:C1000;
           IF(B2:B1000="PF";'Lançamentos-PF'!C:C;'Lançamentos-PJ'!C:C); "despesa")
))
```

**ARRAYFORMULA com IF condicional pra escopo PF/PJ.** Se complicar, faça per-row (NÃO use ARRAYFORMULA) — escreva fórmula simples por linha pra cada conta:

```
Linha 2 (assumindo PF):
=D2 + SUMIFS('Lançamentos-PF'!D:D; 'Lançamentos-PF'!K:K; C2; 'Lançamentos-PF'!C:C; "receita")
   - SUMIFS('Lançamentos-PF'!D:D; 'Lançamentos-PF'!J:J; C2; 'Lançamentos-PF'!C:C; "despesa")
```

⚠️ LOCALE pt-BR: separadores `;`, não `,`.
````

- [ ] **Step 2.6: Add Passo 11.5 — Seed Contas e MeiosPagamento**

After Passo 11 (seed Categorias), add Passo 11.5:

````markdown
## Passo 11.5 — Seed Contas e MeiosPagamento

### Contas (6 linhas em `Contas!A2:F7`)

```
[
  ["conta-btgd",    "PF", "BTG D",   0, "", true],
  ["conta-inter",   "PF", "Inter",   0, "", true],
  ["conta-next",    "PF", "Next",    0, "", true],
  ["conta-btg",     "PJ", "BTG",     0, "", true],
  ["conta-hotmart", "PJ", "Hotmart", 0, "", true],
  ["conta-c6",      "PJ", "C6",      0, "", true]
]
```

(`saldo_atual` = vazio — a fórmula do Passo 8 preenche automaticamente)

### MeiosPagamento (6 linhas em `MeiosPagamento!A2:D7`)

```
[
  ["mp-pix",      "PIX",        "",        true],
  ["mp-boleto",   "Boleto",     "",        true],
  ["mp-dinheiro", "Dinheiro",   "",        true],
  ["mp-c1",       "Cartão C1",  "Hotmart", true],
  ["mp-c2",       "Cartão C2",  "Hotmart", true],
  ["mp-c3",       "Cartão C3",  "Hotmart", true]
]
```
````

- [ ] **Step 2.7: Update Passo 9 (Dashboard) — add bloco de saldos**

In Passo 9, after the PJ KPIs block (A9), add Saldos block:

```markdown
| A11 | `Saldos PF` |
| A12 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PF' and Col2 is not null"; 0)` |
| A16 | `Saldos PJ` |
| A17 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PJ' and Col2 is not null"; 0)` |
```

⚠️ Inside QUERY string, `,` is the QUERY language — keep as `,`. Outside QUERY (between QUERY's arguments), use `;`.

(Renumber the rest of the Dashboard blocks if they conflict with rows 11-19 — adjust "Próximas contas" to start at A21, "Saldo projetado" to A28-A29.)

- [ ] **Step 2.8: Commit**

```bash
git add .claude/skills/add-finance/bootstrap-sheet-prompt.md
git commit -m "feat(finance): bootstrap-prompt — Contas, MeiosPagamento, Recebiveis + conta/meio em Lançamentos"
```

---

### Task 3: Write migration prompt for in-place upgrade of existing Plan 1 sheets

**Files:**
- Create: `.claude/skills/add-finance/migration-prompt.md`

This prompt is for operators upgrading from Plan 1 to Plan 2 — applies the schema changes to an existing sheet WITHOUT recreating it.

- [ ] **Step 3.1: Write the migration prompt**

`.claude/skills/add-finance/migration-prompt.md`:

````markdown
# Migration prompt — Plan 1 → Plan 2

(Operator: paste no @LevisBot apenas se voce já rodou o bootstrap Plan 1 e quer adicionar Contas/MeiosPagamento/Recebíveis sem perder dados existentes.)

---

Vou migrar a workbook atual de Plan 1 (9 abas) pra Plan 2 (12 abas + 3 cols extras em Lançamentos). PRESERVA todos os dados existentes (lançamentos, recorrentes, orçamento, categorias). Execute na ordem.

⚠️ **LOCALE pt-BR:** separadores `;`, decimal `,`. (Não `,` e `.`)

## Passo 1 — Adicionar 3 novas abas

`GOOGLESHEETS_BATCH_UPDATE`:

```json
{
  "spreadsheet_id": "<SHEET_ID>",
  "requests": [
    {"addSheet": {"properties": {"title": "Contas"}}},
    {"addSheet": {"properties": {"title": "MeiosPagamento"}}},
    {"addSheet": {"properties": {"title": "Recebiveis"}}}
  ]
}
```

Capture os 3 novos `sheetId`s.

## Passo 2 — Headers + formatting nas 3 abas novas

**Contas** (A1:F1): `id`, `escopo`, `nome`, `saldo_inicial`, `saldo_atual`, `ativo`
**MeiosPagamento** (A1:D1): `id`, `nome`, `vinculado_a_conta`, `ativo`
**Recebiveis** (A1:G1): `id`, `descricao`, `valor`, `conta_destino`, `data_prevista`, `status`, `criado_em`

Aplica para cada uma: bold + grey background + frozen row 1 (igual aos headers existentes).

Formatação BRL em `Contas` D:E e `Recebiveis` C. Formatação data em `Recebiveis` E.

## Passo 3 — Dropdowns nas 3 novas

- **`Contas.escopo`** (col B, rows 2-1000): ONE_OF_LIST `["PF", "PJ"]`
- **`Contas.ativo`** (col F): checkbox
- **`MeiosPagamento.ativo`** (col D): checkbox
- **`Recebiveis.status`** (col F): ONE_OF_LIST `["esperado", "recebido", "atrasado", "cancelado"]`

## Passo 4 — Seed Contas (6 linhas) e MeiosPagamento (6 linhas)

Em `Contas!A2:F7` (BATCH_UPDATE_VALUES, valueInputOption=USER_ENTERED):

```
[
  ["conta-btgd",    "PF", "BTG D",   0, "", true],
  ["conta-inter",   "PF", "Inter",   0, "", true],
  ["conta-next",    "PF", "Next",    0, "", true],
  ["conta-btg",     "PJ", "BTG",     0, "", true],
  ["conta-hotmart", "PJ", "Hotmart", 0, "", true],
  ["conta-c6",      "PJ", "C6",      0, "", true]
]
```

Em `MeiosPagamento!A2:D7`:

```
[
  ["mp-pix",      "PIX",        "",        true],
  ["mp-boleto",   "Boleto",     "",        true],
  ["mp-dinheiro", "Dinheiro",   "",        true],
  ["mp-c1",       "Cartão C1",  "Hotmart", true],
  ["mp-c2",       "Cartão C2",  "Hotmart", true],
  ["mp-c3",       "Cartão C3",  "Hotmart", true]
]
```

## Passo 5 — Adicionar 3 colunas em Lançamentos-PF e Lançamentos-PJ

Os Lançamentos tinham A:I (9 colunas). Adicione headers em J1:L1 nas duas abas:
`conta_origem`, `conta_destino`, `meio_pagamento`

Sem dados existentes em col J:L (linhas 2-N), só os headers.

Aplica bold + frozen na linha 1 (já estavam, só estendendo).

## Passo 6 — Data validation nas 3 colunas novas dos Lançamentos

Para CADA uma das duas abas `Lançamentos-PF` e `Lançamentos-PJ`:

- **conta_origem** (col J, rows 2-10000): ONE_OF_RANGE `=Contas!$C$2:$C`
- **conta_destino** (col K, rows 2-10000): ONE_OF_RANGE `=Contas!$C$2:$C`
- **meio_pagamento** (col L, rows 2-10000): ONE_OF_RANGE `=MeiosPagamento!$B$2:$B`

## Passo 7 — Fórmula de saldo_atual em Contas (col E, rows 2-7)

Para cada linha (PF: BTG D, Inter, Next; PJ: BTG, Hotmart, C6), preenche `E{i}` com fórmula per-row (NÃO ARRAYFORMULA — mais estável):

**Linhas 2-4 (PF):**
```
=D{i} + SUMIFS('Lançamentos-PF'!D:D; 'Lançamentos-PF'!K:K; C{i}; 'Lançamentos-PF'!C:C; "receita") - SUMIFS('Lançamentos-PF'!D:D; 'Lançamentos-PF'!J:J; C{i}; 'Lançamentos-PF'!C:C; "despesa")
```

**Linhas 5-7 (PJ):** mesma fórmula mas com `Lançamentos-PJ`:
```
=D{i} + SUMIFS('Lançamentos-PJ'!D:D; 'Lançamentos-PJ'!K:K; C{i}; 'Lançamentos-PJ'!C:C; "receita") - SUMIFS('Lançamentos-PJ'!D:D; 'Lançamentos-PJ'!J:J; C{i}; 'Lançamentos-PJ'!C:C; "despesa")
```

## Passo 8 — Atualizar Dashboard com bloco de Saldos

Em `Dashboard`, insere antes da seção "Próximas contas":

| Cell | Conteúdo |
|---|---|
| A11 | `Saldos PF` (bold) |
| A12 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PF' and Col2 is not null"; 0)` |
| A16 | `Saldos PJ` (bold) |
| A17 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PJ' and Col2 is not null"; 0)` |

Se isso colidir com células já populadas (A11+ tinha "Próximas contas (7d)"), MOVA o bloco "Próximas contas" e "Saldo projetado" pra começar em A21 — atualize o conteúdo dessas células também.

## Passo 9 — Reportar

Quando terminar, confirma:
- 3 abas novas existem (Contas, MeiosPagamento, Recebiveis)
- 6 linhas em Contas (3 PF + 3 PJ)
- 6 linhas em MeiosPagamento
- 3 novas colunas em cada Lançamentos com dropdowns funcionando
- Dashboard tem bloco "Saldos PF" e "Saldos PJ"
- Saldo atual de cada conta calculou (deve ser igual ao saldo_inicial = 0, exceto BTG D PF que deve subtrair os R$30 do café se estiver categorizado nessa conta — provavelmente não tá, então saldo=0)
````

- [ ] **Step 3.2: Verify**

```bash
wc -l .claude/skills/add-finance/migration-prompt.md
grep -c '^## Passo' .claude/skills/add-finance/migration-prompt.md
```

Expected: ~120-160 lines, 9 `## Passo` headers.

- [ ] **Step 3.3: Commit**

```bash
git add .claude/skills/add-finance/migration-prompt.md
git commit -m "feat(finance): add migration-prompt for Plan 1 → Plan 2 in-place upgrade"
```

---

### Task 4: Update SKILL.md install playbook

**Files:**
- Modify: `.claude/skills/add-finance/SKILL.md`

- [ ] **Step 4.1: Add new step between Step 9 and Step 10 — "Register cron jobs"**

Find Step 9 ("Fill SHEET_ID into agent's CLAUDE.md"). After it, insert new Step 9.5:

````markdown
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
````

- [ ] **Step 4.2: Add upgrade path note in SKILL.md top section**

Find the "Prerequisites" section. After it, add:

````markdown
## Upgrade from Plan 1?

If `/add-finance` was already run (Plan 1) and the workbook + agent are working, **don't re-run this whole skill**. Instead:

1. Pull latest skill files (`git pull` to get Plan 2 templates)
2. Copy `.claude/skills/add-finance/system-prompt.md` to `groups/finance/system-prompt.md` (replaces the Plan 1 prompt with the new intents)
3. Operator pastes `migration-prompt.md` content into `@<bot>Bot` to apply schema changes to the existing sheet
4. Run `scripts/finance/register-cron-jobs.ts` to register the 5 cron jobs

Skip the whole "create agent group / bot / sheet" flow.
````

- [ ] **Step 4.3: Update bootstrap Step 8 message — workspace-file pattern for prompts > 4KB**

Find Step 8 (the bootstrap step). Replace the "Tell operator" block with:

````markdown
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
````

- [ ] **Step 4.4: Commit**

```bash
git add .claude/skills/add-finance/SKILL.md
git commit -m "feat(finance): SKILL.md — cron registration step + Plan 1→2 upgrade path + workspace-file pattern"
```

---

## Phase 2 — Cron infrastructure

### Task 5: Write the 5 cron prompt templates

**Files:**
- Create: `.claude/skills/add-finance/prompts/sweep-reminder.md`
- Create: `.claude/skills/add-finance/prompts/daily-digest.md`
- Create: `.claude/skills/add-finance/prompts/weekly-closing.md`
- Create: `.claude/skills/add-finance/prompts/monthly-closing.md`
- Create: `.claude/skills/add-finance/prompts/rollover.md`

These are the `content` field of each recurring task — the agent receives this as a "user message" at the scheduled time.

- [ ] **Step 5.1: Create the prompts directory**

```bash
mkdir -p .claude/skills/add-finance/prompts
```

- [ ] **Step 5.2: Write sweep-reminder.md**

```markdown
[CRON: finance-sweep] Hora de checar lembretes vencidos.

Faça AGORA:

1. Lê `Lembretes!A:E` na workbook.
2. Filtra linhas onde `quando` <= NOW() E `enviado_em` está vazio.
3. Para CADA uma dessas linhas, envia uma mensagem no chat (texto livre): "🔔 Lembrete: {mensagem}". Uma mensagem por linha.
4. Imediatamente DEPOIS de cada envio, atualiza a célula `enviado_em` da linha com o timestamp atual (ISO).
5. Registra em `_Log!A:E`: 1 linha por execução do sweep com timestamp, job='finance-sweep', status='success', qtd_processada=<número de lembretes enviados>, detalhes=''.

Se NÃO houver lembretes vencidos, NÃO envie nada ao user — só atualize `_Log` com qtd_processada=0.

Se algum erro, log em `_Log` com status='error' e detalhes=<msg do erro>.
```

- [ ] **Step 5.3: Write daily-digest.md**

```markdown
[CRON: finance-daily] Digest matinal.

Faça AGORA:

1. Lê do sheet:
   - `Lançamentos-PF` e `Lançamentos-PJ`: todas linhas de ONTEM (data = hoje - 1d)
   - `Recorrentes`: linhas onde `ativo=TRUE` e `proxima_data` entre HOJE e HOJE+7d e `pago_no_mes=FALSE`
   - `Recebiveis`: linhas onde `status='esperado'` e `data_prevista` entre HOJE e HOJE+7d
   - `Orçamento`: linhas onde `status` é "⚠️ 80%" ou "❌ estourou"
   - `Contas`: saldos atuais

2. Monta uma mensagem digest curta (8-12 linhas):

```
☀️ Bom dia, Jonas!

📊 Ontem (dd/mm):
• {N} lançamentos: -R${total_despesa} +R${total_receita}
• Top categoria: {categoria} (R${valor})

📅 Próximos 7 dias:
{lista das contas a vencer + recebíveis esperados, formato: "• {dd/mm}: {nome} R${valor}"}

⚠️ Alertas:
{categorias que estouraram ou ≥80% orçamento}

💰 Saldos PF: BTG D R${x} • Inter R${y} • Next R${z}
💰 Saldos PJ: BTG R${a} • Hotmart R${b} • C6 R${c}
```

3. Envia ao user.

4. Registra em `_Log`.

Se nada digno de nota (zero lançamentos ontem, zero vencimentos, zero alertas), envia versão curta: "☀️ Tudo quieto — sem movimento ontem, sem vencimentos próximos. Saldos: ..."
```

- [ ] **Step 5.4: Write weekly-closing.md**

```markdown
[CRON: finance-weekly] Fechamento da semana (toda domingo 19h).

Faça AGORA:

1. Lê:
   - `Lançamentos-PF` e `Lançamentos-PJ`: linhas onde data está nos últimos 7 dias (hoje-7 a hoje)
   - `Contas.saldo_atual` (todas)
   - `Orçamento`: status atual de cada categoria

2. Monta digest semanal (10-15 linhas):

```
📅 Resumo da semana ({início} a {fim})

PF: -R${despesas_PF} • +R${receitas_PF} • saldo da semana R${diff_PF}
PJ: -R${despesas_PJ} • +R${receitas_PJ} • saldo da semana R${diff_PJ}

Top 3 categorias PF: ...
Top 3 categorias PJ: ...

Orçamento PF: {N} OK, {M} em alerta, {K} estouradas
Orçamento PJ: {N} OK, {M} em alerta, {K} estouradas

Saldos atuais:
PF: BTG D R${x} • Inter R${y} • Next R${z}
PJ: BTG R${a} • Hotmart R${b} • C6 R${c}
```

3. Envia.

4. Registra em `_Log`.
```

- [ ] **Step 5.5: Write monthly-closing.md**

```markdown
[CRON: finance-monthly] Fechamento mensal (último dia do mês 21h).

⚠️ Cron schedule é `0 21 28-31 * *` — dispara nos dias 28-31. PRECISA checar se hoje é o último dia do mês ANTES de executar. Se NÃO for último dia (ex: hoje é 28 mas mês tem 30 dias), retorna silenciosamente.

Verificação: `tomorrow = today + 1d`; se `tomorrow.month == today.month`, NÃO é último dia — pule (não envia nada, não loga).

Se for último dia:

1. Lê:
   - Todos `Lançamentos-PF` e `-PJ` do mês corrente
   - Todas `Recorrentes` (com pago_no_mes status)
   - `Orçamento` completo
   - `Recebiveis` recebidos no mês
   - `Contas.saldo_atual`

2. Monta relatório de fechamento (15-25 linhas):

```
📊 Fechamento de {mês/yyyy}

PF
─ Receitas: R${rec_PF}
─ Despesas: R${desp_PF}
─ Saldo do mês: R${saldo_PF_mes}
─ Top 5 categorias: ...

PJ
─ (mesmo formato)

Recorrentes (status):
─ Pagos no mês: {N}/{total} ({categorias})
─ Pendentes: {lista}

Orçamento:
─ OK: {N} categorias
─ Em alerta (≥80%): {lista com valores}
─ Estourou: {lista com excesso}

Recebíveis do mês:
─ Recebidos: {N} (R${total})
─ Atrasados: {N}
─ Cancelados: {N}

Saldos finais:
PF: ...
PJ: ...
```

3. Envia.

4. Registra em `_Log`.
```

- [ ] **Step 5.6: Write rollover.md**

```markdown
[CRON: finance-rollover] Virada de mês (dia 1, 00:30).

Faça AGORA:

1. Em `Recorrentes`, atualiza TODAS as linhas com `ativo=TRUE` setando `pago_no_mes=FALSE`. (Reset mensal.)

2. Em `Recorrentes`, para cada linha com `ativo=TRUE`:
   - Calcula `data_vencimento_do_mes` = `DATE(year, current_month, dia_do_mes)`
   - Insere uma linha em `Lembretes` com:
     - `id`: `lem-rec-{recorrente_id}-{yyyy-mm}`
     - `quando`: `{data_vencimento_do_mes} 09:00:00`
     - `mensagem`: `Vence hoje: {nome do recorrente} R${valor}`
     - `linhagem`: `recorrente:{recorrente_id}`
     - `enviado_em`: vazio
   - Se já existir um lembrete com esse id (idempotência), pula.

3. Registra em `_Log`: 1 linha com qtd_processada = número de recorrentes materializados.

4. Envia mensagem curta ao user: "🗓️ Novo mês começou. {N} recorrentes resetados, {M} lembretes agendados pro mês."
```

- [ ] **Step 5.7: Verify all 5 files exist**

```bash
ls -la .claude/skills/add-finance/prompts/
wc -l .claude/skills/add-finance/prompts/*.md
```

Expected: 5 files, each 15-50 lines.

- [ ] **Step 5.8: Commit**

```bash
git add .claude/skills/add-finance/prompts/
git commit -m "feat(finance): 5 cron prompt templates (sweep, daily, weekly, monthly, rollover)"
```

---

### Task 6: Write cron-jobs.json config

**Files:**
- Create: `.claude/skills/add-finance/cron-jobs.json`

This file is read by `register-cron-jobs.ts` to know what to insert.

- [ ] **Step 6.1: Write the config**

```json
{
  "jobs": [
    {
      "id": "task-finance-sweep",
      "kind": "scheduled",
      "recurrence": "0 8-22 * * *",
      "promptFile": "sweep-reminder.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-daily",
      "kind": "scheduled",
      "recurrence": "0 8 * * *",
      "promptFile": "daily-digest.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-weekly",
      "kind": "scheduled",
      "recurrence": "0 19 * * 0",
      "promptFile": "weekly-closing.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-monthly",
      "kind": "scheduled",
      "recurrence": "0 21 28-31 * *",
      "promptFile": "monthly-closing.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-finance-rollover",
      "kind": "scheduled",
      "recurrence": "30 0 1 * *",
      "promptFile": "rollover.md",
      "firstRunOffsetMs": 60000
    }
  ]
}
```

- [ ] **Step 6.2: Validate JSON**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/skills/add-finance/cron-jobs.json','utf8')).jobs.length)"
```

Expected: 5

- [ ] **Step 6.3: Commit**

```bash
git add .claude/skills/add-finance/cron-jobs.json
git commit -m "feat(finance): cron-jobs.json with 5 schedules"
```

---

### Task 7: Write register-cron-jobs.ts script with tests

**Files:**
- Create: `scripts/finance/register-cron-jobs.ts`
- Create: `scripts/finance/__tests__/register-cron-jobs.test.ts`

The script reads `cron-jobs.json` + prompt files, then inserts 5 recurring tasks into the finance session's `inbound.db` via `insertTask()`.

- [ ] **Step 7.1: Create scripts/finance directory**

```bash
mkdir -p scripts/finance/__tests__
```

- [ ] **Step 7.2: Write failing test first**

`scripts/finance/__tests__/register-cron-jobs.test.ts`:

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

    // Create prompt files
    promptsDir = path.join(tmpDir, 'prompts');
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(path.join(promptsDir, 'sweep-reminder.md'), 'sweep content');
    fs.writeFileSync(path.join(promptsDir, 'daily-digest.md'), 'daily content');
    fs.writeFileSync(path.join(promptsDir, 'weekly-closing.md'), 'weekly content');
    fs.writeFileSync(path.join(promptsDir, 'monthly-closing.md'), 'monthly content');
    fs.writeFileSync(path.join(promptsDir, 'rollover.md'), 'rollover content');

    // Create cron-jobs.json
    fs.writeFileSync(
      path.join(tmpDir, 'cron-jobs.json'),
      JSON.stringify({
        jobs: [
          { id: 'task-finance-sweep', kind: 'scheduled', recurrence: '0 8-22 * * *', promptFile: 'sweep-reminder.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-daily', kind: 'scheduled', recurrence: '0 8 * * *', promptFile: 'daily-digest.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-weekly', kind: 'scheduled', recurrence: '0 19 * * 0', promptFile: 'weekly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-monthly', kind: 'scheduled', recurrence: '0 21 28-31 * *', promptFile: 'monthly-closing.md', firstRunOffsetMs: 60000 },
          { id: 'task-finance-rollover', kind: 'scheduled', recurrence: '30 0 1 * *', promptFile: 'rollover.md', firstRunOffsetMs: 60000 },
        ],
      }),
    );
  });

  it('inserts 5 recurring tasks with correct content from prompt files', () => {
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };

    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const rows = db.prepare("SELECT id, kind, recurrence, content FROM messages_in WHERE recurrence IS NOT NULL ORDER BY id").all() as Array<{ id: string; kind: string; recurrence: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(5);
    expect(rows.map(r => r.id).sort()).toEqual([
      'task-finance-daily', 'task-finance-monthly', 'task-finance-rollover',
      'task-finance-sweep', 'task-finance-weekly',
    ]);
    expect(rows.find(r => r.id === 'task-finance-sweep')!.recurrence).toBe('0 8-22 * * *');
    expect(rows.find(r => r.id === 'task-finance-sweep')!.content).toBe('sweep content');
    expect(rows.find(r => r.id === 'task-finance-daily')!.content).toBe('daily content');
  });

  it('is idempotent — re-running does not duplicate', () => {
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };

    registerCronJobs(opts);
    registerCronJobs(opts);

    const db = new Database(inboundPath, { readonly: true });
    const count = (db.prepare("SELECT COUNT(*) as c FROM messages_in WHERE recurrence IS NOT NULL").get() as { c: number }).c;
    db.close();

    expect(count).toBe(5);
  });

  it('sets process_after to firstRunOffsetMs in the future', () => {
    const before = Date.now();
    const opts: RegisterOptions = {
      inboundDbPath: inboundPath,
      configPath: path.join(tmpDir, 'cron-jobs.json'),
      promptsDir,
    };
    registerCronJobs(opts);
    const after = Date.now();

    const db = new Database(inboundPath, { readonly: true });
    const row = db.prepare("SELECT process_after FROM messages_in WHERE id='task-finance-sweep'").get() as { process_after: string };
    db.close();

    const processAfterMs = new Date(row.process_after).getTime();
    expect(processAfterMs).toBeGreaterThanOrEqual(before + 60000 - 1000); // -1s margin
    expect(processAfterMs).toBeLessThanOrEqual(after + 60000 + 1000);
  });
});
```

- [ ] **Step 7.3: Run failing test**

```bash
npx vitest run scripts/finance/__tests__/register-cron-jobs.test.ts
```

Expected: FAIL with `Cannot find module '../register-cron-jobs'`.

- [ ] **Step 7.4: Write register-cron-jobs.ts**

`scripts/finance/register-cron-jobs.ts`:

```typescript
/**
 * Register the 5 finance cron jobs as recurring messages in the agent's session inbox.
 *
 * Usage:
 *   npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>
 *
 * The script:
 *   1. Reads cron-jobs.json (the 5 task definitions)
 *   2. Reads each prompt file referenced
 *   3. Inserts each task as a recurring message in the session's inbound.db
 *      (idempotent via INSERT OR REPLACE on the deterministic task id)
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
  const db = new Database(opts.inboundDbPath);

  // Compute seq base — use even seq (per nextEvenSeq pattern from session-db.ts)
  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  let seq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

  const now = Date.now();

  for (const job of config.jobs) {
    const content = fs.readFileSync(path.join(opts.promptsDir, job.promptFile), 'utf8');
    const processAfter = new Date(now + job.firstRunOffsetMs).toISOString();
    const timestamp = new Date().toISOString();

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
  console.log('   Verify: sqlite3 ' + inboundDbPath + ' "SELECT id, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"');
}
```

- [ ] **Step 7.5: Run tests — expect pass**

```bash
npx vitest run scripts/finance/__tests__/register-cron-jobs.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 7.6: Commit**

```bash
git add scripts/finance/register-cron-jobs.ts scripts/finance/__tests__/register-cron-jobs.test.ts
git commit -m "feat(finance): register-cron-jobs.ts + vitest (3 tests)"
```

---

### Task 8: Write unregister-cron-jobs.ts (for teardown/testing)

**Files:**
- Create: `scripts/finance/unregister-cron-jobs.ts`

- [ ] **Step 8.1: Write the script**

`scripts/finance/unregister-cron-jobs.ts`:

```typescript
/**
 * Remove the 5 finance cron jobs from the agent's session inbox.
 *
 * Usage:
 *   npx tsx scripts/finance/unregister-cron-jobs.ts --session <session-id>
 *
 * Use for teardown or to reset before re-registering.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TASK_IDS = [
  'task-finance-sweep',
  'task-finance-daily',
  'task-finance-weekly',
  'task-finance-monthly',
  'task-finance-rollover',
];

const args = process.argv.slice(2);
const sessionIdx = args.indexOf('--session');
if (sessionIdx === -1 || !args[sessionIdx + 1]) {
  console.error('Usage: npx tsx scripts/finance/unregister-cron-jobs.ts --session <session-id>');
  process.exit(1);
}
const sessionId = args[sessionIdx + 1];

const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', 'finance', sessionId, 'inbound.db');
if (!fs.existsSync(inboundDbPath)) {
  console.error(`Inbound DB not found: ${inboundDbPath}`);
  process.exit(1);
}

const db = new Database(inboundDbPath);
const placeholders = TASK_IDS.map(() => '?').join(',');
const result = db.prepare(`DELETE FROM messages_in WHERE id IN (${placeholders})`).run(...TASK_IDS);
db.close();

console.log(`✅ Removed ${result.changes} cron task(s) from ${inboundDbPath}`);
```

- [ ] **Step 8.2: Verify it parses**

```bash
npx tsc --noEmit scripts/finance/unregister-cron-jobs.ts
```

Expected: no errors.

- [ ] **Step 8.3: Commit**

```bash
git add scripts/finance/unregister-cron-jobs.ts
git commit -m "feat(finance): unregister-cron-jobs.ts (teardown helper)"
```

---

## Phase 3 — Operator-driven application

### Task 9: Operator applies migration to the live sheet

This task is OPERATOR-EXECUTED. The plan tracker marks it pending; operator confirms when done.

- [ ] **Step 9.1: Copy migration-prompt to workspace**

```bash
cp .claude/skills/add-finance/migration-prompt.md groups/finance/migration.md
```

- [ ] **Step 9.2: Tell operator to send to @LevisBot**

Message to send: `Leia /workspace/agent/migration.md e execute todos os passos. Reporte ao final.`

- [ ] **Step 9.3: Operator confirms 9-passo report from Levis**

Expected confirmations from Levis:
- 3 abas novas criadas (Contas, MeiosPagamento, Recebiveis)
- 6 linhas em Contas
- 6 linhas em MeiosPagamento
- 3 cols novas em Lançamentos-PF e -PJ
- Dashboard com bloco Saldos

- [ ] **Step 9.4: Cleanup workspace file**

```bash
rm groups/finance/migration.md
```

---

### Task 10: Operator mirrors new system-prompt to live workspace

- [ ] **Step 10.1: Copy updated system-prompt**

```bash
cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md
```

The agent will pick up new intents on next container spawn (next user message).

- [ ] **Step 10.2: Clear session to force fresh prompt load**

```bash
sqlite3 data/v2.db "DELETE FROM sessions WHERE agent_group_id='finance';"
```

(Next user message creates a fresh session with the new prompt.)

---

### Task 11: Operator registers the 5 cron jobs

- [ ] **Step 11.1: Find the new session id**

After user sends a message to @LevisBot (any message — even "oi"), a new session is created.

```bash
sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='finance' ORDER BY created_at DESC LIMIT 1;"
```

- [ ] **Step 11.2: Register the 5 jobs**

```bash
npx tsx scripts/finance/register-cron-jobs.ts --session <session-id>
```

Expected output: `✅ 5 cron jobs registered in data/v2-sessions/finance/<session-id>/inbound.db`

- [ ] **Step 11.3: Verify**

```bash
sqlite3 data/v2-sessions/finance/<session-id>/inbound.db \
  "SELECT id, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"
```

Expected: 5 rows with `task-finance-*` ids and process_after = NOW() + 60s.

- [ ] **Step 11.4: Wait for first sweep fire (~1 minute)**

Within 60s of registration, the host-sweep should pick up `task-finance-sweep` and spawn a container to process it. Confirm via:

```bash
grep -E 'task-finance-sweep|agentGroup="finance".*sweep' /root/nanoclaw/logs/nanoclaw.log | tail -5
```

Expected: a "Spawning container" entry shortly after registration time + a "Message delivered" entry with content `_Log` written (since sweep with 0 lembretes just logs and returns silently per the prompt).

---

## Phase 4 — Smoke + Polish

### Task 12: Smoke test — accounts + receivables + receipts (operator)

Operator runs 4 scenarios on Telegram, one at a time.

- [ ] **Step 12.1: Scenario 1 — cadastrar conta (já populadas, este testa atualização de saldo)**

Send: `saldo inicial do BTG D 5000`
Expected: card "atualizar saldo_inicial da BTG D pra R$ 5.000? (atualiza saldo_atual automaticamente)" → ✓ → BTG D em Contas: saldo_inicial=5000, saldo_atual=5000-30=4970 (se café tiver conta=BTG D) ou 5000 (se vazio).

- [ ] **Step 12.2: Scenario 2 — cadastrar recebível**

Send: `vai entrar 5000 da Hotmart dia 25`
Expected: card "Recebível R$ 5.000, descricao=?, conta_destino=Hotmart, data=25/05" → preenche descricao → ✓ → linha em Recebiveis.

- [ ] **Step 12.3: Scenario 3 — despesa com conta + meio**

Send: `gastei 80 no uber`
Expected: pergunta PF/PJ (PF), pergunta conta_origem (BTG D), pergunta meio_pagamento (PIX), card final com 🏦 BTG D (PIX) → ✓ → linha em Lançamentos-PF com cols J,K,L preenchidas. Confirma em Contas que saldo_atual de BTG D agora desconta R$ 80.

- [ ] **Step 12.4: Scenario 4 — comprovante (imagem)**

Send uma imagem (foto) de um recibo qualquer (pode ser screenshot de nota fiscal, recibo de mercado, etc).
Expected: Levis identifica como comprovante, extrai valor/data/merchant, mostra card de pre-fill, pergunta conta + meio se faltarem, → ✓ → linha em Lançamentos-PF.

- [ ] **Step 12.5: Scenario 5 — voice note**

Envia um áudio (voice note) pro @LevisBot dizendo algo como "gastei 50 no mercado".
Expected: Whisper transcreve automaticamente (já wired em `chat-sdk-bridge.ts:164`), Levis processa o texto como `registrar_despesa`, pergunta PF/PJ + conta + meio, card de confirmação → ✓ → linha em Lançamentos.

Se a transcrição for ruim (português ruim, palavras erradas), o Whisper-1 model é fraco pra ÁUDIOS curtos. Solução: usar `whisper-large` via API ou local (skill `use-local-whisper`).

- [ ] **Step 12.6: Documenta resultados**

Marca cada cenário (12.1–12.5) como ✅ ou ❌ no commit message final. Cenários falhos = blocker pra próxima fase.

---

### Task 13: Smoke test — wait for next daily-digest fire (operator)

The daily digest runs at 08:00. If Plan 2 is being applied at any other time, **trigger it manually** by editing the process_after.

- [ ] **Step 13.1: Manual trigger of daily digest**

```bash
# Find latest session
SESS=$(sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='finance' ORDER BY created_at DESC LIMIT 1;")

# Set process_after of daily-digest to NOW (force immediate fire)
sqlite3 data/v2-sessions/finance/$SESS/inbound.db \
  "UPDATE messages_in SET process_after=datetime('now') WHERE id='task-finance-daily';"
```

Wait ~30s. Expected:
- Container spawns
- Levis sends a digest message to Telegram
- The recurring message gets next process_after set to next 08:00 by host-sweep

- [ ] **Step 13.2: Verify next-occurrence was inserted**

```bash
sqlite3 data/v2-sessions/finance/$SESS/inbound.db \
  "SELECT id, status, datetime(process_after) FROM messages_in WHERE id LIKE '%daily%' ORDER BY seq;"
```

Expected: 2 rows
1. The original `task-finance-daily` with status='completed'
2. A new row (auto-generated by host-sweep recurrence handler) with new `process_after` at next 08:00 and status='pending'

If step 2 doesn't show, host-sweep's recurrence loop isn't firing for this session — debug `src/host-sweep.ts:handleRecurrence` or check that sessions's container is being polled.

---

### Task 14: Final code review + Plan 2 wrap

- [ ] **Step 14.1: Dispatch final code reviewer subagent**

Per `superpowers:subagent-driven-development` workflow — after all tasks, dispatch one reviewer for cross-cutting concerns:

Inputs:
- All commits between Plan 1 final (`3e318c3`) and current HEAD
- Plan 2 file at `docs/superpowers/plans/2026-05-11-finance-agent-plan-2-automation-accounts.md`
- Reference spec at `docs/superpowers/specs/2026-05-11-finance-agent-design.md`

Focus areas:
- Are the new intents in system-prompt consistent with bootstrap-prompt schema (same column names, same tab names)?
- Does the cron-jobs.json schedule_value match what host-sweep can parse via cron-parser?
- Is the saldo_atual formula in Contas correct (won't double-count, handles PF/PJ correctly)?
- Does register-cron-jobs.ts handle the case where a session doesn't exist (e.g., operator hasn't sent any message yet)?

- [ ] **Step 14.2: Address any review findings**

If reviewer flags issues, fix them inline and commit:
```
fix(finance): Plan 2 review findings — <description>
```

- [ ] **Step 14.3: Mark Plan 2 done**

```bash
git commit --allow-empty -m "chore(finance): Plan 2 complete — automation + accounts + receivables + receipts"
```

---

## Definition of Done (Plan 2)

All of these must be true:

- [ ] 4 new intents in system-prompt (`cadastrar_conta`, `cadastrar_recebivel`, `confirmar_recebivel`, `processar_comprovante`)
- [ ] `registrar_despesa` and `registrar_receita` require + write conta/meio fields
- [ ] Live sheet has 12 abas (3 new: Contas, MeiosPagamento, Recebiveis)
- [ ] Live `Lançamentos-PF` and `-PJ` have 3 new cols (J, K, L)
- [ ] Contas seeded with 6 contas (3 PF + 3 PJ), MeiosPagamento with 6 entries
- [ ] `Contas.saldo_atual` formula calculates correctly
- [ ] 5 cron tasks registered in finance session inbox
- [ ] At least 1 cron task has fired and completed (sweep at minimum)
- [ ] At least 1 cron task has auto-respawned (next occurrence visible in inbox)
- [ ] Operator-tested scenarios 12.1-12.4 all ✅
- [ ] Final code review approved

---

## Notes for future plans

- **Cron not firing?** First check `host-sweep` is running (look for "Host sweep started" in logs). Then check the session's container is being spawned for pending messages (look at host-sweep loop interval in code).
- **Levis spamming?** Likely sweep is finding lembretes that don't exist or status filter is wrong. Edit prompt `sweep-reminder.md` and re-register.
- **Receipt OCR failing?** Levis isn't really OCR-ing — Claude is reading the image as vision input. If accuracy is poor on iPhone receipts, may need to crop/zoom hints in the prompt.
- **Plan 3 candidates:**
  - Auto-import via Pluggy/Belvo (Open Finance Brasil)
  - Family budget mode (multi-user with shared categories but isolated accounts)
  - Investment tracking (XP / NuInvest API)
