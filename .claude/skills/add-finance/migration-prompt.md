# Migration prompt — Plan 1 → Plan 2

(Operator: paste no @<bot> apenas se voce já rodou o bootstrap Plan 1 e quer adicionar Contas/MeiosPagamento/Recebíveis sem perder dados existentes.)

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
