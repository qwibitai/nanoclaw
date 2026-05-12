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

Se TODAS estas condições forem verdadeiras: `lançamentos_ontem_PF + lançamentos_ontem_PJ` vazios, `recorrentes_proximos + recebiveis_proximos` vazios, `orçamentos_alerta` vazio — use versão curta:

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
