# Bootstrap Sheet — instruction prompt

(Operator: paste this **entire message** into the bot once after install steps 1–6 are complete. Bot will execute via Composio googlesheets MCP. At the end, bot returns the SHEET_ID for the operator to record in `groups/finance/CLAUDE.md`.)

---

Você vai criar a workbook "Finance — Jonas" do zero. Use Composio googlesheets. Execute na ordem abaixo. Para cada passo, reporte progresso curto ("✅ Tab Lançamentos-PF criada", "✅ Headers escritos", etc.).

## ⚠️ AVISO LOCALE pt-BR (load-bearing — leia antes de qualquer fórmula)

A spreadsheet vai ser criada com `locale=pt_BR` (Passo 2). Em pt-BR, **fórmulas usam `;` como separador de argumentos, não `,`** e **`,` é o separador decimal**. Os exemplos de fórmula abaixo neste prompt usam `,` em vários lugares (estilo en-US) — você DEVE traduzir pra pt-BR antes de escrever:

- `SUMIFS(A:A, B:B, "x")` → `SUMIFS(A:A; B:B; "x")`
- `DATE(2026, 5, 1)` → `DATE(2026; 5; 1)`
- `INDEX(E:E, 5)` → `INDEX(E:E; 5)`
- `0.8` → `0,8`
- Strings com `'` literal: use `CHAR(39)` se o SDK estiver escapando

**Exceção:** dentro da string da query do `QUERY(...; "select Col1,Col2 ...")` o `,` interno é da linguagem QUERY (não Sheets), mantém `,`. SÓ o separador EXTERNO entre args da função QUERY vira `;`.

Aplique essa regra a TODAS as fórmulas dos Passos 5–10. Não pode pular.

## Passo 0 — Descobrir tools disponíveis

Antes de começar, lista as tools `googlesheets` que você tem no MCP. Os nomes que sugiro abaixo (`GOOGLESHEETS_CREATE_GOOGLE_SHEET1`, etc.) são chutes — **use o nome exato que existir no seu MCP**. Se houver dúvida sobre qual tool faz o que, peça schema.

## Passo 1 — Criar a spreadsheet

Use a tool de criação (provavelmente algo como `GOOGLESHEETS_CREATE_GOOGLE_SHEET1` ou `GOOGLESHEETS_CREATE_SPREADSHEET`):

- `title`: `Finance — Jonas`

Capture o `spreadsheetId` retornado. Você vai usá-lo em todos os passos seguintes. Ao final, você vai me devolver esse ID.

## Passo 2 — Configurar locale e timezone da spreadsheet

Use `GOOGLESHEETS_BATCH_UPDATE`:

```json
{
  "spreadsheet_id": "<id do passo 1>",
  "requests": [
    {
      "updateSpreadsheetProperties": {
        "properties": {
          "locale": "pt_BR",
          "timeZone": "America/Sao_Paulo"
        },
        "fields": "locale,timeZone"
      }
    }
  ]
}
```

## Passo 3 — Criar as 12 abas

A spreadsheet vem com uma aba `Sheet1` por default. Você vai:
1. Renomear `Sheet1` → `Dashboard`
2. Adicionar as outras 11 abas

Use um único `GOOGLESHEETS_BATCH_UPDATE` com este `requests`:

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

Capture os `sheetId` retornados de cada `addSheet` na resposta — você vai precisar deles pros próximos passos (formatação, validação, conditional formatting).

## Passo 4 — Escrever cabeçalhos de cada aba

Use `GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER` (ou múltiplos `BATCH_UPDATE_VALUES`) com `valueInputOption: "USER_ENTERED"`:

| Aba | Range | Linha 1 (cabeçalhos) |
|---|---|---|
| `Lançamentos-PF` | `A1:L1` | `id`, `data`, `tipo`, `valor`, `categoria`, `descricao`, `origem`, `recorrente_id`, `criado_em`, `conta_origem`, `conta_destino`, `meio_pagamento` |
| `Lançamentos-PJ` | `A1:L1` | mesma coisa |
| `Recorrentes` | `A1:K1` | `id`, `escopo`, `nome`, `tipo`, `valor`, `categoria`, `frequencia`, `dia_do_mes`, `proxima_data`, `pago_no_mes`, `ativo` |
| `Orçamento` | `A1:F1` | `escopo`, `categoria`, `teto_mensal`, `gasto_no_mes`, `pct_usado`, `status` |
| `Projeção` | `A1:E1` | `mes`, `receitas_recorrentes`, `despesas_recorrentes`, `saldo_mes`, `saldo_acumulado` |
| `Lembretes` | `A1:E1` | `id`, `quando`, `mensagem`, `linhagem`, `enviado_em` |
| `Categorias` | `A1:C1` | `escopo`, `categoria`, `ativo` |
| `Contas` | `A1:F1` | `id`, `escopo`, `nome`, `saldo_inicial`, `saldo_atual`, `ativo` |
| `MeiosPagamento` | `A1:D1` | `id`, `nome`, `vinculado_a_conta`, `ativo` |
| `Recebiveis` | `A1:G1` | `id`, `descricao`, `valor`, `conta_destino`, `data_prevista`, `status`, `criado_em` |
| `_Log` | `A1:E1` | `timestamp`, `job`, `status`, `qtd_processada`, `detalhes` |

Para `Dashboard`: deixa A1:A1 com "Finance — Jonas" e a partir de A3 a estrutura virá no Passo 9.

## Passo 5 — Formatar headers (bold + congelar linha 1)

Use `GOOGLESHEETS_BATCH_UPDATE` com 2 tipos de request por aba (exceto Dashboard, que tem layout próprio):

```json
[
  {"repeatCell": {
    "range": {"sheetId": <sheetId>, "startRowIndex": 0, "endRowIndex": 1},
    "cell": {"userEnteredFormat": {"textFormat": {"bold": true}, "backgroundColor": {"red": 0.93, "green": 0.93, "blue": 0.93}}},
    "fields": "userEnteredFormat(textFormat,backgroundColor)"
  }},
  {"updateSheetProperties": {
    "properties": {"sheetId": <sheetId>, "gridProperties": {"frozenRowCount": 1}},
    "fields": "gridProperties.frozenRowCount"
  }}
]
```

## Passo 6 — Formatação numérica BRL na coluna `valor`

Para `Lançamentos-PF`, `Lançamentos-PJ` (coluna D), `Recorrentes` (coluna E), `Orçamento` (colunas C e D), `Contas` (colunas D e E), `Recebiveis` (coluna C):

```json
{"repeatCell": {
  "range": {"sheetId": <sheetId>, "startRowIndex": 1, "startColumnIndex": <col>, "endColumnIndex": <col+1>},
  "cell": {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY", "pattern": "[$R$ ]#,##0.00"}}},
  "fields": "userEnteredFormat.numberFormat"
}}
```

Para `Orçamento.pct_usado` (coluna E): `"type": "PERCENT", "pattern": "0.00%"`.
Para `Projeção` valores (B, C, D, E): `CURRENCY` BRL.
Para `Recebiveis.data_prevista` (coluna E): `"type": "DATE", "pattern": "dd/mm/yyyy"`.

## Passo 7 — Data validation (dropdowns)

Use `setDataValidation`:

**`Lançamentos-PF.tipo` e `Lançamentos-PJ.tipo` (col C, do row 2 ao 10000):**

```json
{"setDataValidation": {
  "range": {"sheetId": <sheetId>, "startRowIndex": 1, "endRowIndex": 10000, "startColumnIndex": 2, "endColumnIndex": 3},
  "rule": {
    "condition": {"type": "ONE_OF_LIST", "values": [{"userEnteredValue": "despesa"}, {"userEnteredValue": "receita"}]},
    "strict": true, "showCustomUi": true
  }
}}
```

**`Lançamentos-{PF,PJ}.categoria` (col E):** dropdown da range `Categorias!B:B` (filtra escopo via fórmula no front-end seria ideal, mas deixar mais permissivo é OK no MVP — agente valida via system-prompt):

```json
{"setDataValidation": {
  "range": {"sheetId": <sheetId>, "startRowIndex": 1, "endRowIndex": 10000, "startColumnIndex": 4, "endColumnIndex": 5},
  "rule": {
    "condition": {"type": "ONE_OF_RANGE", "values": [{"userEnteredValue": "=Categorias!$B$2:$B"}]},
    "strict": true, "showCustomUi": true
  }
}}
```

**`Recorrentes.escopo` (col B):** dropdown PF/PJ.
**`Recorrentes.tipo` (col D):** dropdown despesa/receita.
**`Recorrentes.frequencia` (col G):** dropdown mensal/semanal/anual.
**`Recorrentes.pago_no_mes` (col J):** checkbox.
**`Recorrentes.ativo` (col K):** checkbox.
**`Orçamento.escopo` (col A):** dropdown PF/PJ.
**`Categorias.escopo` (col A):** dropdown PF/PJ.
**`Categorias.ativo` (col C):** checkbox.
**`Contas.escopo` (col B):** dropdown PF/PJ.
**`Contas.ativo` (col F):** checkbox.
**`MeiosPagamento.ativo` (col D):** checkbox.
**`Recebiveis.status` (col F):** dropdown ONE_OF_LIST `["esperado", "recebido", "atrasado", "cancelado"]`.
**`Lançamentos-{PF,PJ}.conta_origem` (col J, rows 2-10000):** dropdown ONE_OF_RANGE `=Contas!$C$2:$C` (nomes das contas).
**`Lançamentos-{PF,PJ}.conta_destino` (col K, rows 2-10000):** dropdown ONE_OF_RANGE `=Contas!$C$2:$C`.
**`Lançamentos-{PF,PJ}.meio_pagamento` (col L, rows 2-10000):** dropdown ONE_OF_RANGE `=MeiosPagamento!$B$2:$B`.

## Passo 8 — Fórmulas

### `Recorrentes.proxima_data` (col I, do row 2 ao 1000)

```
=IFS(
  G2="mensal", IF(DAY(TODAY())<=H2, DATE(YEAR(TODAY()), MONTH(TODAY()), H2), DATE(YEAR(TODAY()), MONTH(TODAY())+1, H2)),
  G2="semanal", TODAY()+MOD(7-WEEKDAY(TODAY())+H2,7),
  G2="anual", DATE(YEAR(TODAY())+IF(DATE(YEAR(TODAY()),1,H2)<TODAY(),1,0),1,H2)
)
```

(Use `arrayformula` se preferir aplicar de uma só vez na coluna inteira.)

### `Orçamento.gasto_no_mes` (col D)

```
=SUMIFS(
  INDIRECT("'Lançamentos-"&A2&"'!D:D"),
  INDIRECT("'Lançamentos-"&A2&"'!C:C"), "despesa",
  INDIRECT("'Lançamentos-"&A2&"'!E:E"), B2,
  INDIRECT("'Lançamentos-"&A2&"'!B:B"), ">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1),
  INDIRECT("'Lançamentos-"&A2&"'!B:B"), "<="&EOMONTH(TODAY(),0)
)
```

### `Orçamento.pct_usado` (col E)

```
=IFERROR(D2/C2, 0)
```

### `Orçamento.status` (col F)

```
=IF(E2>1, "❌ estourou", IF(E2>0.8, "⚠️ 80%", "OK"))
```

### `Projeção` (rows 2 a 7, próximos 6 meses)

Coluna A (`mes`):
- A2: `=TEXT(TODAY(), "yyyy-mm")`
- A3: `=TEXT(EDATE(TODAY(),1), "yyyy-mm")`
- A4: `=TEXT(EDATE(TODAY(),2), "yyyy-mm")`
- (e assim por diante até A7)

Coluna B (`receitas_recorrentes`):
```
=SUMIFS(Recorrentes!E:E, Recorrentes!D:D, "receita", Recorrentes!K:K, TRUE, Recorrentes!G:G, "mensal")
```
(Para semanal/anual a fórmula complica — MVP só considera mensal. Revisitar em v2.)

Coluna C (`despesas_recorrentes`):
```
=SUMIFS(Recorrentes!E:E, Recorrentes!D:D, "despesa", Recorrentes!K:K, TRUE, Recorrentes!G:G, "mensal")
```

Coluna D (`saldo_mes`):
```
=B2-C2
```

Coluna E (`saldo_acumulado`):
- E2: `=SALDO_INICIAL + D2`
- E3: `=E2 + D3`
- E4..E7: idem (acumular)

### Named range `SALDO_INICIAL`

Crie célula `Projeção!H1` com label "Saldo inicial:" em G1 e valor 0 em H1. Defina named range `SALDO_INICIAL` apontando pra `Projeção!H1`:

```json
{"addNamedRange": {
  "namedRange": {
    "name": "SALDO_INICIAL",
    "range": {"sheetId": <projeção_sheetId>, "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 7, "endColumnIndex": 8}
  }
}}
```

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

## Passo 9 — Layout do Dashboard

Aba `Dashboard`. Em cada bloco, A=label, B=valor.

| Cell | Conteúdo |
|---|---|
| A1 | `="Finance — Jonas — " & TEXT(TODAY(), "mmmm/yyyy")` (aplicar bold + tamanho 14) |
| A3 | `Receitas PF (mês)` |
| B3 | `=SUMIFS('Lançamentos-PF'!D:D, 'Lançamentos-PF'!C:C, "receita", 'Lançamentos-PF'!B:B, ">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1))` |
| A4 | `Despesas PF (mês)` |
| B4 | `=SUMIFS('Lançamentos-PF'!D:D, 'Lançamentos-PF'!C:C, "despesa", 'Lançamentos-PF'!B:B, ">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1))` |
| A5 | `Saldo PF (mês)` |
| B5 | `=B3-B4` |
| A7 | `Receitas PJ (mês)` |
| B7 | `=SUMIFS('Lançamentos-PJ'!D:D, 'Lançamentos-PJ'!C:C, "receita", 'Lançamentos-PJ'!B:B, ">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1))` |
| A8 | `Despesas PJ (mês)` |
| B8 | `=SUMIFS('Lançamentos-PJ'!D:D, 'Lançamentos-PJ'!C:C, "despesa", 'Lançamentos-PJ'!B:B, ">="&DATE(YEAR(TODAY()),MONTH(TODAY()),1))` |
| A9 | `Saldo PJ (mês)` |
| B9 | `=B7-B8` |
| A11 | `Saldos PF` |
| A12 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PF' and Col2 is not null"; 0)` |
| A16 | `Saldos PJ` |
| A17 | `=QUERY({Contas!B:E}; "select Col2,Col4 where Col1='PJ' and Col2 is not null"; 0)` |
| A21 | `Próximas contas (7d)` |
| A22 | `=QUERY({Recorrentes!B:I}, "select Col2,Col4,Col8 where Col10=FALSE and Col9 >= date '"&TEXT(TODAY(),"yyyy-mm-dd")&"' and Col9 <= date '"&TEXT(TODAY()+7,"yyyy-mm-dd")&"' order by Col8", 0)` |
| A28 | `Saldo projetado (+3m)` |
| B28 | `=INDEX(Projeção!E:E, 4)` |
| A29 | `Saldo projetado (+6m)` |
| B29 | `=INDEX(Projeção!E:E, 7)` |

⚠️ Dentro da string da query do `QUERY(...)`, `,` é da linguagem QUERY — mantém `,`. Fora da string (separador entre args da função QUERY), usa `;` (pt-BR).

(Top 5 categorias, lembretes pendentes, etc. ficam pra v2 do dashboard — MVP cobre o essencial.)

## Passo 10 — Conditional formatting

`Orçamento.status` (col F):
- Verde se contém "OK"
- Amarelo se contém "⚠️"
- Vermelho se contém "❌"

```json
{"addConditionalFormatRule": {
  "rule": {
    "ranges": [{"sheetId": <orçamento_sheetId>, "startRowIndex": 1, "startColumnIndex": 5, "endColumnIndex": 6}],
    "booleanRule": {
      "condition": {"type": "TEXT_CONTAINS", "values": [{"userEnteredValue": "OK"}]},
      "format": {"backgroundColor": {"red": 0.85, "green": 0.95, "blue": 0.85}}
    }
  }, "index": 0
}}
```

(Repetir 2x mais com "⚠️" → amarelo claro, "❌" → vermelho claro.)

## Passo 11 — Seed Categorias

Inserir 15 linhas em `Categorias!A2:C16` (use os dados de `categorias-seed.json`). `BATCH_UPDATE_VALUES` com `valueInputOption: "USER_ENTERED"`:

```
[
  ["PF", "Alimentação", true],
  ["PF", "Transporte", true],
  ["PF", "Moradia", true],
  ["PF", "Saúde", true],
  ["PF", "Lazer", true],
  ["PF", "Educação", true],
  ["PF", "Assinaturas", true],
  ["PF", "Impostos", true],
  ["PF", "Outros", true],
  ["PJ", "Pró-labore", true],
  ["PJ", "Fornecedores", true],
  ["PJ", "Infraestrutura", true],
  ["PJ", "Marketing", true],
  ["PJ", "Impostos", true],
  ["PJ", "Outros", true]
]
```

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

## Passo 12 — Reportar resultado

Mensagem final pro operador:

```
✅ Workbook criada com sucesso!
SHEET_ID: <id>
URL: https://docs.google.com/spreadsheets/d/<id>/edit

Próximos passos:
1. Substitua __SHEET_ID__ e __SHEET_URL__ no groups/finance/CLAUDE.md
2. Reinicie a sessão do agente finance pra ele recarregar CLAUDE.md
3. Rode o checklist de verificação no SKILL.md
```
