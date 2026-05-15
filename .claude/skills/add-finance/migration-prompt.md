# Migration prompt — Plan 2.5 → Plan 3

(Operator: cola este bloco inteiro no `@<bot>` quando estiver pronto para migrar a planilha pra Plan 3. Executa Steps A–E em sequência via Composio googlesheets. **Idempotente** — re-rodar é seguro; cada subpasso verifica antes de escrever.)

Pré-condições:
- Plan 2.5 vivo na planilha (12 abas, 5 crons). Se ainda está em Plan 1 ou 2, primeiro rode a migration antiga (no git history desta skill) ou contate o time.
- (Opcional, recomendado) Você mantém um doc canônico (`Controle_Despesas_Jonas_DOC.md` ou nome equivalente) no diretório do agente (`groups/<agente>/`, montado em `/workspace/agent/` pra o agente) com o estado real dos seus recorrentes — taxonomia, status, histórico de decisões. **Step D usa esse doc pra bootstrap.** Se você não tem o doc, Step D fica vazio (skipa) e você cadastra os recorrentes manualmente depois via chat.
- Você revisou este prompt antes de colar.

---

Vou migrar a workbook de Plan 2.5 (12 abas, `ativo: bool` em Recorrentes) pra Plan 3 (14 abas + cols novas em Recorrentes/Lançamentos + opcionalmente bootstrap de recorrentes do doc canônico + opcionalmente seed de decisões históricas).

⚠️ **LOCALE pt-BR:** separadores `;`, decimal `,`.
⚠️ **SHEET_ID:** uso o configurado em `CLAUDE.md` — não pergunto ao operator.
⚠️ **Idempotência:** antes de cada subpasso, verifico se já está feito (`lookupSheetByTitle`, `getValuesByA1`, `lookupRow`) — pulo se sim.
⚠️ **Linha legado preservada:** `Recorrentes.ativo` (col K) é **renomeada** pra `_legacy_ativo`, não deletada. Mais seguro: preserva refs e evita shifting de letras de coluna que quebraria fórmulas em `proxima_data`. Plan 3.1 dropa essa coluna depois.

---

## Step A — Schema (abas novas + colunas novas + validações)

### A.1 Adicionar abas `Subcategorias` e `Decisoes`

Antes da chamada: `GOOGLESHEETS_VALUES_GET` em `Subcategorias!A1:F1`. Se retornar com dados (a aba já existe), pula direto pra A.2.

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

Capture os 2 novos `sheetId`s (precisa pra validações em A.6).

### A.2 Headers + formatação das abas novas

`Subcategorias` (A1:F1): `nome`, `categoria_pai`, `escopo`, `codigo_prefixo`, `sensibilidade`, `nao_sugerir_corte`
`Decisoes` (A1:E1): `data`, `item_id`, `tipo`, `detalhes`, `impacto_mensal`

Pra cada uma: bold + grey background + frozen row 1 (igual aos headers existentes; usa `repeatCell`).

Formatação BRL em `Decisoes!E:E`. Formatação data em `Decisoes!A:A`.

### A.3 Estender header de `Categorias` — adicionar `codigo_prefixo`

Antes: `GOOGLESHEETS_VALUES_GET` em `Categorias!C1`. Se já for `codigo_prefixo`, pula.

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Categorias!C1`: valor `codigo_prefixo`.

(Assumindo schema Plan 2.5: A=`nome`, B=`escopo`. Se sua planilha tem `Categorias` flat com outras cols, ajusta a letra.)

### A.4 Adicionar 7 colunas a `Recorrentes`

Headers nas cols L1:R1. (Plan 2.5 ocupa A:K com `ativo` em K.)

| Col | Header |
|---|---|
| L1 | `codigo` |
| M1 | `subcategoria` |
| N1 | `status` |
| O1 | `data_corte` |
| P1 | `motivo_corte` |
| Q1 | `termina_em` |
| R1 | `parcelas_restantes` |

Idempotência: ler `Recorrentes!L1:R1`, pular este passo se já bater.

**Renomear K1** (`ativo` → `_legacy_ativo`) com `GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Recorrentes!K1`. Preserva dados, marca como deprecada.

Aplicar: bold + frozen na linha 1 (estende formatação existente); formatação data em O e Q, number em R.

### A.5 Adicionar 1 coluna a `Lançamentos-PF` e `Lançamentos-PJ`

Header em M1 = `subcategoria` (assumindo Plan 2.5 ocupa A:L com cols de Plan 2 — `id, data, tipo, valor, categoria, descricao, origem, recorrente_id, criado_em, conta_origem, conta_destino, meio_pagamento`).

Idempotência: se M1 já é `subcategoria`, pula.

### A.6 Validações de dropdown

Aplicar `setDataValidation` em batch:

- `Subcategorias.escopo` (C2:C1000): ONE_OF_LIST `["PF", "PJ", "global"]`
- `Subcategorias.sensibilidade` (E2:E1000): ONE_OF_LIST `["alta", "media", "nenhuma"]`
- `Subcategorias.nao_sugerir_corte` (F2:F1000): checkbox
- `Recorrentes.status` (N2:N1000): ONE_OF_LIST `["ATIVO", "CORTADO", "PENDENTE", "ENCERRADO"]`
- `Recorrentes.subcategoria` (M2:M1000): ONE_OF_RANGE `=Subcategorias!$A$2:$A`
- `Decisoes.tipo` (C2:C1000): ONE_OF_LIST `["corte", "reclassificacao", "adicao", "correcao", "renomeacao", "migracao"]`
- `Categorias.escopo` (B2:B1000): ONE_OF_LIST `["PF", "PJ", "global"]` (se já existe, no-op)
- `Lançamentos-PF.subcategoria` (M2:M10000): ONE_OF_RANGE `=Subcategorias!$A$2:$A`
- `Lançamentos-PJ.subcategoria` (M2:M10000): ONE_OF_RANGE `=Subcategorias!$A$2:$A`

### A.7 Verificação

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!L1:R1` — deve retornar `["codigo", "subcategoria", "status", "data_corte", "motivo_corte", "termina_em", "parcelas_restantes"]`. Senão, aborte Step B com erro detalhando qual header está fora.

---

## Step B — Migrar dados existentes (`ativo` → `status`)

### B.1 Ler estado atual

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!A2:K1000`. Captura todas as linhas com seu `_legacy_ativo` (col K).

### B.2 Computar `status` por linha

Pra cada linha:
- `_legacy_ativo == TRUE` → `status = "ATIVO"`, `data_corte = ""`, `motivo_corte = ""`
- `_legacy_ativo == FALSE` → `status = "CORTADO"`, `data_corte = ""`, `motivo_corte = "(legado pre-Plan-3)"`

Outras cols novas (`codigo`, `subcategoria`, `termina_em`, `parcelas_restantes`) ficam vazias — Step D preenche pros itens do doc; linhas legadas que não estão no doc ficam com esses campos vazios (operator preenche organicamente).

### B.3 Escrever em batch

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Recorrentes!N2:P{N+1}` com a matriz computada (`status`, `data_corte`, `motivo_corte`). N = número de linhas existentes.

### B.4 Verificação

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!N2:N1000` — toda linha não-vazia deve ter `status` em `{"ATIVO", "CORTADO", "PENDENTE", "ENCERRADO"}`.

Idempotência: antes de B.3, lê col N. Se já estiver toda preenchida com valores válidos, pula Step B.

---

## Step C — Seed taxonomia (Categorias + Subcategorias)

### C.1 Categorias (3 linhas)

Idempotência: lookup por `nome` (col A). Pra cada das 3 linhas, escreve só se não existe.

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Categorias!A2:C4`:

```
| nome         | escopo  | codigo_prefixo |
|--------------|---------|----------------|
| Empresarial  | PJ      | EMP            |
| Residencial  | global  | RES            |
| Pessoal      | global  | PES            |
```

### C.2 Subcategorias (13 linhas)

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Subcategorias!A2:F14` (lookup por `nome`, pula se já existe):

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

- `Categorias!A2:A4` → 3 linhas non-empty
- `Subcategorias!A2:A14` → 13 linhas non-empty
- Toda linha de Subcategorias tem `codigo_prefixo` único de 3 letras

---

## Step D — Bootstrap recorrentes do doc canônico (opcional)

### D.1 Procurar o doc canônico

`Read` em `/workspace/agent/Controle_Despesas_Jonas_DOC.md` (ou nome equivalente que o operator mantém — listar `/workspace/agent/` e procurar arquivo terminando em `_DOC.md`).

Se não encontrar, **pula Step D inteiro** (a planilha fica com o que veio do migrate em Step B; operator cadastra novos recorrentes manualmente via chat depois). Loga `<internal>silent skip Step D: no doc canônico</internal>` mas continua pra Step E.

Se encontrar, parse:
- **Seção §3** (inventário ativo / pendente): heading `### 3.X.Y` indica subcategoria; `**\`CODIGO\`** — nome` indica um item; sub-linhas (`Valor:`, `Vencimento:`, `Status:`) trazem os campos.
- **Seção §4** (itens cortados / arquivo): mesmo padrão, mas `Status: CORTADO em YYYY-MM-DD` e linha `Motivo do corte:`.

Pra cada item, extrair:
- `codigo` — heading bold (ex `EMP-IAL-001`)
- `nome` — após o "—" no heading
- `valor` — linha "Valor:" (BRL; pra USD usa o "→ R$ X,YY" do próprio doc, que aplica a rate documentada)
- `dia_do_mes` — linha "Vencimento:" se presente (number); senão NULL
- `status` — linha "Status:" (ATIVO / CORTADO / PENDENTE)
- `data_corte` — só pra CORTADO; "CORTADO em YYYY-MM-DD"
- `motivo_corte` — só pra CORTADO; linha "Motivo do corte:"
- `termina_em` — só presente quando o item tem "Data de término:" no doc; resto NULL
- `parcelas_restantes` — sempre NULL inicialmente (operator atualiza quando relevante)
- `categoria` + `subcategoria` — derivadas da hierarquia do doc (heading `### 3.1.1 IA & LLMs` = subcat "IA & LLMs"; pai vem da seção 3.1 = Empresarial)
- `escopo` — herdado de `Subcategorias.escopo` da subcat
- `tipo` — `despesa` (default; se o doc indicar `receita`, usa receita)
- `frequencia` — `mensal` (default; ajusta se doc diz outra coisa)
- `pago_no_mes` — FALSE

### D.2 Idempotência

`GOOGLESHEETS_VALUES_GET` em `Recorrentes!L2:L1000` — coletar todos os `codigo` já presentes. Pra cada item do doc, se `codigo` já existe na planilha, pula (não regrava — preserva edits manuais).

### D.3 Gerar `id` técnico pra cada novo

`id = "rec-" + 6 hex random` (mesma convenção dos Recorrentes já existentes).

### D.4 Escrever em batch

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Recorrentes!A{N+1}:R{N+M}` (N = última linha existente; M = quantidade de novos itens).

Layout das 18 cols:
```
A:id  B:escopo  C:nome  D:tipo  E:valor  F:categoria  G:frequencia  H:dia_do_mes
I:proxima_data  J:pago_no_mes  K:_legacy_ativo  L:codigo  M:subcategoria  N:status
O:data_corte  P:motivo_corte  Q:termina_em  R:parcelas_restantes
```

Pra `_legacy_ativo` (col K) em itens novos: TRUE pra ATIVO/PENDENTE, FALSE pra CORTADO (só pra consistência visual; o campo é deprecated).

Pra `proxima_data` (col I) em itens novos: replica a mesma fórmula `=DATE(...)` das linhas existentes, referenciando `H{row}`.

### D.5 Verificação

- `Recorrentes!L2:L1000` deve conter todos os `codigo` do doc, sem duplicatas
- Conta linhas com `status="ATIVO"` — deve bater com a contagem de ATIVO no doc

Loga sumário (`<message to="operator">{N} recorrentes bootstrapped: {ATIVO} ATIVO + {PENDENTE} PENDENTE + {CORTADO} CORTADO</message>`).

---

## Step E — Seed `Decisoes` (timeline, opcional)

### E.1 Procurar histórico no doc

Procurar seção `## 7. Histórico de Decisões` (ou nome equivalente) no doc canônico. Se não existe, pula Step E (Decisoes fica só com a linha de migracao do E.3).

### E.2 Escrever linhas históricas

`GOOGLESHEETS_UPDATE_VALUES_BATCH` em `Decisoes!A2:E{N+1}` com cada linha da tabela "Histórico de Decisões" do doc. Idempotência: lookup por `detalhes` (col D), pula se uma linha com o mesmo detalhes já existe.

Schema (espelha §3.5 do design spec):
| data | item_id (codigo, ou vazio) | tipo (enum) | detalhes (1 linha) | impacto_mensal (BRL signed) |

### E.3 Linha final de marca de migração

`GOOGLESHEETS_UPDATE_VALUES_BATCH` na primeira linha livre em `Decisoes`:

```
| <hoje ISO> |  | migracao | Plan 2.5 → Plan 3 bootstrap complete | 0 |
```

Idempotência: se uma linha `tipo=migracao` com `detalhes` igual já existe, pula.

### E.4 Log no `_Log`

`GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND` em `_Log!A:E`:
```
| <ISO timestamp> | plan3-bootstrap | success | {qtd_recorrentes_bootstrap} | "Subcategorias={13}; Decisoes={E2 count}; Recorrentes ATIVO={count}" |
```

### E.5 Resposta final ao operator

```
<message to="<operator>">✅ Plan 3 migration complete:
- 14 abas (adicionei Subcategorias + Decisoes)
- Recorrentes: +7 cols, status migrado de ativo → enum
- 13 subcategorias seeded
- {M} recorrentes bootstrapped do doc canônico ({ATIVO} ATIVO + {PENDENTE} PENDENTE + {CORTADO} CORTADO) — se doc estava presente
- {E2_count + 1} decisoes na timeline

Verifica via Sheets UI (checklist abaixo). Quando OK, pode mergeear PR 2 (atualização do agent pra usar Plan 3).</message>
```

Se algum step abortou, emite:
```
<message to="<operator>">⚠️ Plan 3 migration abortou em Step {X}.{Y}: {erro}.

Estado intermediário preservado — pode rodar de novo (idempotente). Pra rollback manual, ver seção "Rollback" no fim deste prompt.</message>
```

---

## Validation checklist (operator, após o bot reportar success)

Conferir via Sheets UI:

- [ ] 14 abas existem (Dashboard, Lançamentos-PF, Lançamentos-PJ, Recorrentes, Orçamento, Projeção, Lembretes, Categorias, **Subcategorias**, Contas, MeiosPagamento, Recebiveis, **Decisoes**, _Log)
- [ ] `Categorias` tem 3 linhas, cada uma com `codigo_prefixo` (EMP/RES/PES)
- [ ] `Subcategorias` tem 13 linhas, cada uma com `categoria_pai` válido, `codigo_prefixo` único, e `sensibilidade` setada
- [ ] `Recorrentes`:
  - Todo linha pré-Plan-3 tem `status` setado (ATIVO ou CORTADO)
  - Linhas do doc (se rodou Step D) têm `codigo` no formato `XXX-YYY-NNN`
  - Pelo menos 1 linha tem `status=CORTADO` com `motivo_corte` preenchido (de Step B ou Step D)
- [ ] `Decisoes` tem 1 linha `tipo=migracao` no final
- [ ] `_Log` tem entrada `plan3-bootstrap success`

Tudo OK? Migração validada. O agent ainda opera em comportamento Plan 2.5 — não usa as colunas novas (subcategoria, codigo, sensibilidade) até PR 2 do Plan 3.

---

## Rollback

Se algo deu muito errado e o operator quer voltar pra Plan 2.5:

1. **Restaurar Recorrentes:**
   - col K1 volta a ser `ativo` (rename inverso)
   - cols L:R são apagadas (`deleteDimension` — careful com índices)
2. **Apagar abas novas:** `deleteSheet` em `Subcategorias` e `Decisoes`
3. **Categorias:** col C (`codigo_prefixo`) apagada
4. **Lançamentos-PF / Lançamentos-PJ:** col M (`subcategoria`) apagada

Nenhum dado de Plan 2.5 foi sobrescrito — todas as colunas/abas novas são aditivas, e `ativo → _legacy_ativo` é só rename. Status real do Plan 2.5 está preservado em `_legacy_ativo`.

Se preferir manter dados de Plan 3 (subcategorias, codigos, decisões) mas pausar o uso: deixe a planilha como está e mantenha o agent em comportamento Plan 2.5 (system-prompt antigo). PR 2 do Plan 3 ativa o uso completo.
