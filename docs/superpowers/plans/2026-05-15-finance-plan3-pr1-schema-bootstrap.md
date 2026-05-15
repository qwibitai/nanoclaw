# Finance Plan 3 PR 1 — Schema + Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Plan 3 PR 1 — the operator-runnable Plan 2.5 → Plan 3 migration prompt + the documentation updates that describe the post-migration state of the Finance workbook. Zero `src/` code changes; Levis's chat behavior is unchanged in this PR (system-prompt update lands in PR 2).

**Architecture:** Three files touched in `groups/finance/`:
1. **`Controle_Despesas_Jonas_DOC.md`** — moved from repo root into Levis's workspace so the Plan 3 read-on-need pattern (§4.3 of spec) can use the `Read` tool directly.
2. **`CLAUDE.md`** — workbook schema section rewritten to reflect Plan 3 (14 tabs, new columns), plus two new sections (Categorias sensíveis, Doc canônico).
3. **`migration.md`** — rewritten with the Plan 2.5 → Plan 3 migration prompt (Steps A–E from spec §5), pasted into `@<bot>` and executed by Levis via Composio googlesheets MCP. The old Plan 1 → Plan 2 migration content moves to git history.

**Tech Stack:** Markdown (operator-facing prompts + workspace docs). Composio `googlesheets` MCP (`GOOGLESHEETS_BATCH_UPDATE`, `GOOGLESHEETS_UPDATE_VALUES_BATCH`, `GOOGLESHEETS_VALUES_GET`) executed by Levis at paste time — NOT during this PR's authoring. No code, no automated tests.

**Spec:** `docs/superpowers/specs/2026-05-15-finance-plan3-design.md`. Every task in this plan cites the spec section that drives it.

---

## File Structure

| Path | Action | Approx size after | Responsibility |
|---|---|---|---|
| `groups/finance/Controle_Despesas_Jonas_DOC.md` | move (from repo root) | 506 lines (unchanged content) | Source-of-truth doc readable by Levis at `/workspace/agent/` |
| `groups/finance/CLAUDE.md` | edit | ~140 lines (from ~94) | Plan 3 workbook schema (descriptive) + new sections for sensible categories and canonical doc pointer |
| `groups/finance/migration.md` | rewrite | ~450 lines (from ~340) | Plan 2.5 → Plan 3 migration prompt; operator pastes into `@<bot>`; Levis executes Steps A–E via Composio |

**What this PR does NOT touch (locked to PR 2 / PR 3):**
- `groups/finance/system-prompt.md` — Levis intents/rules unchanged
- `scripts/finance/cron-jobs.json`, `register-cron-jobs.ts` — same 5 crons as Plan 2.5
- `.claude/skills/add-finance/*` — skill template still ships Plan 2.5; bumps in PR 3
- Any `src/` file — no host-side code change in Plan 3

---

## Pre-PR setup

- [ ] **Step 0.1: Branch off main**

```bash
git checkout main
git pull
git checkout -b feature/finance-plan3-pr1
```

Expected: switched to `feature/finance-plan3-pr1` tracking origin/main.

- [ ] **Step 0.2: Verify clean working tree**

Run: `git status`

Expected: `nothing to commit, working tree clean` (or only the pre-existing `groups/lobby/perfil-aluno.md` modification, which is unrelated). If anything else is dirty: resolve before continuing.

- [ ] **Step 0.3: Skim the spec once**

Open `docs/superpowers/specs/2026-05-15-finance-plan3-design.md` and re-read §3 (schema), §5 (migration steps), §8 (PR 1 scope). The migration prompt you'll write in Task 5 maps section-by-section to §5.

---

## Task 1: Move `Controle_Despesas_Jonas_DOC.md` into Levis's workspace

Spec ref: §7 ("Where the doc lives"), §8 (PR 1 files).

**Files:**
- Move: `Controle_Despesas_Jonas_DOC.md` (repo root) → `groups/finance/Controle_Despesas_Jonas_DOC.md`

- [ ] **Step 1.1: Move with `git mv`** (preserves git history)

```bash
git mv Controle_Despesas_Jonas_DOC.md groups/finance/Controle_Despesas_Jonas_DOC.md
```

- [ ] **Step 1.2: Verify both paths**

Run:
```bash
ls -la groups/finance/Controle_Despesas_Jonas_DOC.md
ls -la Controle_Despesas_Jonas_DOC.md 2>&1 | head -2
git status
```

Expected:
- File exists at `groups/finance/Controle_Despesas_Jonas_DOC.md` (~19KB, 506 lines)
- Root path: `ls: cannot access 'Controle_Despesas_Jonas_DOC.md': No such file or directory`
- `git status` shows the rename as a single tracked move

- [ ] **Step 1.3: Commit**

```bash
git commit -m "$(cat <<'EOF'
chore(finance): move Controle_Despesas_Jonas_DOC.md into agent workspace

The source-of-truth doc (Jonas's manually-curated view of the 33 recurring
expenses) was authored at the repo root for editing convenience but its
final home is inside the Finance agent's workspace, so Levis can read it
via the Read tool from /workspace/agent/ (read-on-need pattern, Plan 3
spec §4.3 + §7). Content unchanged; this is just a relocation.

First of three commits for Plan 3 PR 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update `groups/finance/CLAUDE.md` — Plan 3 workbook schema + new sections

Spec ref: §3 (schema), §4.4 (CLAUDE.md updates).

**Files:**
- Modify: `groups/finance/CLAUDE.md`

This task only updates the **description** of the schema. Levis's actual *use* of the new schema comes in PR 2. So the file describes the *target state* (post-migration). A brief disclaimer at the top of the workbook section makes the migration dependency explicit.

- [ ] **Step 2.1: Read the existing file to find boundaries**

Run: `Read groups/finance/CLAUDE.md` (full file, ~94 lines)

Identify three regions to change:
- Lines ~16-78 (current "Workbook" section, including "Abas (12)" table and "Schema crítico" subsection)
- After "Schema crítico" — insert new "Categorias sensíveis" subsection
- After "Categorias sensíveis" — insert new "Doc canônico" subsection
- Capacidades ativas table (bottom) — no change in PR 1, leave as-is

- [ ] **Step 2.2: Replace the "Abas" table — 12 → 14 tabs**

Replace the existing `### Abas (12)` heading + table. New version:

```markdown
### Abas (14, Plan 3)

> ⚠️ **Esquema Plan 3.** Requer rodar `migration.md` (Plan 2.5 → Plan 3) **uma única vez** pra alinhar a planilha com este esquema. Se ainda não rodou: os campos com `(Plan 3)` abaixo não existem na planilha viva ainda; Levis trata como se existissem só a partir de PR 2 do Plan 3.

| Aba | Tipo | Função |
|---|---|---|
| `Dashboard` | leitura | KPIs vivos do mês |
| `Lançamentos-PF` | escrita | linha por entrada/saída PF — col `subcategoria` (Plan 3) |
| `Lançamentos-PJ` | escrita | linha por entrada/saída PJ — col `subcategoria` (Plan 3) |
| `Recorrentes` | config | assinaturas, contas fixas, salário — cols `subcategoria`, `codigo`, `status`, `data_corte`, `motivo_corte`, `termina_em`, `parcelas_restantes` (Plan 3) |
| `Orçamento` | config | teto mensal por categoria |
| `Projeção` | leitura | fluxo de caixa 6m (depende de `SALDO_INICIAL`) |
| `Lembretes` | fila | one-shot intraday |
| `Categorias` | taxonomia | nível pai (3 linhas: Empresarial / Residencial / Pessoal) — cols `nome`, `escopo`, `codigo_prefixo` (Plan 3) |
| `Subcategorias` (Plan 3) | taxonomia | nível filho (13 linhas) — cols `nome`, `categoria_pai`, `escopo`, `codigo_prefixo`, `sensibilidade`, `nao_sugerir_corte` |
| `Contas` | config | nome, escopo (PF/PJ), saldo_inicial, saldo_atual (fórmula) |
| `MeiosPagamento` | config | nome (PIX, Boleto, Cartão C1/C2/C3, Dinheiro), escopo, conta_origem default |
| `Recebiveis` | escrita | recebíveis futuros |
| `Decisoes` (Plan 3) | histórico | timeline de mudanças estruturais — cols `data`, `item_id` (codigo), `tipo`, `detalhes`, `impacto_mensal` |
| `_Log` | sistema | execuções de cron |
```

- [ ] **Step 2.3: Update the "Schema crítico" subsection — Recorrentes + Lançamentos cols**

Find the subsection starting with `### Schema crítico` and the table for `**Lançamentos-PF` e `Lançamentos-PJ`**. Add row for `subcategoria`:

```markdown
| `subcategoria` | string | FK to `Subcategorias.nome` (Plan 3) — pode ficar vazia em linhas pré-Plan-3; preenche em next-touch |
```

(Insert after the existing `categoria` row, before `descricao`.)

Then replace the `**Recorrentes**` table entirely with:

```markdown
**`Recorrentes`** (Plan 3 schema):

| col | obs |
|---|---|
| `id` | `rec-XXXXXX` (FK target for `Lançamentos.recorrente_id`) — não muda |
| `codigo` | (Plan 3) `{Categoria.codigo_prefixo}-{Subcategoria.codigo_prefixo}-{NNN}` (e.g. `EMP-IAL-001`). Imutável após criação. |
| `escopo` | `PF` ou `PJ` |
| `nome`, `tipo`, `valor` | livre / `despesa`|`receita` / number (BRL) |
| `categoria`, `subcategoria` | (Plan 3) FK to `Categorias.nome` / `Subcategorias.nome` |
| `frequencia`, `dia_do_mes`, `proxima_data` (fórmula), `pago_no_mes` | inalterados |
| `status` | (Plan 3) enum `ATIVO` \| `CORTADO` \| `PENDENTE` \| `ENCERRADO` — substitui `ativo: bool` |
| `data_corte`, `motivo_corte` | (Plan 3) NULL quando ATIVO; preenchidos no `cortar_recorrente` (PR 2) |
| `termina_em`, `parcelas_restantes` | (Plan 3) NULL se sem prazo; cron monthly seta `status=ENCERRADO` quando `termina_em <= hoje` |
| `_legacy_ativo` | bool — preservado pela migration por segurança; ignorar (será dropado em Plan 3.1) |
```

- [ ] **Step 2.4: Add new subsection — Categorias e Subcategorias**

After "Schema crítico" tables, insert:

```markdown
**`Categorias`** (Plan 3 — 3 linhas pai):

| col | obs |
|---|---|
| `nome` | `Empresarial` / `Residencial` / `Pessoal` |
| `escopo` | `PF` \| `PJ` \| `global` |
| `codigo_prefixo` | 3 letras maiúsculas — `EMP` / `RES` / `PES`. Usado pra montar `Recorrentes.codigo`. |

**`Subcategorias`** (Plan 3 — 13 linhas filhas):

| col | obs |
|---|---|
| `nome` | `IA & LLMs`, `Saúde`, `Moradia`, ... |
| `categoria_pai` | FK to `Categorias.nome` |
| `escopo` | `PF` \| `PJ` \| `global` — hint pra Recorrentes.escopo |
| `codigo_prefixo` | 3 letras — `IAL`, `SAU`, `MOR`, ... |
| `sensibilidade` | `alta` \| `media` \| `nenhuma` — Levis usa em `sugerir_economias` |
| `nao_sugerir_corte` | bool — `TRUE` para Saúde, Educação, Dívidas |

**`Decisoes`** (Plan 3 — timeline):

| col | obs |
|---|---|
| `data` | ISO date |
| `item_id` | `codigo` do Recorrente (ex `EMP-IAL-001`) — NULL pra decisões estruturais (taxonomia, renomeações) |
| `tipo` | enum `corte` \| `reclassificacao` \| `adicao` \| `correcao` \| `renomeacao` \| `migracao` |
| `detalhes` | uma linha de resumo |
| `impacto_mensal` | number — R$ delta mensal (signed; negativo = economizou) |
```

- [ ] **Step 2.5: Add "Categorias sensíveis" subsection**

After the Decisoes table, insert:

```markdown
### Categorias sensíveis

`Subcategorias.nao_sugerir_corte = TRUE` marca subcategorias que Levis nunca sugere cortar sozinho: Saúde, Educação, Dívidas (com prazo de fim). Alimentação tem `sensibilidade=media` (variável, não fixo, não cortar sem contexto).

Detalhes narrativos em `Controle_Despesas_Jonas_DOC.md` §8.4. Levis aplica a regra em PR 2 (intent `sugerir_economias`); em PR 1 a flag existe na planilha mas o agente ainda não a consulta.
```

- [ ] **Step 2.6: Add "Doc canônico" subsection**

After "Categorias sensíveis", insert:

```markdown
### Doc canônico

`Controle_Despesas_Jonas_DOC.md` (neste diretório, montado em `/workspace/agent/`) é a fonte estruturada de verdade — taxonomia, decisões, riscos, cadência de revisão, regras de classificação para itens novos.

**Quando ler** (com `Read` tool):
- Classificação ambígua → §2.4 (regras de classificação para itens novos)
- "esse item foi cortado?" / "por que?" → §7 (histórico de decisões)
- "quanto vai liberar quando o X terminar?" → §6 (compromissos com data de fim)
- Sensibilidade / tom → §8.4 (categorias sensíveis)
- Análise de riscos → §8.3 (concentração, cambial, redundância)

Não carregar no início da sessão — o doc é referência, não contexto.

**Regen sob demanda** via intent `exportar_doc` (PR 2). Doc reflete sempre o estado da planilha; após qualquer mudança estrutural significativa (cortes, adições em batch, renomeações), Jonas pede regen e commita.
```

- [ ] **Step 2.7: Verify the file**

Run: `wc -l groups/finance/CLAUDE.md`

Expected: ~140 lines (up from ~94).

Run: `grep -E '^### ' groups/finance/CLAUDE.md`

Expected sections (in order): Identidade, Workbook, Abas (14, Plan 3), Schema crítico, Categorias sensíveis, Doc canônico, Tools que você usa, Comportamento, Capacidades ativas.

- [ ] **Step 2.8: Commit**

```bash
git add groups/finance/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(finance): update CLAUDE.md to describe Plan 3 workbook schema

Plan 3 PR 1 (descriptive only — Levis behavior changes in PR 2).

Abas: 12 → 14 (adds `Subcategorias`, `Decisoes`).
Recorrentes: gains `codigo`, `subcategoria`, `status`, `data_corte`,
  `motivo_corte`, `termina_em`, `parcelas_restantes`. `ativo` renamed
  to `_legacy_ativo` (preserved by migration for safety; ignored).
Lançamentos-PF/PJ: gain `subcategoria` column.
Categorias: now parent-only (3 rows), gains `codigo_prefixo`.
Subcategorias (new): 13 rows, sensibilidade flag, codigo_prefixo.
Decisoes (new): timeline of structural changes.

Two new sections at the bottom: "Categorias sensíveis" (links the
flag to behavior that lands in PR 2) and "Doc canônico" (read-on-need
pointer to Controle_Despesas_Jonas_DOC.md).

A disclaimer at the top of the Abas section makes the migration
dependency explicit — fields marked `(Plan 3)` don't exist in the
live planilha until `migration.md` is run.

Second of three commits for Plan 3 PR 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Rewrite `groups/finance/migration.md` — Plan 2.5 → Plan 3 prompt

Spec ref: §5 (full step-by-step). This is the largest task. The output is a single markdown file that Jonas pastes into `@<bot>`; Levis reads it as one prompt and executes Steps A–E sequentially via Composio googlesheets tools.

**Files:**
- Rewrite: `groups/finance/migration.md` (was Plan 1 → Plan 2; old content lives in git history)

The migration prompt is the heart of PR 1. It must be:
- **Self-contained** — the bot reads it once, executes top-to-bottom
- **Idempotent** — re-running on an already-migrated workbook is a no-op (see spec §5.6)
- **Operator-facing prose** — short, declarative, no "TODO"s

- [ ] **Step 3.1: Open the existing file**

Run: `Read groups/finance/migration.md` — confirm it's the Plan 1 → Plan 2 prompt. Whole file will be replaced.

- [ ] **Step 3.2: Write the prelude**

Write the new file. Start with the header section:

```markdown
# Migration prompt — Plan 2.5 → Plan 3

(Operator: cola este bloco inteiro no `@<bot>` quando estiver pronto para migrar a planilha pra Plan 3. Executa Steps A–E em sequência via Composio googlesheets. **Idempotente** — re-rodar é seguro.)

Pré-condições:
- Plan 2.5 vivo (12 abas, 5 crons). Se ainda está em Plan 1 ou 2, primeiro rode a migration antiga (git history) ou contate o time.
- Operator pasted `Controle_Despesas_Jonas_DOC.md` ou ele já vive em `/workspace/agent/` (Plan 3 PR 1 move). O bot vai precisar consultar §3 e §4 e §7.

---

Vou migrar a workbook de Plan 2.5 (12 abas) pra Plan 3 (14 abas + cols novas em Recorrentes/Lançamentos + bootstrap de 33 itens + 10 decisões históricas).

⚠️ **LOCALE pt-BR:** separadores `;`, decimal `,`.
⚠️ **SHEET_ID:** uso o configurado em `CLAUDE.md` — não pergunto ao Jonas.
⚠️ **Idempotência:** antes de cada subpasso, verifico se já está feito (`lookupSheetByTitle`, `getValuesByA1`, `lookupRow`) — pulo se sim.
```

- [ ] **Step 3.3: Write Step A — Schema changes**

Append the Step A section. This adds `Subcategorias` and `Decisoes` tabs, adds 7 columns to `Recorrentes` (writing headers in N–T), adds 1 column to each Lançamentos sheet (writing header in M1), and applies dropdown validations:

```markdown
## Step A — Schema (abas novas + colunas novas + validações)

### A.1 Adicionar abas `Subcategorias` e `Decisoes`

`GOOGLESHEETS_BATCH_UPDATE`:
```json
{
  "spreadsheet_id": "<SHEET_ID>",
  "requests": [
    {"addSheet": {"properties": {"title": "Subcategorias"}}},
    {"addSheet": {"properties": {"title": "Decisoes"}}}
  ]
}
```

Idempotência: se uma das duas já existe, a chamada inteira falha (Sheets retorna erro). Antes da chamada acima, lookup com `GOOGLESHEETS_VALUES_GET` na aba `Subcategorias!A1:F1` — se retornar com dados, pula este passo inteiro.

Capture os 2 novos `sheetId`s (precisa pra validações depois).

### A.2 Headers + formatação

`Subcategorias` (A1:F1): `nome`, `categoria_pai`, `escopo`, `codigo_prefixo`, `sensibilidade`, `nao_sugerir_corte`
`Decisoes` (A1:E1): `data`, `item_id`, `tipo`, `detalhes`, `impacto_mensal`

Para cada uma: bold + grey background + frozen row 1 (igual aos headers existentes, via `repeatCell`).

Formatação BRL em `Decisoes` E:E. Formatação data em `Decisoes` A:A.

### A.3 Estender header de `Categorias` — adicionar `codigo_prefixo`

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Categorias!C1`: valor `codigo_prefixo` (assumindo schema atual é A=nome, B=escopo; se C já tem header, pula).

### A.4 Adicionar 7 colunas a `Recorrentes`

Headers nas cols L1:R1 (assumindo schema atual de Plan 2.5 ocupa A:K com `ativo` em K):

| col | header |
|---|---|
| L1 | `codigo` |
| M1 | `subcategoria` |
| N1 | `status` |
| O1 | `data_corte` |
| P1 | `motivo_corte` |
| Q1 | `termina_em` |
| R1 | `parcelas_restantes` |

Renomear K1 (`ativo`) → `_legacy_ativo` (preservar a coluna, marcar como deprecada — mais seguro que deleteDimension porque preserva refs e evita shifting de letras).

Aplicar: bold + frozen + formatação data em O e Q, number em R.

### A.5 Adicionar 1 coluna a `Lançamentos-PF` e `Lançamentos-PJ`

Header em M1 = `subcategoria` (assumindo Plan 2.5 ocupa A:L com cols de Plan 2). Idempotência: se M1 já é "subcategoria", pula.

### A.6 Validações de dropdown

Aplicar `setDataValidation` em batch:

- `Subcategorias.escopo` (C2:C1000): ONE_OF_LIST `["PF", "PJ", "global"]`
- `Subcategorias.sensibilidade` (E2:E1000): ONE_OF_LIST `["alta", "media", "nenhuma"]`
- `Subcategorias.nao_sugerir_corte` (F2:F1000): checkbox
- `Recorrentes.status` (N2:N1000): ONE_OF_LIST `["ATIVO", "CORTADO", "PENDENTE", "ENCERRADO"]`
- `Decisoes.tipo` (C2:C1000): ONE_OF_LIST `["corte", "reclassificacao", "adicao", "correcao", "renomeacao", "migracao"]`
- `Categorias.escopo` (B2:B1000): ONE_OF_LIST `["PF", "PJ", "global"]` (se já existe a validação, é no-op)

### A.7 Verificação

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!L1:R1` — deve retornar `["codigo", "subcategoria", "status", "data_corte", "motivo_corte", "termina_em", "parcelas_restantes"]`. Senão, aborte Step B com erro.
```

- [ ] **Step 3.4: Write Step B — migrate `ativo` → `status`**

Append:

```markdown
## Step B — Migrar dados existentes (`ativo` → `status`)

### B.1 Ler estado atual

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!A2:K1000`. Captura todas as linhas existentes com o valor original de `_legacy_ativo` (que era `ativo` antes do rename do Step A.4).

### B.2 Computar `status` por linha

Pra cada linha existente:
- Se `_legacy_ativo` == TRUE: `status = "ATIVO"`, `data_corte = ""`, `motivo_corte = ""`
- Se `_legacy_ativo` == FALSE: `status = "CORTADO"`, `data_corte = ""`, `motivo_corte = "(legado pre-Plan-3)"`

Outras cols novas (`codigo`, `subcategoria`, `termina_em`, `parcelas_restantes`) ficam vazias — Step D preenche para os 33 itens do doc canônico; linhas legadas que não aparecem no doc ficam com esses campos vazios e Jonas preenche manualmente depois.

### B.3 Escrever em batch

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Recorrentes!N2:P{N+1}` com a matriz computada (`status`, `data_corte`, `motivo_corte` linha por linha). N = número de linhas existentes em Recorrentes.

### B.4 Verificação

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!N2:N1000` — verifica que toda linha não-vazia tem `status` em `{"ATIVO", "CORTADO", "PENDENTE", "ENCERRADO"}`. Senão, aborte com a linha problemática.

Idempotência: antes de B.3, lê coluna N. Se já estiver toda preenchida com valores válidos, pula Step B.
```

- [ ] **Step 3.5: Write Step C — seed `Categorias` + `Subcategorias`**

Append:

```markdown
## Step C — Seed taxonomia (Categorias + Subcategorias)

### C.1 Categorias (3 linhas)

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Categorias!A2:C4` (idempotência: lookupRow por `nome`, escreve linha que não existe; se as 3 existem com `codigo_prefixo` setado, pula):

```
| nome         | escopo  | codigo_prefixo |
|--------------|---------|----------------|
| Empresarial  | PJ      | EMP            |
| Residencial  | global  | RES            |
| Pessoal      | global  | PES            |
```

### C.2 Subcategorias (13 linhas)

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Subcategorias!A2:F14` (idempotência: lookupRow por `nome`, pula se já existe):

```
| nome              | categoria_pai | escopo | codigo_prefixo | sensibilidade | nao_sugerir_corte |
|-------------------|---------------|--------|----------------|---------------|-------------------|
| IA & LLMs         | Empresarial   | PJ     | IAL            | nenhuma       | FALSE             |
| Infra & Dev       | Empresarial   | PJ     | INF            | nenhuma       | FALSE             |
| WhatsApp Cliente  | Empresarial   | PJ     | WHA            | nenhuma       | FALSE             |
| Workspace & Apple | Empresarial   | PJ     | WSP            | nenhuma       | FALSE             |
| Conteúdo & Reuniões| Empresarial  | PJ     | CNT            | nenhuma       | FALSE             |
| Moradia           | Residencial   | global | MOR            | media         | FALSE             |
| Casa & Serviços   | Residencial   | global | CSS            | media         | FALSE             |
| Alimentação       | Residencial   | global | ALI            | media         | FALSE             |
| Transporte        | Pessoal       | PF     | TRA            | media         | FALSE             |
| Saúde             | Pessoal       | PF     | SAU            | alta          | TRUE              |
| Educação          | Pessoal       | PF     | EDU            | alta          | TRUE              |
| Dívidas           | Pessoal       | PF     | DIV            | alta          | TRUE              |
| Telefonia         | Pessoal       | PF     | TEL            | nenhuma       | FALSE             |
```

### C.3 Verificação

`GOOGLESHEETS_VALUES_GET` em `Categorias!A2:A4` → 3 linhas non-empty.
`GOOGLESHEETS_VALUES_GET` em `Subcategorias!A2:A14` → 13 linhas non-empty.
```

- [ ] **Step 3.6: Write Step D — bootstrap 33 recorrentes**

Append:

```markdown
## Step D — Bootstrap 33 recorrentes (de `Controle_Despesas_Jonas_DOC.md` §3 + §4)

### D.1 Ler doc canônico

`Read` em `/workspace/agent/Controle_Despesas_Jonas_DOC.md` (Plan 3 PR 1 moveu pra esse path). Parse §3 (31 ATIVOS + 1 PENDENTE) e §4 (2 CORTADOS = Chatvolt, GPT Codex). Total 33 itens.

Pra cada item, extrair:
- `codigo` — heading bold do item (ex `EMP-IAL-001`)
- `nome` — após o "—" no heading
- `valor` — linha "Valor:" (BRL — pra USD usa o "→ R$ X,YY" do próprio doc, que aplica R$ 5,40 como rate)
- `dia_do_mes` — linha "Vencimento:" se presente (number); senão NULL
- `status` — linha "Status:" (ATIVO / CORTADO / PENDENTE)
- `data_corte` — só pra CORTADO; "CORTADO em YYYY-MM-DD"
- `motivo_corte` — só pra CORTADO; linha "Motivo do corte:"
- `termina_em` — só presente em `PES-DIV-001` ("Data de término: fevereiro/2027" → 2027-02-01); resto NULL
- `parcelas_restantes` — sempre NULL inicialmente (Jonas atualiza quando relevante)
- `categoria` + `subcategoria` — derivadas da posição hierárquica no doc (heading `### 3.1.1 IA & LLMs` indica subcat "IA & LLMs"; pai vem da seção 3.1 = Empresarial)
- `escopo` — herdado de `Subcategorias.escopo` da subcat
- `tipo` — `despesa` (todos os 33 são despesas)
- `frequencia` — `mensal` (todos os 33)
- `pago_no_mes` — FALSE

### D.2 Idempotência

Antes de escrever: `GOOGLESHEETS_VALUES_GET` em `Recorrentes!L2:L1000` — coletar todos os `codigo` já presentes. Pra cada item do doc, se `codigo` já existe na planilha, pula (não regrava).

### D.3 Gerar `id` técnico pra cada novo

`id = "rec-" + 6 hex random` (mesma convenção dos Recorrentes já existentes).

### D.4 Escrever em batch

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Recorrentes!A{N+1}:R{N+M}` (N = última linha existente; M = quantidade de novos itens):

Cada linha tem 18 cols (incluindo `_legacy_ativo` em K, que recebe TRUE pra ATIVO/PENDENTE e FALSE pra CORTADO — só pra consistência visual; o campo é deprecated):
```
A:id  B:escopo  C:nome  D:tipo  E:valor  F:categoria  G:frequencia  H:dia_do_mes  I:proxima_data  J:pago_no_mes  K:_legacy_ativo  L:codigo  M:subcategoria  N:status  O:data_corte  P:motivo_corte  Q:termina_em  R:parcelas_restantes
```

`proxima_data` (col I) tem fórmula `=DATE(...)` que já está configurada nas linhas existentes — replica a fórmula nas linhas novas usando o mesmo template (referencia `H{row}`).

### D.5 Verificação

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!L2:L1000` — deve ter os 33 `codigo`s do doc (com nada duplicado).

Conta linhas com `status="ATIVO"` → deve ser 31 (todos exceto Chatvolt, GPT Codex que são CORTADO e a 4ª D-API que é PENDENTE — total ATIVO+PENDENTE+CORTADO = 33).
```

- [ ] **Step 3.7: Write Step E — seed `Decisoes` + final migracao marker**

Append:

```markdown
## Step E — Seed `Decisoes` (timeline)

### E.1 Idempotência

`GOOGLESHEETS_VALUES_GET` em `Decisoes!D2:D1000` — se já contém uma linha com `detalhes` que casa com "Plan 2.5 → Plan 3 bootstrap complete", pula todo Step E (já rodou antes).

### E.2 Escrever 10 linhas históricas

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Decisoes!A2:E11`:

```
| data       | item_id     | tipo            | detalhes                                              | impacto_mensal |
|------------|-------------|-----------------|-------------------------------------------------------|----------------|
| 2026-05-13 | ARQ-001     | corte           | Chatvolt substituído por n8n                          | -359,00        |
| 2026-05-13 | ARQ-002     | corte           | GPT Codex substituído por Perplexity Pro (bônus)      | -108,00        |
| 2026-05-13 | EMP-WHA-001 | correcao        | D-API valor real R$ 177 (era R$ 120 na planilha antiga)| +57,00         |
| 2026-05-13 | PES-DIV-001 | reclassificacao | Apartamento antigo: Empresarial → Pessoal/Dívidas     | 0              |
| 2026-05-13 | PES-TRA-002 | renomeacao      | Prestação Carro → Parcela Carro Jadiel                | 0              |
| 2026-05-15 | PES-TRA-001 | adicao          | Localiza Meoo (assinatura mensal de carro)            | +4788,00       |
| 2026-05-15 | RES-ALI-001 | adicao          | Compras Padrão Mercado (mercado mensal)               | +1500,00       |
| 2026-05-15 | EMP-WHA-002 | adicao          | Salvy (números WhatsApp empresariais)                 | +54,80         |
| 2026-05-15 |             | renomeacao      | Taxonomia: 13 subcategorias (5/3/5)                   | 0              |
| 2026-05-15 |             | renomeacao      | AI code reviewer descartado (Claude Code substitui)    | 0              |
```

### E.3 Linha final de marca de migração

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Decisoes!A12:E12`:

```
| 2026-05-XX |             | migracao | Plan 2.5 → Plan 3 bootstrap complete | 0 |
```

(Use `=TODAY()` na col A se preferir data dinâmica; ou ISO date do dia da execução.)

### E.4 Log no `_Log`

`GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` em `_Log!A:E`:
```
| <ISO timestamp> | plan3-bootstrap | success | 33 | "11 decisoes seed; 13 subcategorias; 14 abas" |
```

### E.5 Resposta final ao Jonas

```
<message to="jonas">✅ Plan 3 migration complete:
- 14 abas (adicionei Subcategorias + Decisoes)
- Recorrentes: +7 cols, status migrado de ativo
- 13 subcategorias seeded
- 33 recorrentes bootstrapped (31 ATIVO + 1 PENDENTE + 2 CORTADO)
- 11 decisoes na timeline

Verifica via Sheets UI. Quando OK, pode mergeear PR 2 (atualização do Levis pra usar Plan 3).</message>
```

Se algum step abortou, emite:
```
<message to="jonas">⚠️ Plan 3 migration abortou em Step {X}.{Y}: {erro}.

Estado intermediário preservado — pode rodar de novo (idempotente). Pra rollback manual: ver instruções em migration.md, seção "Rollback".</message>
```
```

- [ ] **Step 3.8: Write validation checklist + rollback**

Append:

```markdown
## Validation checklist (operator, após executar)

Conferir via Sheets UI:

- [ ] 14 abas existem (Dashboard, Lançamentos-PF, Lançamentos-PJ, Recorrentes, Orçamento, Projeção, Lembretes, Categorias, **Subcategorias**, Contas, MeiosPagamento, Recebiveis, **Decisoes**, _Log)
- [ ] `Categorias` tem 3 linhas, cada uma com `codigo_prefixo` (EMP/RES/PES)
- [ ] `Subcategorias` tem 13 linhas, cada uma com `categoria_pai` válido, `codigo_prefixo` único, e `sensibilidade` setada
- [ ] `Recorrentes` tem 33 linhas com `codigo` do tipo `XXX-YYY-NNN`, `status` setado, `subcategoria` setada
- [ ] Pelo menos 1 linha tem `status=CORTADO` (Chatvolt) com `data_corte` e `motivo_corte` preenchidos
- [ ] `PES-DIV-001` (Apartamento antigo) tem `termina_em = 2027-02-01`
- [ ] `Decisoes` tem 11 linhas (10 históricas + 1 marca de migração)
- [ ] `_Log` tem uma entrada `plan3-bootstrap success`

Tudo OK? Migração validada. Levis ainda opera em comportamento Plan 2.5 — não usa as colunas novas até PR 2.

## Rollback

Se algo deu muito errado e o operator quer voltar pra Plan 2.5:

1. **Restaurar Recorrentes:** col K1 volta a ser `ativo` (rename inverso). Cols L:R são apagadas (`deleteDimension`).
2. **Apagar abas:** `deleteSheet` em `Subcategorias` e `Decisoes`.
3. **Categorias:** col C (`codigo_prefixo`) apagada.
4. **Lançamentos-PF / Lançamentos-PJ:** col M (`subcategoria`) apagada.

Nenhum dado de Plan 2.5 foi sobrescrito — todas as colunas/abas novas são aditivas, e `ativo → _legacy_ativo` é só rename. Status real do Plan 2.5 está preservado em `_legacy_ativo`.

Se preferir manter dados de Plan 3 (subcategorias, codigos, decisões) mas pausar o uso: deixe a planilha como está e mantenha o Levis em comportamento Plan 2.5 (system-prompt antigo).
```

- [ ] **Step 3.9: Verify the file**

Run:
```bash
wc -l groups/finance/migration.md
grep -E '^## Step ' groups/finance/migration.md
```

Expected:
- ~450 lines
- 5 `## Step` headings (A, B, C, D, E)

- [ ] **Step 3.10: Commit**

```bash
git add groups/finance/migration.md
git commit -m "$(cat <<'EOF'
docs(finance): replace migration.md with Plan 2.5 → Plan 3 prompt

Steps A–E execute via Composio googlesheets when operator pastes the
prompt into @<bot>:

  A. Schema — addSheet Subcategorias + Decisoes; +7 cols Recorrentes
     (codigo, subcategoria, status, data_corte, motivo_corte, termina_em,
     parcelas_restantes); +1 col cada Lançamentos sheet (subcategoria);
     ativo → _legacy_ativo (rename, not delete); dropdowns +
     formatting.
  B. Migrate _legacy_ativo → status (TRUE→ATIVO, FALSE→CORTADO with
     motivo "(legado pre-Plan-3)").
  C. Seed Categorias (3 parent rows) + Subcategorias (13 child rows
     with sensibilidade, codigo_prefixo, nao_sugerir_corte).
  D. Bootstrap 33 recorrentes from Controle_Despesas_Jonas_DOC.md
     (§3 + §4), preserving codigo, status, termina_em where known.
  E. Seed 10 historical Decisoes (from doc §7) + 1 final migracao
     marker + _Log entry + final message to Jonas.

Every step is idempotent: lookup before write, skip if already done.
Validation checklist + rollback procedure at the end of the prompt.

Old Plan 1 → Plan 2 migration content lives in git history. Plan 3
PR 2 (Levis behavior) lands after operator runs this and validates.

Third of three commits for Plan 3 PR 1.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Push + open PR

- [ ] **Step 4.1: Push branch**

```bash
git push -u origin feature/finance-plan3-pr1
```

- [ ] **Step 4.2: Open PR via `gh`**

```bash
gh pr create --title "feat(finance): Plan 3 PR 1 — schema + bootstrap migration prompt" --body "$(cat <<'EOF'
First PR of three for the Finance Plan 3 reform (spec:
\`docs/superpowers/specs/2026-05-15-finance-plan3-design.md\`).

## Scope

**Operator-facing only.** Zero \`src/\` changes; zero behavior change for
Levis until PR 2.

| File | Change |
|---|---|
| \`groups/finance/Controle_Despesas_Jonas_DOC.md\` | moved from repo root |
| \`groups/finance/CLAUDE.md\` | Plan 3 workbook schema description + sensible cats + canonical doc pointer |
| \`groups/finance/migration.md\` | rewritten — Plan 2.5 → Plan 3 prompt (Steps A–E) |

## How to roll out

1. Merge this PR.
2. Pull on the host running NanoClaw.
3. Paste \`groups/finance/migration.md\` (the entire file contents) into
   \`@<finance bot>\` on Telegram.
4. Levis executes Steps A–E via Composio googlesheets (idempotent, safe
   to re-run if anything aborts).
5. Walk the validation checklist at the end of \`migration.md\`. Expect:
   14 tabs, 33 recorrentes with \`codigo\`, 13 subcategorias, 11
   decisoes, 1 \`_Log\` entry.

## Risks

- Migration aborts partway → idempotent, re-run picks up. Errors land
  in Telegram with the failing step.
- New columns ignored by Levis until PR 2 → expected (this is the
  whole point of phasing).
- Rollback documented in \`migration.md\` Rollback section.

## Plan 3 path

- PR 1 (this) — schema + bootstrap
- PR 2 — Levis behavior (new intents, sensibilidade rule, exportar_doc)
- PR 3 — three new crons + \`/add-finance\` skill template bumped to Plan 3

Plan: \`docs/superpowers/plans/2026-05-15-finance-plan3-pr1-schema-bootstrap.md\`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review (mental check before handoff)

**Spec coverage:** Each spec §5 step (A–E) has a task (Task 3.3–3.7). §3 schema is reflected in Task 2 CLAUDE.md update. §7 doc location is Task 1. §4.4 CLAUDE.md updates are Task 2.5/2.6. §8 PR 1 scope is the whole plan.

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N". Every step shows the code/content to write.

**Type/name consistency:**
- `codigo`, `codigo_prefixo`, `categoria_pai`, `sensibilidade`, `nao_sugerir_corte`, `_legacy_ativo` — same names everywhere across spec, plan, CLAUDE.md edits, and migration.md.
- Cron times not relevant for PR 1 (PR 3 territory).

**One discrepancy from spec to flag:**

Spec §3.3 says `ativo: bool` is **REMOVED**. Plan Task 3.3 renames it to `_legacy_ativo` instead, because `deleteDimension` shifts column indices and risks breaking the `proxima_data` formula or any reference by column letter. The data is preserved unchanged; only the header label changes. Functionally equivalent (Levis ignores `_legacy_ativo` from PR 2 onward), but pragmatically safer. **Spec doc could be amended in a follow-up commit; not blocking.**

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-finance-plan3-pr1-schema-bootstrap.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
