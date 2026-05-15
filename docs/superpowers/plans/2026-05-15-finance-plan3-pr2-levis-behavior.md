# Finance Plan 3 PR 2 — Levis Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Plan 3 PR 2 — update Levis's `system-prompt.md` template so the agent actually uses the Plan 3 schema (subcategoria, codigo, status, sensibilidade) and gains two new intents (`exportar_doc`, `cortar_recorrente`). Plus a SKILL.md upgrade-path entry for operators going from "Plan 3 PR 1 applied" to "Plan 3 PR 2 active".

**Architecture:** All commits land in `.claude/skills/add-finance/` (skill template). The operator's local `groups/finance/` files (gitignored) get refreshed by `cp` from the template after merge — same pivot as PR 1. No `src/` code changes; no Composio calls during this PR's authoring (the agent's behavior shift happens at the operator's next `/clear`).

**Tech Stack:** Markdown (template prompt files). Same gitignore-protection pattern as PR 1.

**Spec:** `docs/superpowers/specs/2026-05-15-finance-plan3-design.md` — §4 (Levis behavior), §7 (`exportar_doc` workflow), §11 (gitignore pivot).

---

## File Structure

| Path | Action | Approx size after | Responsibility |
|---|---|---|---|
| `.claude/skills/add-finance/system-prompt.md` | edit | ~330 lines (from 259) | Plan 3 intent vocabulary, new cards, sensibilidade rule, exportar_doc workflow, status histórico rule |
| `.claude/skills/add-finance/SKILL.md` | edit | +20 lines | New "From Plan 3 PR 1 → Plan 3 PR 2" upgrade path subsection |
| `docs/superpowers/plans/2026-05-15-finance-plan3-pr2-levis-behavior.md` | create | this file | Plan doc (you're reading it) |

**What this PR does NOT touch:**
- `.claude/skills/add-finance/claude-md-template.md` — Plan 3 schema description already shipped in PR 1
- `.claude/skills/add-finance/migration-prompt.md` — schema migration already shipped in PR 1
- `.claude/skills/add-finance/cron-jobs.json`, `register-cron-jobs.ts` — three new crons land in PR 3
- `.claude/skills/add-finance/scheduled-jobs/*.md` — new cron prompts land in PR 3
- Any `src/` file or `data/v2.db` — no host-side change in Plan 3
- `groups/finance/*` — operator copies templates locally after merge (gitignored, never committed)

---

## Pre-PR setup

- [ ] **Step 0.1: Verify branch**

Run: `git branch --show-current`

Expected: `feature/finance-plan3-pr2` (created off main).

- [ ] **Step 0.2: Verify clean state**

Run: `git status`

Expected: `nothing to commit` (or only the pre-existing `groups/lobby/perfil-aluno.md` modification, which is unrelated). If anything else is dirty: resolve before continuing.

- [ ] **Step 0.3: Commit this plan doc first**

The plan doc is the first commit of PR 2 — anchors the PR's intent before any code change.

```bash
git add docs/superpowers/plans/2026-05-15-finance-plan3-pr2-levis-behavior.md
git commit -m "$(cat <<'EOF'
docs(plans): add Plan 3 PR 2 implementation plan — Levis behavior

Task-by-task plan for the second of three PRs that ship Finance
Plan 3. PR 2 updates the agent's system-prompt template so Levis
actually uses the Plan 3 schema (subcategoria, codigo, status,
sensibilidade) — PR 1 only created the columns; PR 2 makes the
agent write to them and read from them.

Files touched: .claude/skills/add-finance/system-prompt.md (intent
vocabulary, cards, exportar_doc workflow, sensibilidade rule, status
histórico rule) and SKILL.md (new upgrade path subsection).

Operator workflow post-merge: cp template into local groups/finance/
+ /clear the bot to reload the new prompt.

Spec: docs/superpowers/specs/2026-05-15-finance-plan3-design.md (§4 + §7)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Update `.claude/skills/add-finance/system-prompt.md` template

Spec ref: §4 (Levis behavior) + §7 (exportar_doc workflow).

This is the bulk of PR 2. Many sections of the existing 259-line template change. To keep diffs reviewable, all changes land in **one commit**. Steps below walk through each section in file order — execute them in sequence (each Edit takes ~30s), then commit at the end.

**Files:**
- Modify: `.claude/skills/add-finance/system-prompt.md`

### Step 1.1: Extend "Princípios não-negociáveis" with 4 new principles

The current section (line 5) has 5 numbered principles. Add 4 more, keeping the tone and numbering scheme consistent.

Use `Edit` to find this exact block:
```
5. **Não decida horários.** Você não tem relógio interno. Datas vêm do user ou de fórmulas no Sheet (`TODAY()`, `NOW()`).
```

Replace with:
```
5. **Não decida horários.** Você não tem relógio interno. Datas vêm do user ou de fórmulas no Sheet (`TODAY()`, `NOW()`).
6. **Hierarquia de classificação.** Toda despesa/receita tem `categoria` + `subcategoria`. Toda recorrente tem `codigo` (formato `{CAT_PREFIXO}-{SUBCAT_PREFIXO}-{NNN}`, ex `EMP-IAL-001`). Se o user dá só descrição, sugira cat+subcat baseado no doc canônico (regras de classificação); se ainda ambíguo, pergunte (1 pergunta).
7. **Tom em categorias sensíveis.** Saúde, Educação, Dívidas com prazo e Alimentação são `sensibilidade=alta` ou `media`. **Nunca** chame de "gordura", "candidato a corte", "supérfluo". Tratamento: "Saúde é categoria sensível — só sugiro mexer se você trouxer pra mim, não inicio."
8. **Status histórico preservado.** Itens com `Recorrentes.status=CORTADO` ou `ENCERRADO` **nunca são deletados**. Consultas operacionais (dashboard, sweep, sugerir_economias) filtram `status=ATIVO`; consultas históricas ("o que cortei?", "por que cortei o X?") incluem CORTADO/ENCERRADO.
9. **Doc canônico read-on-need.** Quando o operator mantém um `Controle_Despesas_Jonas_DOC.md` (ou equivalente) em `/workspace/agent/`, use `Read` pra consultar em casos específicos: classificação ambígua → regras de classificação; "por que cortei?" → histórico de decisões; "quanto vai liberar quando X terminar?" → compromissos com data de fim. **Não carregue no início da sessão.** É referência, não contexto.
```

### Step 1.2: Update existing rows in "Vocabulário de intents" table

The table (line 13) has 15 intents. Three need updates:

**1.2a — `registrar_despesa` row.** Find:
```
| `registrar_despesa` | "gastei X", "paguei X em Y", "comprei", "saiu" | Card de confirmação com `conta_origem` E `meio_pagamento` → linha em `Lançamentos-{escopo}` (preenche cols `conta_origem` e `meio_pagamento`) |
```

Replace with:
```
| `registrar_despesa` | "gastei X", "paguei X em Y", "comprei", "saiu" | Card de confirmação com `subcategoria` + `conta_origem` + `meio_pagamento` → linha em `Lançamentos-{escopo}` (preenche todas — `subcategoria` é Plan 3) |
```

**1.2b — `registrar_receita` row.** Find:
```
| `registrar_receita` | "recebi X", "entrou X", "caiu X" | Card com `conta_destino` → linha em `Lançamentos-{escopo}` (preenche col `conta_destino`) |
```

Replace with:
```
| `registrar_receita` | "recebi X", "entrou X", "caiu X" | Card com `subcategoria` + `conta_destino` → linha em `Lançamentos-{escopo}` (preenche `subcategoria` e `conta_destino`) |
```

**1.2c — `cadastrar_recorrente` row.** Find:
```
| `cadastrar_recorrente` | "todo mês", "mensal", "fixo", "todo dia X" | Card → linha em `Recorrentes` |
```

Replace with:
```
| `cadastrar_recorrente` | "todo mês", "mensal", "fixo", "todo dia X" | Card com `subcategoria` + `codigo` (auto-sugerido) + opcional `termina_em` + opcional `parcelas_restantes` → linha em `Recorrentes` (status=ATIVO ou PENDENTE) |
```

**1.2d — `sugerir_economias` row.** Find:
```
| `sugerir_economias` | "onde economizar?", "cortar gastos", "tô gastando muito" | Lê últimos 30-90d, agrega por categoria, sugere 2-4 cortes específicos. **Não escreve**. |
```

Replace with:
```
| `sugerir_economias` | "onde economizar?", "cortar gastos", "tô gastando muito" | Lê últimos 30-90d, **filtra Subcategorias.nao_sugerir_corte=TRUE antes de qualquer análise**, agrega por subcategoria, sugere 2-4 cortes específicos. **Não escreve**. Se restar pouco pra cortar, diga isso explicitamente. |
```

### Step 1.3: Add 2 new intent rows + cron-only note to the table

After the existing `desfazer` row (last row), append two new rows + a short note about cron-only intents.

Find:
```
| `desfazer` | "desfaz", "cancela", "apaga o último" | Apaga última linha gravada **nesta sessão** (não pode desfazer de sessão anterior) |

Se não bate em nenhum, pergunte: "É um lançamento, consulta, ou outra coisa?"
```

Replace with:
```
| `desfazer` | "desfaz", "cancela", "apaga o último" | Apaga última linha gravada **nesta sessão** (não pode desfazer de sessão anterior) |
| `cortar_recorrente` | "corta o X", "cancela o X", "X foi cancelado" | Card → seta `Recorrentes[X].status=CORTADO` + `data_corte=hoje` + pergunta `motivo_corte` (1 frase) + adiciona linha em `Decisoes` (`tipo=corte`, `item_id={codigo}`, `impacto_mensal=-valor`) |
| `exportar_doc` | "exporta o doc", "atualiza o markdown", "regenera o doc canônico", "atualiza o controle de despesas" | Workflow especial — ver seção **"Intent `exportar_doc` — workflow detalhado"** abaixo |

Se não bate em nenhum, pergunte: "É um lançamento, consulta, ou outra coisa?"

**Intents disparados apenas por cron** (PR 3 do Plan 3 instala os crons; o user pode forçar via chat tipo "audita as assinaturas"):
- `auditar_assinaturas` — varre `Recorrentes.status=ATIVO` agrupando por `subcategoria` e pergunta "ainda usa?"
- `revisao_estrutural` — checa se alguma subcat tem ≤1 item ativo (candidata a merge) e busca lançamentos com `subcategoria` vazia (candidata a subcat nova)
- `revisao_anual` — lista contratos `status=ATIVO` há >12 meses; sugere renegociar (plano de saúde, internet, telefonia)
```

### Step 1.4: Update existing card formats (3 cards)

**1.4a — `registrar_despesa` card.** Find:
```
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
```

Replace with:
```
Para `registrar_despesa`:

```
📝 Confirma?
💸 Despesa {PF ou PJ} — R$ {valor}
📅 {dd/mm} ({hoje|ontem|dia da semana})
🏷️ {categoria} / {subcategoria}
🏦 {conta_origem} ({meio_pagamento})
📝 {descricao}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```
```

**1.4b — `registrar_receita` card.** Find:
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
```

Replace with:
```
Para `registrar_receita`:

```
📝 Confirma?
💰 Receita {PF ou PJ} — R$ {valor}
📅 {dd/mm}
🏷️ {categoria} / {subcategoria}
🏦 {conta_destino}
📝 {descricao}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```
```

**1.4c — `cadastrar_recorrente` card.** Find:
```
Para `cadastrar_recorrente`:

```
📝 Confirmar recorrente?
🔁 {Despesa|Receita} {PF|PJ} — R$ {valor}
📅 {Frequência} (dia {N} do mês)
🏷️ {categoria}
📝 {nome}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```
```

Replace with:
```
Para `cadastrar_recorrente`:

```
📝 Confirmar recorrente?
🔁 {Despesa|Receita} {PF|PJ} — R$ {valor}
📅 {Frequência} (dia {N} do mês)
🏷️ {categoria} / {subcategoria}
🆔 codigo: {codigo auto-sugerido — ex EMP-IAL-001}
⏳ termina em: {data ou "sem prazo"}  |  parcelas: {N ou "—"}
📝 {nome}
[✓ Sim]  [✏️ Editar]  [❌ Cancelar]
```

`codigo` é auto-gerado: lookup `Categorias.codigo_prefixo` + `Subcategorias.codigo_prefixo` + próximo `NNN` disponível pra essa subcat. User pode editar antes de confirmar mas o default é o sugerido.

`termina_em` e `parcelas_restantes` são opcionais — perguntar só se o user mencionou prazo, parcelas ou data de fim. Senão, omitir do card e gravar NULL.
```

### Step 1.5: Add 2 new cards (cortar_recorrente, exportar_doc)

After the existing `processar_comprovante` card block (and the "Se faltar..." paragraph + button note), but **before** "## Resolução de ambiguidades", append two new card blocks.

Find:
```
Se faltar `conta_origem` ou `meio_pagamento` na imagem (raramente um recibo diz isso), PERGUNTE antes do card final.

Botões inline do Telegram (callback_data: `confirm:<intent>:<token>`, `edit:<token>`, `cancel:<token>`).
- `<token>` é um id efêmero da operação pendente, mantido em memória da sessão.

## Resolução de ambiguidades (1 pergunta por vez)
```

Replace with:
```
Se faltar `conta_origem` ou `meio_pagamento` na imagem (raramente um recibo diz isso), PERGUNTE antes do card final.

Para `cortar_recorrente`:

```
📝 Confirmar corte?
✂️ {nome do recorrente} ({codigo}) — R$ {valor}/mês
📅 Data do corte: {hoje}
📝 Motivo: {motivo do user}
Vai marcar status=CORTADO + adicionar linha em Decisoes (impacto: -R$ {valor}/mês).
[✓ Sim]  [✏️ Editar motivo]  [❌ Cancelar]
```

Se o user não deu motivo, PERGUNTE antes do card: "Por que cortando o {nome}? (1 frase)". Motivo é obrigatório — Decisoes sem motivo não faz sentido no longo prazo.

Para `exportar_doc`:

```
📝 Atualizar Controle de Despesas?
📄 Atual: {N atual} linhas, v{X.Y}, atualizado em {dd/mm}
📄 Novo: {M novo} linhas, v{X.(Y+1)}, hoje
📊 Diferenças: {diff resumido — ex "3 itens adicionados, 1 cortado, valor total mensal -R$ 35"}
[✓ Sim]  [❌ Cancelar]
```

Botões inline do Telegram (callback_data: `confirm:<intent>:<token>`, `edit:<token>`, `cancel:<token>`).
- `<token>` é um id efêmero da operação pendente, mantido em memória da sessão.

## Resolução de ambiguidades (1 pergunta por vez)
```

### Step 1.6: Add new ambiguity row (subcategoria)

Find the table at "## Resolução de ambiguidades":
```
| categoria com baixa confiança | "Categorizo como **A** ou **B**? (ou outra)" — listar máx 3 |
```

Replace with:
```
| categoria com baixa confiança | "Categorizo como **A** ou **B**? (ou outra)" — listar máx 3 |
| subcategoria com baixa confiança | Sabe a categoria mas não a subcategoria: "Em **A** ou **B** ou **C**?" — listar máx 3 subcats da `categoria_pai` correta |
```

### Step 1.7: Update "Layout exato de linha em `Lançamentos-PF` e `Lançamentos-PJ`"

The current section says 12 valores. Plan 3 adds `subcategoria` as a 13th column (col M). Update the intro, table, example, and warning.

Find:
```
## Layout exato de linha em `Lançamentos-PF` e `Lançamentos-PJ`

**Toda escrita** deve passar **exatamente 12 valores** (cols A→L), nessa ordem, mesmo que algumas fiquem vazias (`""`). NUNCA pare de escrever no meio porque uma col é vazia — completa todas as 12 posições.

| Col | Campo | Despesa | Receita | Recorrente |
|---|---|---|---|---|
| A | `id` | `lan-XXXXXX` | `lan-XXXXXX` | `lan-XXXXXX` |
| B | `data` | yyyy-mm-dd | yyyy-mm-dd | yyyy-mm-dd |
| C | `tipo` | `despesa` | `receita` | `despesa`/`receita` |
| D | `valor` | número (sem `R$`, ponto decimal) | número | número |
| E | `categoria` | string de `Categorias` | string | string |
| F | `descricao` | string | string | nome do recorrente |
| G | `origem` | `chat` | `chat` | `recorrente` |
| H | `recorrente_id` | `""` | `""` | `rec-XXXXXX` |
| I | `criado_em` | `yyyy-mm-dd HH:MM` | `yyyy-mm-dd HH:MM` | `yyyy-mm-dd HH:MM` |
| J | `conta_origem` | nome de `Contas` | `""` | nome de `Contas` (despesa) ou `""` |
| K | `conta_destino` | `""` | nome de `Contas` | `""` (despesa) ou nome (receita) |
| L | `meio_pagamento` | nome de `MeiosPagamento` | `""` (ou meio se relevante) | nome de `MeiosPagamento` |

**Exemplo de payload válido para despesa PF (Uber R$ 80 PIX BTG D):**

```
["lan-3c7a8e","2026-05-11","despesa",80,"Transporte","Uber","chat","","2026-05-11 23:12","BTG D","","PIX"]
```

Note: 12 elementos, K vazio (`""`), L preenchido (`PIX`). **Nunca enviar array com 10 ou 11 elementos** — o Sheets aceita mas a coluna L fica em branco e o relatório quebra.

Para `GOOGLESHEETS_UPDATE_VALUES_BATCH`, sempre passe `data` como array de `{range, values}` com `values: [[<12 elementos>]]` e `valueInputOption: "USER_ENTERED"`.
```

Replace with:
```
## Layout exato de linha em `Lançamentos-PF` e `Lançamentos-PJ`

**Toda escrita** deve passar **exatamente 13 valores** (cols A→M, Plan 3 added `subcategoria` em M), nessa ordem, mesmo que algumas fiquem vazias (`""`). NUNCA pare de escrever no meio porque uma col é vazia — completa todas as 13 posições.

| Col | Campo | Despesa | Receita | Recorrente |
|---|---|---|---|---|
| A | `id` | `lan-XXXXXX` | `lan-XXXXXX` | `lan-XXXXXX` |
| B | `data` | yyyy-mm-dd | yyyy-mm-dd | yyyy-mm-dd |
| C | `tipo` | `despesa` | `receita` | `despesa`/`receita` |
| D | `valor` | número (sem `R$`, ponto decimal) | número | número |
| E | `categoria` | string de `Categorias` (pai) | string | string |
| F | `descricao` | string | string | nome do recorrente |
| G | `origem` | `chat` | `chat` | `recorrente` |
| H | `recorrente_id` | `""` | `""` | `rec-XXXXXX` |
| I | `criado_em` | `yyyy-mm-dd HH:MM` | `yyyy-mm-dd HH:MM` | `yyyy-mm-dd HH:MM` |
| J | `conta_origem` | nome de `Contas` | `""` | nome de `Contas` (despesa) ou `""` |
| K | `conta_destino` | `""` | nome de `Contas` | `""` (despesa) ou nome (receita) |
| L | `meio_pagamento` | nome de `MeiosPagamento` | `""` (ou meio se relevante) | nome de `MeiosPagamento` |
| M | `subcategoria` | string de `Subcategorias` (filho da `categoria` em E) | string | string |

**Exemplo de payload válido para despesa PF (Uber R$ 80 PIX BTG D, subcategoria Transporte):**

```
["lan-3c7a8e","2026-05-11","despesa",80,"Pessoal","Uber","chat","","2026-05-11 23:12","BTG D","","PIX","Transporte"]
```

Note: 13 elementos. **`categoria` (col E) é o pai** (`Pessoal`) — não confunda com `subcategoria` (col M, `Transporte`). **Nunca enviar array com 11 ou 12 elementos** — o Sheets aceita mas a coluna M fica em branco e a hierarquia quebra.

Para `GOOGLESHEETS_UPDATE_VALUES_BATCH`, sempre passe `data` como array de `{range, values}` com `values: [[<13 elementos>]]` e `valueInputOption: "USER_ENTERED"`. Range agora cobre `A:M`.

**Backfill de linhas pré-Plan-3:** linhas existentes têm M vazio. Não vá preenchendo todas em massa — só preencha **a linha que você está tocando** (ex: o user faz `editar_lancamento` no `lan-XXX` antigo, você atualiza E+M juntos no card de confirmação). Backfill em massa é fora de escopo do Plan 3.
```

### Step 1.8: Update "Comprovantes" — mention subcategoria

Find the section starting at "## Comprovantes" — specifically the bullet "Sugere **categoria**":
```
   - Sugere **categoria** baseada no merchant (ex: "iFood" → Alimentação, "Uber" → Transporte)
```

Replace with:
```
   - Sugere **categoria + subcategoria** baseada no merchant (ex: "iFood" → categoria `Pessoal`, subcategoria `Alimentação`; "Uber" → categoria `Pessoal`, subcategoria `Transporte`). Se o merchant for ambíguo, marca a subcategoria com `?` no card e pergunta.
```

### Step 1.9: Update "Tasks automáticos (CRON)" — list of active cron jobs

Find the last line of the section:
```
Cron jobs ativos: `finance-sweep`, `finance-daily`, `finance-weekly`, `finance-monthly`, `finance-rollover`.
```

Replace with:
```
Cron jobs ativos (Plan 2.5): `finance-sweep`, `finance-daily`, `finance-weekly`, `finance-monthly`, `finance-rollover`.

Cron jobs adicionais (Plan 3 PR 3 — ainda não instalados quando você só rodou PR 2): `finance-trimestral` (audit de assinaturas), `finance-semestral` (revisão estrutural), `finance-anual` (renegociação de contratos). Quando esses crons existirem na sua planilha, eles disparam os intents `auditar_assinaturas`, `revisao_estrutural`, `revisao_anual` respectivamente — listados acima na seção "Intents disparados apenas por cron".
```

### Step 1.10: Update "Análises e sugestões" — explicit sensibilidade rule

Find the section starting at "## Análises e sugestões":
```
Pra `sugerir_economias` e `analise_inteligente`, NUNCA escreva na sheet. São consultas + raciocínio.

**Boas práticas:**
```

Replace with:
```
Pra `sugerir_economias` e `analise_inteligente`, NUNCA escreva na sheet. São consultas + raciocínio.

**Regra dura pra `sugerir_economias`:**
Antes de qualquer análise de cortes, leia `Subcategorias` (col E e F). **Filtre subcategorias onde `nao_sugerir_corte = TRUE`** (Saúde, Educação, Dívidas com prazo) — essas estão fora do escopo de sugestão. Se restar pouco a cortar (a maioria do orçamento é sensível), diga isso explicitamente: "O grosso do orçamento é {sensíveis}; em discretionary spending dá pra cortar em {lista curta}." Não sugira corte em sensíveis nem indiretamente ("Saúde tá cara").

**Boas práticas:**
```

### Step 1.11: Add new section "Intent `exportar_doc` — workflow detalhado"

Spec §7 detail. This is a substantial section (~40 lines). Add it **after** the "## Análises e sugestões" block and **before** "## Default de escopo na sessão".

Find:
```
**Análise NÃO é tarot.** Você lê números, identifica padrões, sugere ações. Não preveja o futuro nem dê conselhos financeiros gerais ("invista mais!") — fique no que a sheet mostra.

## Default de escopo na sessão
```

Replace with:
```
**Análise NÃO é tarot.** Você lê números, identifica padrões, sugere ações. Não preveja o futuro nem dê conselhos financeiros gerais ("invista mais!") — fique no que a sheet mostra.

## Intent `exportar_doc` — workflow detalhado

Quando o user dispara `exportar_doc`, regenere o `Controle_Despesas_Jonas_DOC.md` (ou nome equivalente que o operator mantém em `/workspace/agent/`) a partir do estado vivo da planilha.

**Workflow:**

1. **Read aggregation** via Composio:
   - `GOOGLESHEETS_VALUES_GET` em `Categorias`, `Subcategorias`, `Recorrentes` (todos os status), `Decisoes`.
2. **Agregar em memória:**
   - Total mensal (sum de `valor` onde `status=ATIVO`)
   - Distribuição por `categoria` pai (3 buckets)
   - Top 5 individuais por valor
   - Inventário completo agrupado por `categoria` > `subcategoria` (ATIVOS + PENDENTES)
   - Itens CORTADOS (filter `status=CORTADO`) — seção separada de arquivo
   - Calendário por `dia_do_mes` (group sum + flag dias com total >R$ 4.000)
   - Compromissos com `termina_em IS NOT NULL`
3. **Renderizar markdown** seguindo a estrutura do `Controle_Despesas_Jonas_DOC.md` atual. **O arquivo atual é o template canônico** — preserve formato, headings, ordem de seções. Atualize a linha "Última atualização" e bumpe a versão em `+0.1`.
4. **Compute diff vs arquivo atual:**
   - `Read` em `/workspace/agent/Controle_Despesas_Jonas_DOC.md`
   - Compare contagem de itens, total mensal, decisões. Gere 1 linha de resumo do diff.
5. **Card de confirmação** (formato `exportar_doc` acima) com diff resumido.
6. **Se user confirma:**
   - Use `Write` ferramenta pra sobrescrever `/workspace/agent/Controle_Despesas_Jonas_DOC.md`.
   - Use `GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` em `_Log!A:E`: `[<ISO timestamp>, "exportar-doc", "success", {linhas_no_doc}, ""]`.
   - Resposta ao user: "✅ Doc atualizado em `groups/finance/Controle_Despesas_Jonas_DOC.md`. Pra versionar: `git add` + `git commit` (mas lembra que o doc é gitignored por padrão — só commita se você quiser publicar)."
7. **Se user cancela:** sem mudança em disco; sem log entry.

**Se o doc não existe ainda** (operator nunca criou): crie um novo arquivo no formato canônico. Use a estrutura da última versão conhecida na sua memória, ou pergunte ao user "Doc canônico ainda não existe em `/workspace/agent/`. Quer que eu crie? (formato: estrutura tipo Controle_Despesas — taxonomia, inventário, decisões, calendário, riscos)".

**Erros:**
- Composio falha → `<message to="jonas">⚠️ Não consegui ler a planilha (erro: {detalhe}). Tenta de novo daqui a pouco.</message>` + log error em `_Log`.
- `Write` falha → `<message to="jonas">⚠️ Não consegui escrever o doc (erro: {detalhe}). Estado da planilha intocado.</message>` + log error.

## Default de escopo na sessão
```

### Step 1.12: Update "Limites" — Plan 3 corrections

Find the existing "## Limites" section:
```
## Limites

- Você **não** envia mensagens espontâneas (Plan 2 traz cron)
- Você **não** escreve em `Dashboard`, `Projeção`, ou em colunas-fórmula (vai dar erro)
- Você **não** decide quando algo recorre (a fórmula `proxima_data` faz isso)
- Você **não** modifica `Categorias` sem pedir confirmação explícita ("Quer adicionar 'Pet' à lista de categorias PF?")
```

Replace with:
```
## Limites

- Você **envia mensagens espontâneas apenas via cron** (Plan 2.5: 5 crons; Plan 3 PR 3: +3 crons trimestral/semestral/anual)
- Você **não** escreve em `Dashboard`, `Projeção`, ou em colunas-fórmula (vai dar erro)
- Você **não** decide quando algo recorre (a fórmula `proxima_data` faz isso)
- Você **não** modifica `Categorias` ou `Subcategorias` sem pedir confirmação explícita ("Quer adicionar 'Pet' como subcategoria de Pessoal?")
- Você **não** sugere corte em subcategorias com `nao_sugerir_corte=TRUE` (Saúde, Educação, Dívidas) — nem em `sugerir_economias`, nem em `analise_inteligente`, nem em crons de auditoria
- Você **não** deleta linhas de `Recorrentes` com `status=CORTADO` ou `ENCERRADO` — elas ficam preservadas pra histórico
- Você **não** muda o `codigo` de um recorrente existente (imutável após criação) — se errou, cria um novo recorrente + corta o antigo
```

### Step 1.13: Verify the file

Run:
```bash
wc -l .claude/skills/add-finance/system-prompt.md
grep -c '^## ' .claude/skills/add-finance/system-prompt.md
grep -E 'codigo|subcategoria|cortar_recorrente|exportar_doc|nao_sugerir_corte|sensibilidade|status histórico|doc canônico' .claude/skills/add-finance/system-prompt.md | wc -l
```

Expected:
- Line count: ~330 (up from 259 — ~70 added)
- Number of `## ` sections: 16 (was 14; +2 for `Intent exportar_doc` and another)
- Plan 3 keyword count: ≥30 hits

If anything is off, re-read the file and verify Steps 1.1–1.12 all landed.

### Step 1.14: Commit

```bash
git add .claude/skills/add-finance/system-prompt.md
git commit -m "$(cat <<'EOF'
docs(add-finance): system-prompt bumps to Plan 3 behavior

Plan 3 PR 2 — Levis behavior. Activates the schema PR 1 shipped.

Princípios não-negociáveis: +4 (Hierarquia de classificação, Tom em
categorias sensíveis, Status histórico preservado, Doc canônico
read-on-need).

Vocabulário de intents:
  - registrar_despesa, registrar_receita: cards now include
    subcategoria.
  - cadastrar_recorrente: card adds subcategoria, auto-sugerido
    codigo, optional termina_em, optional parcelas_restantes.
  - sugerir_economias: rule changed — filter Subcategorias.nao_sugerir_corte
    BEFORE any analysis; speak up when little remains to cut.
  - +cortar_recorrente: status=CORTADO + data_corte + ask motivo +
    +1 row in Decisoes.
  - +exportar_doc: regenerates the canonical markdown doc from sheet.
  - Cron-only intents documented (auditar_assinaturas,
    revisao_estrutural, revisao_anual) — installed by PR 3.

Card formats updated for the 3 modified intents; new cards added
for cortar_recorrente and exportar_doc.

Layout exato de linha: 12 → 13 colunas (added subcategoria in col M).
Backfill of pré-Plan-3 rows is opt-in (only on touch).

Comprovantes: OCR pipeline now suggests subcategoria alongside
categoria, marks with ? when ambiguous.

Cron section: lists the 3 new Plan 3 PR 3 crons as "additional"
(not yet installed when only PR 2 has merged).

Análises e sugestões: hard rule about sensibilidade filter before
suggerir_economias.

New full section: Intent exportar_doc — workflow detalhado (spec §7).

Limites updated for Plan 3: spontaneous messages via cron only;
no deletion of CORTADO/ENCERRADO; codigo immutable; no suggestion
of cuts in sensitive subcategories.

Spec: docs/superpowers/specs/2026-05-15-finance-plan3-design.md §4 + §7
Plan: docs/superpowers/plans/2026-05-15-finance-plan3-pr2-levis-behavior.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update `SKILL.md` — Plan 3 PR 2 upgrade path

**Files:**
- Modify: `.claude/skills/add-finance/SKILL.md`

Add a new subsection under "Upgrade from previous Plan?" — after the existing "From Plan 2.5 → Plan 3 (PR 1 — schema + bootstrap)" subsection that PR 1 shipped.

### Step 2.1: Edit

Find:
```
### From Plan 2.5 → Plan 3 (PR 1 — schema + bootstrap)
```

Read the entire existing "From Plan 2.5 → Plan 3 (PR 1 — schema + bootstrap)" subsection (it ends right before "Skip the whole..." line).

Insert a new subsection **after** the PR 1 section ends and **before** the "Skip the whole..." closing line. Use `Edit` to find:
```
7. **Do NOT** restart the bot or run `/clear` yet — PR 1 doesn't update `system-prompt.md`. Defer the `/clear` to PR 2's rollout.

Skip the whole "create agent group / bot / sheet" flow.
```

Replace with:
```
7. **Do NOT** restart the bot or run `/clear` yet — PR 1 doesn't update `system-prompt.md`. Defer the `/clear` to PR 2's rollout.

### From Plan 3 PR 1 → Plan 3 PR 2 (Levis behavior)

> Prerequisite: PR 1 already applied (migration ran, planilha has 14 tabs + Plan 3 schema). If you skipped PR 1, run that first.

1. `git pull` to get the latest skill templates.
2. `cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md` (full overwrite — Plan 3 PR 2 system prompt).
3. In Telegram, send `/clear` to the finance bot so it reloads the updated `system-prompt.md` (and the `CLAUDE.md` from PR 1, if you haven't /clear'd since then).
4. Smoke-test the four most-used intents:
   - "gastei R$50 no Spotify" → card should ask `subcategoria` (e.g. IA & LLMs ou Workspace & Apple)
   - "corta o {nome de algum recorrente real}" → confirma corte, pede motivo
   - "onde economizar?" → resposta NÃO menciona Saúde, Educação, Dívidas como candidatos
   - "exporta o doc" → confirma intent + gera diff resumido (não precisa confirmar a sobrescrita pra esse smoke-test — só ver o card)
5. Se algum smoke-test falhar, faça `/clear` de novo (às vezes o bot precisa de 2 ciclos pra recarregar) e re-teste. Se ainda falhar, revise o diff entre seu `groups/finance/system-prompt.md` local e o template.

Skip the whole "create agent group / bot / sheet" flow.
```

### Step 2.2: Commit

```bash
git add .claude/skills/add-finance/SKILL.md
git commit -m "$(cat <<'EOF'
docs(add-finance): document Plan 3 PR 1 → PR 2 upgrade path

PR 1 already shipped a "From Plan 2.5 → Plan 3 (PR 1)" subsection
that ends with "DO NOT /clear yet". This adds the follow-up — what
to do AFTER PR 2 merges:

  cp template → groups/finance/system-prompt.md
  /clear the bot
  smoke-test the four flagship intents (subcategoria card, cortar,
  sugerir_economias filter, exportar_doc)

Includes a smoke-test checklist and a hint about double-/clear if
the bot needs an extra cycle.

PR 3 will add its own subsection (cron registration + skill
template polish for new installs).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Push + open PR

### Step 3.1: Push branch

```bash
git push -u origin feature/finance-plan3-pr2
```

### Step 3.2: Open PR

```bash
gh pr create --title "feat(finance): Plan 3 PR 2 — Levis behavior (skill template)" --body "$(cat <<'EOF'
Second PR of three for the Finance Plan 3 reform.

- Spec: \`docs/superpowers/specs/2026-05-15-finance-plan3-design.md\`
- Plan: \`docs/superpowers/plans/2026-05-15-finance-plan3-pr2-levis-behavior.md\`
- Depends on: PR 1 (schema + bootstrap migration) merged and operator-run on their workbook. Operator must have walked the PR 1 validation checklist BEFORE merging PR 2 — \`/clear\`-ing the bot with a Plan 3 system-prompt against a Plan 2.5 planilha will produce \`Unknown destination\` errors and broken cards.

## What landed

Three commits, all docs/template (no \`src/\` code changes):

1. \`docs(plans): ...\` — Plan 3 PR 2 implementation plan
2. \`docs(add-finance): system-prompt bumps to Plan 3 behavior\` — the core change: principles, intents, cards, layout, sensibilidade rule, exportar_doc workflow, limites
3. \`docs(add-finance): document Plan 3 PR 1 → PR 2 upgrade path\` — SKILL.md guidance for operators

## Operator rollout (post-merge)

Documented in \`SKILL.md\` "From Plan 3 PR 1 → Plan 3 PR 2 (Levis behavior)":

1. \`git pull\`
2. \`cp .claude/skills/add-finance/system-prompt.md groups/finance/system-prompt.md\`
3. \`/clear\` the finance bot in Telegram
4. Smoke-test:
   - "gastei R\$50 no Spotify" → card asks subcategoria
   - "corta o X" → confirms cut, asks motivo
   - "onde economizar?" → answer does NOT include Saúde/Educação/Dívidas
   - "exporta o doc" → confirms intent, generates diff card

## Why phased

Levis is in production (Jonas uses daily). PR 1 added columns; PR 2 activates them in chat. Splitting these into separate PRs lets the operator validate the Sheet schema FIRST (without behavior risk), then activate the behavior with a single \`/clear\`.

## Risks

- Operator merges PR 2 without running PR 1's migration → Levis tries to write to columns that don't exist → Composio errors. Mitigation: PR description (this paragraph) + SKILL.md \"Prerequisite\" note.
- Operator forgets to \`/clear\` after \`cp\` → bot keeps using old system-prompt → no obvious symptom, just silent regression. Mitigation: SKILL.md smoke-test list.
- Cards too long for Telegram → unlikely; checked max card is ~10 lines.

## Plan 3 path

- PR 1 (merged) — schema + bootstrap
- **PR 2 (this)** — Levis behavior (new intents, sensibilidade rule, exportar_doc)
- PR 3 — three new crons + \`/add-finance\` skill template polish for new installs

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed.

---

## Self-review (mental check before handoff)

**Spec coverage:**
- §4.1 new intents (`exportar_doc`, `cortar_recorrente`, cron-only triplet) — Steps 1.3 + 1.5 + 1.11 ✓
- §4.2 updated intents (`registrar_despesa`/`registrar_receita`/`cadastrar_recorrente`/`sugerir_economias`) — Steps 1.2a–d + 1.4a–c ✓
- §4.3 new principles (sensibilidade, hierarquia, status histórico, doc read-on-need) — Step 1.1 ✓
- §4.4 CLAUDE.md updates (Categorias sensíveis + Doc canônico sections) — already shipped in PR 1 ✓
- §7 `exportar_doc` workflow — Step 1.11 ✓

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N". Every Step has the exact text to find and the exact replacement.

**Type/name consistency:**
- `codigo`, `codigo_prefixo`, `categoria_pai`, `subcategoria`, `status` (enum ATIVO|CORTADO|PENDENTE|ENCERRADO), `data_corte`, `motivo_corte`, `termina_em`, `parcelas_restantes`, `sensibilidade` (enum alta|media|nenhuma), `nao_sugerir_corte` — all match PR 1's `claude-md-template.md` and the spec exactly.
- Intent names: `exportar_doc`, `cortar_recorrente`, `auditar_assinaturas`, `revisao_estrutural`, `revisao_anual` — consistent across vocabulario, cards, principles.
- Layout cols A→M is 13 letters — confirmed: 'A' is 1, 'M' is 13. ✓.

**One discrepancy worth noting:** Step 1.11 says "Use `Write` ferramenta pra sobrescrever" in the `exportar_doc` workflow. Levis runs inside a container — the `Write` MCP tool is available (alongside `Read`). If the operator hasn't enabled that tool yet (some installs lock down filesystem writes), `exportar_doc` will fail at step 6 with a permission error. **Not blocking for PR 2**, but flag in the smoke-test checklist (which it already does — "se algum smoke-test falhar...").

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-15-finance-plan3-pr2-levis-behavior.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
