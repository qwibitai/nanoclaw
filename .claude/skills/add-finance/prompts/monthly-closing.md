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
