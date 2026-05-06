---
name: naia-tracker-sheets
description: Schema operacional e protocolos de leitura/escrita do tracker da Naia no Google Sheets (`naia-tracker-jonas`). Use SEMPRE que: (1) precisar registrar uma pesagem da balança Leach (foto ou números soltos); (2) Jonas mandar mensagem de fim de dia descrevendo o que comeu/bebeu/dormiu; (3) Jonas avisar que aplicou o Monjaro semanal; (4) chegar resultado de exame laboratorial; (5) houver decisão clínica nova (Dra. Natália / Isabela) pra registrar na timeline; (6) precisar consultar histórico de peso, adesão, sintomas. Carregue antes de chamar qualquer tool `googlesheets` no contexto da Naia.
---

# Naia Tracker — Schema operacional do Google Sheets

Documento de referência pra ler e escrever no tracker pessoal do Jonas. **Sempre carregue antes de chamar tools `googlesheets`** — o schema é fixo e único; chutar coluna gera dado quebrado e fórmula errada.

## Spreadsheet

- **ID:** `1SaFXt8hpuzlJ-S-DuWdiXOpzvF6xq1RjlAfIFKNs2tw`
- **Nome do arquivo:** `naia-tracker-jonas`
- **Time zone:** America/Recife (UTC-3)
- **Padrão de data:** `YYYY-MM-DD` (ISO). De hora: `HH:MM` 24h.
- **Acesso:** via Composio toolkit `googlesheets` (descobrir slugs via `COMPOSIO_SEARCH_TOOLS`)

## Mapa rápido das 7 abas

| Aba | Você ESCREVE? | Quando |
|---|---|---|
| `📖 leia_primeiro` | ❌ não | capa instrucional |
| `dashboard` | ❌ não | painel auto (Jonas) |
| `visao_equipe` | ❌ não | painel auto (Dra./Isabela) |
| `pesagens` | ✅ append | foto da balança Leach ou pesagem manual |
| `diario` | ✅ append | mensagem de fim de dia parseada |
| `monjaro` | ✅ append | aplicação semanal do Monjaro |
| `exames` | ✅ append | cada marcador de cada coleta |
| `eventos_clinicos` | ✅ append | decisão clínica (consulta, ajuste, plano novo) |

---

## ABA `pesagens` — schema completo

**Granularidade:** uma linha por pesagem completa na balança Leach.

**31 colunas** (você preenche as 27 primeiras + `obs`; as 4 `delta_*` são fórmulas — **NÃO preencha, deixa em branco**):

| # | Coluna | Tipo | Origem |
|---:|---|---|---|
| A | `data` | YYYY-MM-DD | mensagem do Jonas ou EXIF da foto |
| B | `hora` | HH:MM | idem |
| C | `peso_kg` | número (1 casa) | balança |
| D | `musculo_kg` | número (1 casa) | balança |
| E | `gordura_kg` | número (1 casa) | balança |
| F | `gordura_pct` | número (1 casa) | balança |
| G | `imc` | número (1 casa) | balança |
| H | `agua_corporal_kg` | número (1 casa) | balança |
| I | `tmb_kcal` | número inteiro | balança |
| J | `gordura_visceral` | número inteiro (nível °) | balança |
| K | `idade_corpo` | número inteiro | balança |
| L | `mm_braco_esq_kg` | número (2 casas) | bioimpedância segmentar |
| M | `mm_braco_esq_pct` | número (1 casa) | idem |
| N | `mm_braco_dir_kg` | número | idem |
| O | `mm_braco_dir_pct` | número | idem |
| P | `mm_perna_esq_kg` | número | idem |
| Q | `mm_perna_esq_pct` | número | idem |
| R | `mm_perna_dir_kg` | número | idem |
| S | `mm_perna_dir_pct` | número | idem |
| T | `gor_braco_esq_kg` | número | idem |
| U | `gor_braco_esq_pct` | número | idem |
| V | `gor_braco_dir_kg` | número | idem |
| W | `gor_braco_dir_pct` | número | idem |
| X | `gor_perna_esq_kg` | número | idem |
| Y | `gor_perna_esq_pct` | número | idem |
| Z | `gor_perna_dir_kg` | número | idem |
| AA | `gor_perna_dir_pct` | número | idem |
| AB | `delta_peso_kg` | **fórmula** | NÃO preencher |
| AC | `delta_gordura_kg` | **fórmula** | NÃO preencher |
| AD | `delta_musculo_kg` | **fórmula** | NÃO preencher |
| AE | `delta_visceral` | **fórmula** | NÃO preencher |
| AF | `obs` | texto livre | suas notas (ex: "primeira pesagem após Monjaro") |

**Range pra append:** `pesagens!A:AF` (deixe `AB:AE` vazias na linha — fórmula resolve)

### Protocolo de OCR — print da balança Leach

Quando Jonas mandar foto da balança, faça o OCR em duas passadas:

**Passada 1 — corpo principal (visor central):** extrair os 11 campos de medição global (peso até idade do corpo).

**Passada 2 — bioimpedância segmentar:** extrair 16 campos (4 segmentos × 4 valores: massa magra kg/%, gordura kg/%).

Mapeamento direto print → coluna:

| Campo na balança | Coluna(s) |
|---|---|
| Peso (kg) | C |
| Massa muscular total (kg) | D |
| Gordura corporal (kg / %) | E, F |
| IMC | G |
| Água corporal (kg) | H |
| Taxa metabólica basal (kcal) | I |
| Grau de gordura visceral (°/Nível) | J |
| Idade do corpo | K |
| Massa magra braço esq (kg, %) | L, M |
| Massa magra braço dir (kg, %) | N, O |
| Massa magra perna esq (kg, %) | P, Q |
| Massa magra perna dir (kg, %) | R, S |
| Gordura segmentar braço esq (kg, %) | T, U |
| Gordura segmentar braço dir (kg, %) | V, W |
| Gordura segmentar perna esq (kg, %) | X, Y |
| Gordura segmentar perna dir (kg, %) | Z, AA |

**Confirmação antes de gravar:** sempre devolva os números extraídos pro Jonas em formato compacto e peça "ok pra registrar?":

```
Peso 142,7 | gordura 36,1% (51,5kg) | músculo 73,0kg | IMC 41,7 | visceral 19° | idade corpo 48
Bioimpedância: ok extrair também?

Confirma esses valores pra registrar?
```

Se ele responder com correção, ajuste e re-confirme. Só grava após "ok"/"sim"/"manda".

### Leitura comparativa após gravar (OBRIGATÓRIO)

Não basta confirmar "registrado". Sempre puxe a pesagem anterior (`GET pesagens` ordenado por data desc, primeira linha antes da atual) e devolva:

```
Pesagem registrada: 142,7 kg em 03/05.
Comparado à última (24/04, 148,2 kg): -5,5 kg em 9 dias.
✅ Massa muscular preservada (delta +0,2 kg).
⚠️ % gordura 36,1% (era 36,3%) — leve queda; visceral ainda em 19°.

Leitura: parte da queda inicial é água. Ritmo a seguir vai ser mais constante.
```

Sempre marque com ✅ o que melhorou, ⚠️ o que merece atenção.

---

## ABA `diario` — schema completo

**Granularidade:** uma linha por dia.

**30 colunas**. `adesao_pct` é fórmula automática — não preencha.

| # | Coluna | Tipo | Notas |
|---:|---|---|---|
| A | `data` | YYYY-MM-DD | dia descrito |
| B | `cafe_feito` | sim/não | |
| C | `cafe_componentes` | texto | "whey, ovo, mamão, chia" |
| D | `almoco_feito` | sim/não | |
| E | `almoco_proteina_primeiro` | sim/não/null | só marca sim se Jonas confirmou |
| F | `almoco_componentes` | texto | "frango, arroz integral, salada, abobrinha" |
| G | `lanche_feito` | sim/não | |
| H | `lanche_componentes` | texto | |
| I | `jantar_feito` | sim/não | |
| J | `jantar_descricao` | texto | "tapioca com frango" |
| K | `jantar_dentro_plano` | sim/não | sim para "lanche-jantar" leve; não para pizza/hambúrguer/etc |
| L | `ceia_feita` | sim/não | |
| M | `proteina_total_g` | número | estimativa em g (some das 4 refeições principais) |
| N | `agua_ml` | número inteiro | meta diária: ≥1500 ml |
| O | `energetico_latas` | número inteiro | meta progressiva: <5 |
| P | `doce_qtd` | número inteiro | porções (ex: 2 quadradinhos = 2; 1 brigadeiro = 1) |
| Q | `doce_descricao` | texto | "2 quadradinhos chocolate 70%" |
| R | `besteira_fora_plano` | sim/não | pizza, hambúrguer, fritura, sobremesa pesada |
| S | `besteira_descricao` | texto | "2 fatias pizza calabresa" |
| T | `intestino` | "ok"/"travado"/"solto" | |
| U | `sono_h` | número (1 casa) | horas dormidas |
| V | `sono_qualidade_1a5` | inteiro 1–5 | percepção subjetiva |
| W | `sintomas_monjaro` | texto | "enjoo leve manhã", "intestino travado", ou vazio |
| X | `hipoglicemia` | sim/não | |
| Y | `hipo_descricao` | texto | "14h30 atrasou almoço, tremedeira" |
| Z | `atividade_fisica` | texto | "caminhada 20min", "academia", ou vazio |
| AA | `humor_1a5` | inteiro 1–5 | |
| AB | `energia_1a5` | inteiro 1–5 | |
| AC | `adesao_pct` | **fórmula** | NÃO preencher |
| AD | `notas` | texto livre | observações que não encaixam em coluna |

**Range pra append:** `diario!A:AD` (deixe `AC` vazia)

### Protocolo de parsing de fim de dia

Mensagem típica:
> "Hoje café com whey + ovo + mamão, almoço completo, pulei lanche, jantar foi tapioca com frango, 1 doce, 4 energéticos, 700ml de água, dormi 5h, intestino ok, sem hipoglicemia."

Mapeamento:

| Pista linguística | Como preenche |
|---|---|
| "café com X, Y, Z" | `cafe_feito=sim`, `cafe_componentes="X, Y, Z"` |
| "pulei o café" / "não tomei café" | `cafe_feito=não` |
| "almoço completo" | `almoco_feito=sim`; só marque `almoco_proteina_primeiro=sim` se Jonas mencionou ter começado pela proteína |
| "almoço foi X, Y" | `almoco_feito=sim`, `almoco_componentes="X, Y"` |
| "lanche X" / "pulei o lanche" | preenche `lanche_*` |
| "jantar foi X" | `jantar_feito=sim`, `jantar_descricao="X"`, e marque `jantar_dentro_plano` por critério: tapioca/aipim/inhame/pão+patê/peixe leve = SIM; pizza/hambúrguer/fritura/massa pesada = NÃO |
| "1 doce" / "comi um chocolate" | `doce_qtd=1`, `doce_descricao` se especificado |
| "X energéticos" / "X latas" | `energetico_latas=X` |
| "Yml água" / "Y litros" | `agua_ml=Y` (litros × 1000) |
| "dormi Xh" | `sono_h=X` |
| "intestino X" | `intestino=X` |
| "tremedeira" / "suor frio" / "passei mal" / "hipoglicemia" | `hipoglicemia=sim`; pegue contexto (horário, gatilho) e ponha em `hipo_descricao` |
| "comi besteira" / "saí do plano" / "fritei" / "pizza" / "hambúrguer" | `besteira_fora_plano=sim`, `besteira_descricao` |
| "fui treinar" / "caminhei X" | `atividade_fisica="X"` |
| "humor bom/ruim" / "tô animado/desanimado" | `humor_1a5` (1=péssimo, 3=normal, 5=ótimo) — só preencha se ele indicou |
| "tô sem energia" / "energizado" | `energia_1a5` idem |

**Estimativa de proteína** (`proteina_total_g`): some manual da soma dos componentes baseado em `tabela-taco-essencial.md`. Se não der pra estimar (componentes vagos), deixe vazio.

### Confirmação antes de gravar

Sempre reapresenta a interpretação resumida em formato visual:

```
Entendi assim:
✅ Café (whey + ovo + mamão)
✅ Almoço completo
⚠️ Lanche pulado
✅ Jantar — tapioca com frango (dentro do plano)
🍫 1 doce, 🥤 4 energéticos, 💧 700ml água (meta 1500), 😴 5h sono
Sem hipoglicemia, intestino ok.

Posso registrar?
```

Só grava após "ok"/"sim"/"manda". Se Jonas corrigir, ajuste e re-confirme.

### Alertas que disparam APÓS registrar

Sempre que gravar uma linha em `diario`, rode estas checagens:

1. **`hipoglicemia=sim`** → comente o gatilho provável (intervalo longo? salto de refeição?) e lembre o protocolo de socorro do system prompt (Protocolo 9).
2. **`agua_ml < 1000` por 3 dias seguidos** (consultar últimos 3 dias antes de comentar) → recomende meta semanal de hidratação fracionada.
3. **`energetico_latas > 5`** → reforce o plano gradual de redução (sem cortar abrupto — ele tem dependência cafeínica).
4. **`besteira_fora_plano=sim`** → não julgar; pergunte contexto (foi evento? impulso? estresse?). Aplica Protocolo 7 ou 8 conforme o caso.
5. **`sono_h < 5` por 2 dias seguidos** → comente, mas não cobre — é estrutural pro Jonas.
6. **`almoco_feito=não` ou `lanche_feito=não` em dia útil** → flag de risco hipoglicemia pra próxima janela; sugira lanche estratégico.

Faça **no máximo 1 alerta por gravação** — se tiver vários disparando, escolha o mais crítico (ordem: hipoglicemia > besteira_fora_plano > demais). Não despeje 5 alertas de uma vez.

---

## ABA `monjaro` — schema

**Granularidade:** uma linha por aplicação semanal.

**7 colunas:**

| # | Coluna | Tipo | Notas |
|---:|---|---|---|
| A | `data_aplicacao` | YYYY-MM-DD | sábado típico |
| B | `dose_mg` | número | dose em mg (atual: 5) |
| C | `local_aplicacao` | texto | "abdômen direito" / "abdômen esquerdo" — Jonas alterna |
| D | `efeitos_colaterais` | texto | "enjoo leve dia 2", "intestino travado", vazio se nada |
| E | `tomou_vonal` | sim/não | |
| F | `intensidade_efeito_1a5` | inteiro 1–5 | 1=imperceptível, 5=incapacitante |
| G | `obs` | texto livre | |

**Range pra append:** `monjaro!A:G`

**Trigger:** Jonas avisa "apliquei hoje" (sábado típico) ou descreve efeito durante a semana → você associa à aplicação anterior e atualiza ou cria linha.

---

## ABA `exames` — schema

**Granularidade:** uma linha por marcador laboratorial (não por exame inteiro — explode cada parâmetro).

**9 colunas:** `flag` é fórmula automática (alto/baixo/normal) — não preencha.

| # | Coluna | Tipo | Notas |
|---:|---|---|---|
| A | `data_coleta` | YYYY-MM-DD | data da coleta de sangue |
| B | `exame` | texto | nome do marcador (ex: "Glicemia jejum", "HbA1c", "TSH", "Vit D 25-OH") |
| C | `resultado` | número | valor numérico |
| D | `unidade` | texto | "mg/dL", "%", "ng/mL", "UI/mL" |
| E | `ref_min` | número | limite inferior do laboratório |
| F | `ref_max` | número | limite superior |
| G | `flag` | **fórmula** | NÃO preencher |
| H | `medico_solicitante` | texto | "Dra. Natália" típico |
| I | `obs` | texto livre | |

**Range pra append:** `exames!A:I` (deixe `G` vazia)

**Trigger:** Jonas manda PDF/foto/texto de resultado de exame. Você decompõe cada marcador numa linha. Pode usar `googledrive` pra abrir o PDF.

**Após gravar todos os marcadores de uma coleta:** faça uma síntese — quais flags acenderam (alto/baixo) e o que cada um sugere clinicamente. Sem diagnosticar — só descrever. Se houver flag relevante, sinalize "mostra pra Dra. Natália".

---

## ABA `eventos_clinicos` — schema

**Granularidade:** timeline livre — uma linha por evento relevante.

**6 colunas:**

| # | Coluna | Tipo | Notas |
|---:|---|---|---|
| A | `data` | YYYY-MM-DD | |
| B | `profissional` | texto | "Dra. Natália" / "Isabela" / "Naia" / "Jonas" |
| C | `tipo` | enum | `consulta`, `ajuste_dose`, `plano_novo`, `intercorrencia`, `decisao`, `meta_atingida` |
| D | `tema` | texto | título curto (ex: "Aumento Monjaro 5→7,5 mg") |
| E | `decisao_acao` | texto | resumo do que foi decidido / ação |
| F | `obs` | texto livre | |

**Range pra append:** `eventos_clinicos!A:F`

**Triggers principais:**
- Jonas relata fala da Dra. Natália → linha com `profissional="Dra. Natália"`, `tipo` apropriado
- Plano alimentar novo da Isabela chega → linha `tipo=plano_novo` + você atualiza `plano-vigente.md` (ver `system-prompt.md`)
- Meta atingida (135, 120, 110, 98–106) → linha `tipo=meta_atingida` + atualiza `perfil-clinico.md`
- Intercorrência (hipoglicemia recorrente, efeito Monjaro persistente) que escalou → linha `tipo=intercorrencia`

---

## Convenções de escrita (todas as abas)

1. **Sempre em America/Recife** — converta horários relativos ("agora", "hoje cedo") pra HH:MM local.
2. **Datas sem hora** = `YYYY-MM-DD`.
3. **Decimais com vírgula** na exibição pro Jonas (142,7 kg) mas **com ponto** ao escrever no Sheets (142.7) — Sheets espera ponto.
4. **Booleanos** sempre minúsculos: `sim` / `não` (com til) — fórmulas dependem disso.
5. **Texto livre vazio** = string vazia, não `null` nem `N/A`.
6. **Append, nunca update** — exceto no caso de Jonas pedir explicitamente correção de uma linha já gravada (aí busca por `data` e atualiza).

## Padrão de chamada Composio

Usar tools `googlesheets` via Composio Tool Router. Sequência típica:

```
1. COMPOSIO_SEARCH_TOOLS query="append row to google sheet"
2. → router devolve slug exato (ex: GOOGLESHEETS_BATCH_UPDATE_VALUES ou ..._APPEND_VALUES)
3. COMPOSIO_MULTI_EXECUTE_TOOL com:
   - spreadsheet_id: "1SaFXt8hpuzlJ-S-DuWdiXOpzvF6xq1RjlAfIFKNs2tw"
   - range: "<aba>!A:<última coluna>"
   - values: [[col_A, col_B, ..., col_N]]
   - value_input_option: "USER_ENTERED" (pra fórmulas resolverem) ou "RAW" (texto puro)
4. Verificar resposta — se erro, reportar pro Jonas
```

Não memorize slugs — cada chamada começa por `SEARCH_TOOLS`.

## Quando esta skill NÃO se aplica

- Pergunta sobre alimento/macros (sem contexto de tracker) → use `naia-knowledge`
- Análise de adesão pontual ("hoje comi X, Y, Z, está ok?") sem pedido de registro → responde sem gravar; só grava se Jonas confirmar "registra"
- Tudo que sair das 5 abas de escrita
