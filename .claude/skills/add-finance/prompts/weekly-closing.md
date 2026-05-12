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
