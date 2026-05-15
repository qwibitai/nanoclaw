# Lobby Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up "Lobby", an isolated Telegram personal-trainer agent, by adapting `lobby/lobby-package/` to the NanoClaw v2 native agent pattern.

**Architecture:** A dedicated `agent_groups` row (`id=lobby`) with its own container, workspace (`groups/lobby/`), session, and secondary Telegram bot. Persona installed as native `system-prompt.md` + operational `CLAUDE.md` + living `perfil-aluno.md`; six reference files and an exercise DB load on demand. Hevy + Fireflies MCPs and a read-only Naia cross-mount go in `container_config`. Two scheduled jobs are registered as recurring `task` rows in the session inbox.

**Tech Stack:** TypeScript one-shot scripts via `npx tsx`, better-sqlite3 (`data/v2.db` + per-session `inbound.db`), Markdown workspace files, NanoClaw v2 channel/router/cron subsystems.

**Spec:** `docs/superpowers/specs/2026-05-14-lobby-agent-design.md`

---

## File Structure

**Workspace — `groups/lobby/` (git-tracked):**
- `system-prompt.md` — Lobby persona (from package `SKILL.md` body, frontmatter stripped, profile-file references repointed). Always loaded.
- `CLAUDE.md` — operational manual: imports + reference-routing table + living-memory protocol + tools + Naia boundary. Always loaded.
- `perfil-aluno.md` — living student profile, pre-filled from Naia's `perfil-clinico.md` + `groups/global/CLAUDE.md`. Always loaded.
- `references/*.md` (6 files) — dense knowledge, copied verbatim. On-demand only.
- `assets/exercise-database.md` — exercise bank, copied verbatim. On-demand only.
- `scheduled-jobs/morning-briefing.md`, `scheduled-jobs/daily-focus-check.md` — copied verbatim. Read by cron jobs at run time.
- `scheduled-jobs/_override-block.md` — new; non-interactive prefix prepended to each cron prompt.
- `scratch/` — empty working dir (matches `groups/finance/scratch`).

**Scripts — `scripts/lobby/`:**
- `_register-agent-group.ts` — one-shot, creates the `agent_groups` row with full `container_config`. Contains API keys → **never committed**, deleted in cleanup.
- `_wire-bot.ts` — one-shot, writes the bot token + creates `messaging_groups`/`messaging_group_agents` rows. Contains the token → **never committed**, deleted in cleanup.
- `cron-jobs.json` — 2-job cron config. Git-tracked (no secrets).
- `register-cron-jobs.ts` — persistent cron registrar (mirror of `scripts/finance/register-cron-jobs.ts`). Git-tracked.

**Not modified:** no `src/` changes, so no `npm run build` is needed anywhere in this plan.

---

### Task 1: Workspace skeleton — copy package files

**Files:**
- Create: `groups/lobby/system-prompt.md` (from `lobby/lobby-package/.claude/skills/lobby/SKILL.md`)
- Create: `groups/lobby/references/` (6 files, copied)
- Create: `groups/lobby/assets/exercise-database.md` (copied)
- Create: `groups/lobby/scheduled-jobs/morning-briefing.md`, `groups/lobby/scheduled-jobs/daily-focus-check.md` (copied)
- Create: `groups/lobby/scratch/` (empty)

- [ ] **Step 1: Create directories and copy reference/asset/job files verbatim**

```bash
cd /root/nanoclaw
mkdir -p groups/lobby/references groups/lobby/assets groups/lobby/scheduled-jobs groups/lobby/scratch
cp lobby/lobby-package/.claude/skills/lobby/references/*.md groups/lobby/references/
cp lobby/lobby-package/.claude/skills/lobby/assets/exercise-database.md groups/lobby/assets/
cp lobby/lobby-package/scheduled-jobs/morning-briefing.md groups/lobby/scheduled-jobs/
cp lobby/lobby-package/scheduled-jobs/daily-focus-check.md groups/lobby/scheduled-jobs/
touch groups/lobby/scratch/.gitkeep
```

- [ ] **Step 2: Create `system-prompt.md` from the SKILL.md body**

The package `SKILL.md` has YAML frontmatter on lines 1–16 (`---` … `---`); the persona body starts at line 18 (`# Lobby`). Strip the frontmatter and repoint every `CLAUDE.md` reference (the package used `CLAUDE.md` as the student-profile filename; we use `perfil-aluno.md`).

```bash
cd /root/nanoclaw
tail -n +18 lobby/lobby-package/.claude/skills/lobby/SKILL.md \
  | sed 's/`CLAUDE\.md`/`perfil-aluno.md`/g; s/ CLAUDE\.md / perfil-aluno.md /g' \
  > groups/lobby/system-prompt.md
```

- [ ] **Step 3: Verify the copies**

```bash
cd /root/nanoclaw
ls groups/lobby/references/ | wc -l          # expect: 6
head -1 groups/lobby/system-prompt.md        # expect: "# Lobby"
grep -c 'CLAUDE\.md' groups/lobby/system-prompt.md   # expect: 0
grep -rl 'perfil-aluno.md' groups/lobby/system-prompt.md  # expect: the file path (refs were repointed)
ls groups/lobby/scheduled-jobs/              # expect: daily-focus-check.md morning-briefing.md
```

Expected: 6 reference files, `system-prompt.md` starts with `# Lobby`, zero remaining `CLAUDE.md` strings.

- [ ] **Step 4: Commit the skeleton**

```bash
cd /root/nanoclaw
git add groups/lobby/
git commit -m "feat(lobby): add Lobby agent workspace skeleton (persona + references)"
```

---

### Task 2: Pre-filled student profile `perfil-aluno.md`

**Files:**
- Create: `groups/lobby/perfil-aluno.md`

- [ ] **Step 1: Write `groups/lobby/perfil-aluno.md`**

Content (pre-filled from `groups/naia/perfil-clinico.md` and `groups/global/CLAUDE.md`):

```markdown
# Perfil do Aluno — Jonas

Este arquivo é a fonte de verdade sobre quem é o aluno. Leia antes de qualquer ação substantiva. Atualize sempre que houver mudança relevante (peso, lesão, equipamento, disponibilidade, medicação, marco).

> **Última atualização:** 2026-05-14 (criação; pré-preenchido a partir do perfil clínico mantido pela Naia e do contexto global. Lacunas a preencher no primeiro contato: equipamentos, disponibilidade semanal, detalhe das dores articulares, preferências de exercício.)

---

## Identificação

- **Nome:** Jonas Silva
- **Idade:** 35 anos
- **Sexo biológico:** masculino
- **Altura:** 1,85 m
- **Localização:** Campina Grande, PB, Brasil
- **Fuso horário:** America/Recife (UTC-3)
- **Canal de comunicação preferido:** Telegram
- **Contexto de vida:** founder/dev, trabalho 100% home office. Esposa + 3 filhos (15, 11, 6 anos). Homem de fé — família e Deus vêm primeiro.

## Status do onboarding

- [x] Identificação básica
- [x] Histórico médico documentado (via perfil clínico da Naia)
- [x] Comorbidades mapeadas
- [x] Medicação em uso documentada
- [x] Liberação clínica para treino confirmada
- [ ] Antropometria de treino confirmada com o aluno
- [ ] Equipamentos disponíveis mapeados em detalhe
- [ ] Disponibilidade semanal confirmada
- [ ] Lesões e dores ativas detalhadas (especialmente articular)
- [ ] Histórico de exercício aprofundado
- [ ] Preferências de exercício
- [ ] Primeira semana de adaptação prescrita

**Status atual:** perfil clínico pré-preenchido, liberação confirmada. Onboarding curto pendente: o Lobby confirma os dados pré-preenchidos e cobre as lacunas marcadas acima antes de prescrever o primeiro mesociclo.

## Liberação clínica

- **Status:** LIBERADO para treino.
- **Confirmado por:** o próprio Jonas, em 2026-05-14, declarando liberação da equipe clínica (Dra. Natália — nutróloga).
- **Observação:** o `perfil-clinico.md` da Naia (montado em `agents/naia/`, read-only) ainda pode trazer a nota antiga "introduzir atividade após 135 kg". **Este arquivo é a fonte de verdade** para o status de treino — confie nele, não na nota da Naia.

## Dados antropométricos

> Fonte: perfil clínico mantido pela Naia (balança Leach com bioimpedância). Confirmar com o aluno e atualizar mensalmente.

- Peso inicial (24/04/2026): 148,2 kg
- Peso atual (12/05/2026): 136,8 kg
- IMC atual: 40,0 (obesidade grau III)
- % gordura corporal: 34,6% (12/05)
- % gordura visceral: 20° (12/05) — alvo <10°
- Massa muscular: 52,1 kg (12/05) — monitorar; defender durante a perda de peso

Histórico antropométrico (atualizar mensalmente):

| Data | Peso | % Gordura | Massa muscular | Notas |
|------|------|-----------|----------------|-------|
| 24/04/2026 | 148,2 kg | — | — | início do Monjaro |
| 12/05/2026 | 136,8 kg | 34,6% | 52,1 kg | -11,4 kg em 18 dias |

## Comorbidades e condições clínicas

- [X] Hipertensão arterial sistêmica (HAS) — confirmada
- [X] Pré-diabetes / resistência à insulina — manifesta hipoglicemia reativa (tremedeira, suor frio, mal-estar) quando passa muitas horas sem comer (gatilho típico: almoço após 14h30)
- [X] Esteatose hepática — confirmada em exames de imagem
- [X] Função renal alterada (alteração leve; exames em refazimento)
- [X] Quadro psiquiátrico — uso de medicação para ansiedade (sem contraindicação com Monjaro)
- Obesidade grau III (IMC 40). Bariátrica era opção pelo IMC; Monjaro escolhido como tentativa anterior à cirurgia.

**Hábitos relevantes:** tabagismo ativo (já tentou parar com bupropiona, sem sucesso). Etilismo zero. Sono estrutural ruim: 4-5 h/noite (deita 00h-01h, acorda 05h-06h).

## Medicação em uso

**Monjaro / Tirzepatida** ⚠️

- Dose atual: 5 mg
- Frequência: semanal (subcutâneo, abdômen, rotacionando o lado)
- Data de início: 25/04/2026
- Médica responsável: Dra. Natália (nutróloga, clínica Liti)
- Observação: dose pode subir após 2-3 semanas se o efeito for pequeno (decisão da Dra.)

⚠️ Aplicar o protocolo clínico de `references/mounjaro-protocol.md`. Monitorar:
- Velocidade de perda de peso (alerta se > 1% por semana sustentada — sinal de perda muscular)
- Manutenção de PRs nos lifts principais (queda = sinal de perda muscular)
- Ingesta proteica diária (alvo negociado com a nutricionista)
- Sintomas pós-injeção (náusea, fadiga, alteração GI) — Vonal liberado 8/8h se enjoo
- Hidratação (o aluno historicamente bebe pouca água)

Outras medicações: medicação para ansiedade (psiquiátrica). Suplementos aprovados pela equipe clínica: Nutriotonic, House Whey, Vit. D3+K2.

## Lesões e limitações ativas

> A detalhar no primeiro contato. Sinal conhecido: o aluno relatou dor articular como motivo de abandono nas duas tentativas anteriores de voltar a treinar. Investigar região, tipo, gatilho.

| Região | Tipo | Status | Exclusões de exercício |
|--------|------|--------|------------------------|
| _ (investigar dor articular relatada) | _ | _ | _ |

## Histórico de exercício

- Ex-atleta de jiu-jítsu. Parou há ~11 anos.
- Duas tentativas de retomar atividade física desde então — ambas interrompidas por dor articular e cansaço.
- Atividade física atual: zero (sedentário).
- Nível atual estimado: iniciante (apesar do passado atlético — considerar 11 anos de destreino).
- Estágio TTM estimado: preparação/ação (buscou ativamente o Lobby e tem liberação) — confirmar no primeiro contato.

## Equipamentos disponíveis

> A mapear no primeiro contato — base de toda prescrição. O Lobby cobre três contextos: musculação tradicional, CrossFit/funcional, e elástico extensor (tubing).

- Academia tradicional: _
- Box CrossFit: _
- Home gym / espaço próprio: _
- Elástico extensor (tubing): _

## Disponibilidade semanal

> A confirmar no primeiro contato. Contexto conhecido (agenda do Jonas): trabalha home office; rotina seg-sex 06h-12h, 15h-17h, 18h+; quarta 19h e domingo 18h tem igreja; fins de semana eventuais.

| Dia | Janela disponível | Duração máxima |
|-----|-------------------|----------------|

## Time médico e profissional

| Profissional | Especialidade | Papel | Canal |
|--------------|---------------|-------|-------|
| Dra. Natália | Médica nutróloga (clínica Liti) | Tratamento medicamentoso (Monjaro), exames, decisões clínicas, liberação para treino | WhatsApp direto |
| Isabela | Nutricionista (clínica Liti) | Plano alimentar oficial, ajustes nutricionais | WhatsApp direto |
| Naia | Agente de nutrição (suporte 24/7) | Execução do plano alimentar, suporte nutricional | Telegram (agente irmão — workspace montado em `agents/naia/`, read-only) |

Recomendações ativas do time médico: ver `agents/naia/perfil-clinico.md` (read-only). Consultas gravadas no Fireflies — consultar via MCP quando houver razão clara de prescrição.

## Objetivos

### Macro (definido pela equipe clínica — metas escalonadas)
1. Meta 1 — 135 kg (~1,8 kg do peso atual)
2. Meta 2 — 120 kg
3. Meta 3 — 110 kg
4. Meta final tentativa — 98-106 kg
5. Meta paralela contínua — gordura visceral abaixo de 10°

### Mesociclo atual
_ (a definir após onboarding curto)

### Foco da semana
_

## Preferências do aluno

> A descobrir nas interações.

### Exercícios que ama / detesta
- _

### Estilo de comunicação
- Português brasileiro. Extremamente metódico: se receber regra clara, segue à risca; se receber zona cinzenta, oscila — então **dê regra clara**.
- Pensa em sistemas (é dev) — gosta de entender o "porquê" fisiológico.
- Direto e ocupado — respostas curtas no fluxo normal.

## Vitórias e marcos

| Data | Tipo | Descrição |
|------|------|-----------|
| 12/05/2026 | comportamental | -11,4 kg desde o início do tratamento; 1,8 kg da Meta 1 |

## Notas do Lobby

> Espaço livre para observações que não cabem nas seções estruturadas. Fatos, não narrativa.

(vazio — primeira sessão)

---

## Última atualização

Data: 2026-05-14
Atualizado por: Claude (standup do agente)
Mudanças: criação do arquivo, pré-preenchido a partir do perfil clínico da Naia e do contexto global; liberação clínica registrada; lacunas de onboarding marcadas.
```

- [ ] **Step 2: Verify the file exists and is non-empty**

```bash
cd /root/nanoclaw
wc -l groups/lobby/perfil-aluno.md   # expect: > 100 lines
grep -c '136,8 kg' groups/lobby/perfil-aluno.md   # expect: >= 2 (profile is pre-filled)
```

---

### Task 3: Operational manual `CLAUDE.md`

**Files:**
- Create: `groups/lobby/CLAUDE.md`

- [ ] **Step 1: Write `groups/lobby/CLAUDE.md`**

```markdown
@./system-prompt.md
@./perfil-aluno.md

# Lobby — operação

Personal trainer digital pessoal do Jonas. Persona completa (voz, 11 modos, guardrails, formatos de output, protocolo de primeiro contato) em `system-prompt.md`. Perfil do aluno em `perfil-aluno.md`. Este arquivo é o **manual operacional**: roteamento de referências, memória viva, ferramentas, fronteiras.

## Identidade e canal

- **Nome:** Lobby
- **Canal:** Telegram (bot dedicado, channel type `telegram-lobby`)
- **Aluno:** Jonas (único — agente isolado, sessão própria)
- **Idioma:** português brasileiro

## Roteamento de referências (carregamento sob demanda)

Os arquivos abaixo NÃO são carregados sempre — só quando o gatilho dispara. Mantenha o contexto enxuto: leia o arquivo certo na hora certa, não tudo de uma vez.

| Arquivo | Carregue quando |
|---|---|
| `references/anamnese-par-q-plus.md` | primeiro contato com o aluno, ou revisão completa de perfil |
| `references/tubing-mastery.md` | aluno usa/tem elástico extensor, ou vai montar treino com tubing |
| `references/mounjaro-protocol.md` | vai monitorar perda de peso, ou o aluno relata sintoma típico (náusea pós-injeção, queda de força, fadiga) — o aluno usa Monjaro |
| `references/obesity-programming.md` | montar mesociclo novo, ou decidir transição entre fases |
| `references/crossfit-wod-templates.md` | gerar WOD ou explicar formato CrossFit |
| `references/cueing-library.md` | precisar de cue específico que não está fresco, ou o aluno não respondeu ao cue inicial |
| `assets/exercise-database.md` | programar treino — banco de exercícios por padrão motor |

## Memória viva — atualize sozinho, sem pedir

Três destinos. Saiba onde cada coisa vai. Regra geral: **fatos, não narrativa.**

### Nível 1 — Hevy (treinos e rotinas)
Treinos completados, PRs, rotinas (templates), folders por mesociclo — tudo vive no Hevy via MCP. Não duplique isso em arquivo.

### Nível 2 — Campos estruturados do `perfil-aluno.md`
Atualize **direto, sem perguntar**, quando mudar:
- Equipamento disponível → seção "Equipamentos disponíveis"
- Disponibilidade semanal → seção "Disponibilidade semanal"
- Nova lesão ou dor → tabela "Lesões e limitações ativas"
- Dose/mudança de medicação → seção "Medicação em uso"
- Antropometria nova (peso, % gordura) → tabela "Histórico antropométrico"
- Marco/PR/vitória → tabela "Vitórias e marcos"
- Mudança de objetivo/mesociclo/foco → seção "Objetivos"
Sempre atualize o bloco "Última atualização" no fim do arquivo.

### Nível 3 — Seção "Notas do Lobby" do `perfil-aluno.md`
Observações comportamentais que não cabem em campo estruturado: gatilhos de desmotivação, o que funcionou/não funcionou na comunicação, contexto que afeta o treino. Fato + data. Enxuto.

## Ferramentas (MCP)

| MCP | Uso | Permissão |
|---|---|---|
| `hevy` | ler workouts/PRs/volume; criar e organizar rotinas em folders por mesociclo | leitura livre; criar/editar rotina confirma com o aluno antes |
| `fireflies` | transcrições de consultas médicas — buscar quando houver razão clara de prescrição (planejamento, dúvida específica, follow-up). LGPD: não vasculhar por curiosidade | leitura, com a política de acesso acima |
| `agent-browser` (skill do container) | pesquisar tutoriais em vídeo (Modo 9) — hierarquia de fontes no `system-prompt.md` | automática |

Hevy API está em rollout inicial — se uma chamada falhar, registre o erro e tente versão simplificada (não invente dado).

## Acesso cruzado — Naia (read-only)

Você tem **read-only** em `agents/naia/`. Use para se manter alinhado com o lado nutricional/clínico:
- `agents/naia/perfil-clinico.md` — histórico clínico, comorbidades, Monjaro, metas, time médico
- `agents/naia/plano-vigente.md` — plano alimentar oficial vigente

Fronteira dura: você **lê** o contexto clínico/nutricional, mas **não escreve** lá e **não decide nutrição** — isso é da Naia e da nutricionista. Quando o aluno fizer dúvida nutricional, dê o princípio geral e redirecione. Sobre status de treino: confie no `perfil-aluno.md` (sua fonte de verdade), não na nota de liberação da Naia (pode estar desatualizada).

## Formato Telegram

- `*negrito*` (asterisco simples, nunca `**duplo**`), `_itálico_`, `•` para bullets, ``` para código
- Sem `##` headings, sem `[links](url)`
- Mensagens curtas no fluxo normal; quebra blocos longos em até 3.500 caracteres (limite Telegram 4.096)
- Emojis com moderação — os formatos canônicos do `system-prompt.md` já definem onde usar

## Limites duros (resumo — completo em `system-prompt.md`, seção "Guardrails")

1. Não substitui profissional CREF presencial
2. Não prescreve dieta (é da Naia/nutricionista)
3. Não diagnostica lesão
4. Não recomenda suplemento específico
5. Não interpreta diagnóstico médico
6. Red flags clínicos = override absoluto: interrompe treino, recomenda contato médico
7. Não inventa referência, número ou protocolo — alucinação em saúde é falha grave
```

- [ ] **Step 2: Verify imports resolve**

```bash
cd /root/nanoclaw
head -2 groups/lobby/CLAUDE.md   # expect: "@./system-prompt.md" then "@./perfil-aluno.md"
ls groups/lobby/system-prompt.md groups/lobby/perfil-aluno.md   # both must exist (imports point at them)
```

---

### Task 4: Cron override block + commit workspace content

**Files:**
- Create: `groups/lobby/scheduled-jobs/_override-block.md`

- [ ] **Step 1: Write `groups/lobby/scheduled-jobs/_override-block.md`**

```markdown
[TAREFA DE SISTEMA — NÃO-INTERATIVA]

Este é um cron job automatizado, não uma mensagem do Jonas. Regras de execução:

1. NÃO cumprimente como se ele tivesse falado com você. NÃO peça confirmação. NÃO faça pergunta de esclarecimento.
2. Siga as instruções do bloco abaixo literalmente. O bloco abaixo é a especificação do job — leia o contexto necessário (`perfil-aluno.md`, dados do Hevy, conversa recente) e decida.
3. Output deve ser exatamente UM destes formatos:
   - `<message to="jonas">{conteúdo da mensagem entregue ao aluno}</message>` — quando o job decide que vale enviar algo
   - `<internal>silent run: {motivo curto}</internal>` — quando o job decide NÃO enviar (ex.: check-in que não se justifica, aluno offline, domingo sem mensagem)
4. A decisão de enviar ou não é parte do job — os arquivos de instrução têm regras de "não enviar quando". Respeite-as. Em dúvida, não envie.
5. Se uma chamada de ferramenta falhar (ex.: Hevy fora do ar), siga a regra de falha graciosa do arquivo de instrução — use o último contexto conhecido, não invente dado.
6. Não tente "recuperar criativamente" — se não dá pra cumprir o job, emita `<internal>` com o motivo.

Execute as instruções abaixo na ordem.

---

```

- [ ] **Step 2: Commit the workspace content**

```bash
cd /root/nanoclaw
git add groups/lobby/
git commit -m "feat(lobby): add operational manual, pre-filled student profile, cron override block"
```

---

### Task 5: Create the agent group in the DB

**Files:**
- Create: `scripts/lobby/_register-agent-group.ts` (one-shot — **do not commit**)

- [ ] **Step 1: Write `scripts/lobby/_register-agent-group.ts`**

```typescript
// scripts/lobby/_register-agent-group.ts (one-shot — DO NOT COMMIT, contains API keys, delete after)
import path from 'path';
import { initDb } from '../../src/db/connection.js';
import { createAgentGroup, getAgentGroup } from '../../src/db/agent-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = initDb(dbPath);
runMigrations(db);

if (getAgentGroup('lobby')) {
  console.log('ℹ️ Agent group "lobby" already exists');
  process.exit(0);
}

// NOTE: agent_provider is intentionally null — the agent-runner crashes on a
// literal 'anthropic' and treats null as its default provider.
const containerConfig = {
  mcpServers: {
    hevy: {
      command: 'npx',
      args: ['-y', 'hevy-mcp@1.23.10'],
      env: { HEVY_API_KEY: '<redacted: HEVY_API_KEY stored in v2.db>' },
    },
    fireflies: {
      command: 'npx',
      args: ['-y', 'fireflies-mcp-server'],
      env: { FIREFLIES_API_KEY: '<redacted: FIREFLIES_API_KEY stored in v2.db>' },
    },
  },
  additionalMounts: [
    {
      hostPath: '/root/nanoclaw/groups/naia',
      containerPath: 'agents/naia',
      readonly: true,
    },
  ],
};

createAgentGroup({
  id: 'lobby',
  name: 'Lobby',
  folder: 'lobby',
  agent_provider: null,
  container_config: JSON.stringify(containerConfig),
  created_at: new Date().toISOString(),
});

console.log('✅ Agent group "lobby" created');
```

- [ ] **Step 2: Verify `hevy-mcp@1.23.10` exists on npm**

Run: `npm view hevy-mcp@1.23.10 version`
Expected: prints `1.23.10`. If that exact version is gone, run `npm view hevy-mcp version` and substitute the current latest into the script's `args` before running Step 3.

- [ ] **Step 3: Run the script**

Run: `cd /root/nanoclaw && npx tsx scripts/lobby/_register-agent-group.ts`
Expected: `✅ Agent group "lobby" created`

- [ ] **Step 4: Verify the DB row**

```bash
sqlite3 /root/nanoclaw/data/v2.db "SELECT id, name, folder, agent_provider FROM agent_groups WHERE id='lobby';"
sqlite3 /root/nanoclaw/data/v2.db "SELECT json_extract(container_config,'\$.mcpServers.hevy.command'), json_extract(container_config,'\$.additionalMounts[0].containerPath') FROM agent_groups WHERE id='lobby';"
```

Expected: row `lobby|Lobby|lobby|` (agent_provider empty/null); second query prints `npx|agents/naia`.

---

### Task 6: Operator creates the Telegram bot

**This is an operator step — Claude cannot talk to @BotFather.**

- [ ] **Step 1: Tell the operator to create the bot**

Give the operator these instructions verbatim:

```
1. Abra o Telegram, fale com @BotFather
2. /newbot
3. Nome (display): "Lobby" (ou o que preferir)
4. Username: tem que terminar em "bot", ex: JonasLobbyBot
5. Copie o token que ele te dá (formato 12345:ABC...)
6. Me manda o token aqui
```

- [ ] **Step 2: Wait for the operator to paste the token**

Hold the token for Task 7. Do not write it to any committed file.

---

### Task 7: Wire the bot + messaging rows, restart NanoClaw

**Files:**
- Create: `scripts/lobby/_wire-bot.ts` (one-shot — **do not commit**, contains the token)

- [ ] **Step 1: Write `scripts/lobby/_wire-bot.ts`**

Paste the operator's token into `TOKEN` before running.

```typescript
// scripts/lobby/_wire-bot.ts (one-shot — DO NOT COMMIT, contains the bot token, delete after)
import path from 'path';
import { initDb, getDb } from '../../src/db/connection.js';
import { getAgentGroup } from '../../src/db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupByPlatform,
  getMessagingGroupAgentByPair,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';

const TOKEN = '<PASTE BOTFATHER TOKEN HERE>';
const PLATFORM_ID = 'telegram:8557164566'; // Jonas's Telegram user id (verified in data/v2.db)

const dbPath = path.join(process.cwd(), 'data', 'v2.db');
const db = initDb(dbPath);
runMigrations(db);

const ag = getAgentGroup('lobby');
if (!ag) {
  console.error('❌ Agent group "lobby" not found. Run _register-agent-group.ts first.');
  process.exit(1);
}

// 1. Write the bot token into container_config
const cfg = ag.container_config ? JSON.parse(ag.container_config) : {};
cfg.telegramBotToken = TOKEN;
getDb().prepare('UPDATE agent_groups SET container_config=? WHERE id=?').run(JSON.stringify(cfg), 'lobby');
console.log('✅ Token wired into agent_groups.lobby.container_config');

const CHANNEL_TYPE = 'telegram-lobby';
const MG_ID = 'mg-lobby-dm';
const MGA_ID = 'mga-lobby';
const NOW = new Date().toISOString();

// 2. messaging_groups row (the DM channel) — idempotent
const existingMg = getMessagingGroupByPlatform(CHANNEL_TYPE, PLATFORM_ID);
let mgId: string;
if (existingMg) {
  mgId = existingMg.id;
  console.log(`ℹ️  messaging_group already exists: ${mgId}`);
} else {
  createMessagingGroup({
    id: MG_ID,
    channel_type: CHANNEL_TYPE,
    platform_id: PLATFORM_ID,
    name: 'Lobby DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });
  mgId = MG_ID;
  console.log(`✅ messaging_group created: ${mgId}`);
}

// 3. messaging_group_agents row (the wiring) — session_mode='shared' matches
//    Naia + Finance DM agents. createMessagingGroupAgent() also auto-creates
//    the matching agent_destinations row; without it, the agent's outbound
//    <message to="..."> blocks (and cron firings that use them) are silently
//    dropped with "Unknown destination" warnings — see commit e0dfdec.
const existingMga = getMessagingGroupAgentByPair(mgId, 'lobby');
if (!existingMga) {
  createMessagingGroupAgent({
    id: MGA_ID,
    messaging_group_id: mgId,
    agent_group_id: 'lobby',
    trigger_rules: null,
    response_scope: 'all',
    session_mode: 'shared',
    priority: 0,
    created_at: NOW,
  });
  console.log(`✅ messaging_group_agent + agent_destinations created: ${MGA_ID}`);
} else {
  console.log(`ℹ️  messaging_group_agent already exists: ${existingMga.id}`);
}
```

- [ ] **Step 2: Run the script**

Run: `cd /root/nanoclaw && npx tsx scripts/lobby/_wire-bot.ts`
Expected three lines: `✅ Token wired...`, `✅ messaging_group created: mg-lobby-dm`, `✅ messaging_group_agent + agent_destinations created: mga-lobby`.

- [ ] **Step 3: Verify the rows**

```bash
sqlite3 /root/nanoclaw/data/v2.db "SELECT channel_type, platform_id, name FROM messaging_groups WHERE id='mg-lobby-dm';"
sqlite3 /root/nanoclaw/data/v2.db "SELECT agent_group_id, response_scope, session_mode FROM messaging_group_agents WHERE id='mga-lobby';"
```

Expected: `telegram-lobby|telegram:8557164566|Lobby DM` and `lobby|all|shared`.

- [ ] **Step 4: Restart NanoClaw**

Run: `systemctl --user restart nanoclaw`
(If the service is system-scoped rather than user-scoped, use `systemctl restart nanoclaw` — check with `systemctl --user status nanoclaw` first.)

- [ ] **Step 5: Verify the secondary bot registered**

```bash
grep -E 'folder="lobby"|channel="telegram-lobby"' /root/nanoclaw/logs/nanoclaw.log | tail -5
```

Expected lines (in order):
- `Registering secondary Telegram bot agentGroup="lobby" folder="lobby" channelType="telegram-lobby"`
- `Telegram adapter initialized` (with a `botUserId` and the bot's username)
- `Channel adapter started channel="telegram-lobby"`

If these are absent: confirm the token is valid and re-check the restart actually happened.

---

### Task 8: Operator sends the first message

**This is an operator step — it creates the Lobby session, which Task 9 needs.**

- [ ] **Step 1: Tell the operator to DM the bot**

Ask the operator to open the new Lobby bot in Telegram and send `oi`.

- [ ] **Step 2: Verify the session was created and routed**

```bash
grep -E 'agentGroup="lobby"|agentGroupId="lobby"' /root/nanoclaw/logs/nanoclaw.log | tail -5
sqlite3 /root/nanoclaw/data/v2.db "SELECT id, agent_group_id FROM sessions WHERE agent_group_id='lobby';"
```

Expected: log entries showing the message routed to `agentGroup="lobby"`, and the `sessions` query returns one row. Note the session id — Task 9 needs it.

- [ ] **Step 3: Verify the reply uses the Lobby persona**

Confirm with the operator that the bot's reply is in the Lobby persona (PT-BR, personal-trainer voice, addresses Jonas by name) and references the pre-filled profile — it should NOT re-ask weight/goals from zero, and should NOT sound like generic Claude. If the reply is generic, stop and debug (likely `CLAUDE.md` import path or workspace mount).

---

### Task 9: Register the scheduled jobs

**Files:**
- Create: `scripts/lobby/cron-jobs.json`
- Create: `scripts/lobby/register-cron-jobs.ts`

- [ ] **Step 1: Write `scripts/lobby/cron-jobs.json`**

```json
{
  "jobs": [
    {
      "id": "task-lobby-morning-briefing",
      "kind": "task",
      "recurrence": "0 6 * * *",
      "promptFile": "morning-briefing.md",
      "firstRunOffsetMs": 60000
    },
    {
      "id": "task-lobby-daily-focus-check",
      "kind": "task",
      "recurrence": "0 11,15,19 * * *",
      "promptFile": "daily-focus-check.md",
      "firstRunOffsetMs": 60000
    }
  ]
}
```

- [ ] **Step 2: Write `scripts/lobby/register-cron-jobs.ts`**

This mirrors `scripts/finance/register-cron-jobs.ts` with Lobby paths: `promptsDir` is the workspace `scheduled-jobs/` folder, so it reads `_override-block.md` and the two job prompt files directly from `groups/lobby/scheduled-jobs/`.

```typescript
/**
 * Register the Lobby cron jobs as recurring 'task' messages in the agent's
 * session inbox. Mirror of scripts/finance/register-cron-jobs.ts.
 *
 * Usage:
 *   npx tsx scripts/lobby/register-cron-jobs.ts --session <session-id>
 *
 * Reads cron-jobs.json + the shared _override-block.md + each promptFile,
 * builds content = JSON.stringify({prompt: <override>+<prompt>}), inserts each
 * as a recurring row with kind='task' (idempotent via INSERT OR REPLACE).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { toSqliteUtc } from '../../src/db/sqlite-utc.js';

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
  const overridePath = path.join(opts.promptsDir, '_override-block.md');
  const overrideBlock = fs.readFileSync(overridePath, 'utf8');

  const db = new Database(opts.inboundDbPath);

  const maxSeq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  let seq = maxSeq < 2 ? 2 : maxSeq + 2 - (maxSeq % 2);

  const now = Date.now();

  for (const job of config.jobs) {
    const procedural = fs.readFileSync(path.join(opts.promptsDir, job.promptFile), 'utf8');
    const prompt = overrideBlock + '\n\n' + procedural;
    const content = JSON.stringify({ prompt });

    const processAfter = toSqliteUtc(new Date(now + job.firstRunOffsetMs));
    const timestamp = toSqliteUtc(new Date());

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
    console.error('Usage: npx tsx scripts/lobby/register-cron-jobs.ts --session <session-id>');
    process.exit(1);
  }
  const sessionId = args[sessionIdx + 1];

  const inboundDbPath = path.join(process.cwd(), 'data', 'v2-sessions', 'lobby', sessionId, 'inbound.db');
  if (!fs.existsSync(inboundDbPath)) {
    console.error(`Inbound DB not found: ${inboundDbPath}`);
    console.error('Make sure the session exists. Run: sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id=\'lobby\';"');
    process.exit(1);
  }

  const configPath = path.join(process.cwd(), 'scripts', 'lobby', 'cron-jobs.json');
  const promptsDir = path.join(process.cwd(), 'groups', 'lobby', 'scheduled-jobs');

  registerCronJobs({ inboundDbPath, configPath, promptsDir });

  console.log(`✅ 2 cron jobs registered in ${inboundDbPath}`);
  console.log('   Verify: sqlite3 ' + inboundDbPath + ' "SELECT id, kind, recurrence, datetime(process_after) FROM messages_in WHERE recurrence IS NOT NULL;"');
}
```

- [ ] **Step 3: Run the registrar with the session id from Task 8**

```bash
cd /root/nanoclaw
SESSION_ID=$(sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='lobby' ORDER BY created_at DESC LIMIT 1;")
npx tsx scripts/lobby/register-cron-jobs.ts --session "$SESSION_ID"
```

Expected: `✅ 2 cron jobs registered in ...`

- [ ] **Step 4: Verify the cron rows**

```bash
cd /root/nanoclaw
SESSION_ID=$(sqlite3 data/v2.db "SELECT id FROM sessions WHERE agent_group_id='lobby' ORDER BY created_at DESC LIMIT 1;")
sqlite3 "data/v2-sessions/lobby/$SESSION_ID/inbound.db" \
  "SELECT id, kind, recurrence FROM messages_in WHERE recurrence IS NOT NULL;"
```

Expected: 2 rows — `task-lobby-morning-briefing|task|0 6 * * *` and `task-lobby-daily-focus-check|task|0 11,15,19 * * *`.

- [ ] **Step 5: Commit the cron config + registrar**

```bash
cd /root/nanoclaw
git add scripts/lobby/cron-jobs.json scripts/lobby/register-cron-jobs.ts
git commit -m "feat(lobby): add scheduled-job config and cron registrar"
```

---

### Task 10: End-to-end verification

No new files. Operator drives the Telegram checks; Claude drives the shell checks.

- [ ] **Step 1: Hevy MCP reachable**

Operator sends to the bot: `Lobby, conecta no Hevy e me diz quantos treinos eu tenho registrados.`
Expected: the bot calls a Hevy tool and answers with a count (or a clean "0 treinos / nada registrado ainda"). It must NOT claim it has no Hevy access.

- [ ] **Step 2: Naia cross-mount is readable and read-only**

Operator sends: `Lobby, qual o peso atual que a Naia tem registrado no perfil clínico?`
Expected: the bot reads `agents/naia/perfil-clinico.md` and reports `136,8 kg` (12/05). It should defer any nutrition decision to Naia/the nutritionist.

- [ ] **Step 3: References are not auto-loaded**

```bash
grep -E 'agentGroup="lobby"' /root/nanoclaw/logs/nanoclaw.log | tail -3
```

Confirm normal turns work without errors. Then have the operator ask a WOD question (`Lobby, manda um WOD rápido de 15 minutos`) and confirm the reply uses the CrossFit WOD format — proving `references/crossfit-wod-templates.md` loads on demand.

- [ ] **Step 4: Confirm isolation**

```bash
sqlite3 /root/nanoclaw/data/v2.db "SELECT agent_group_id FROM messaging_group_agents WHERE messaging_group_id='mg-lobby-dm';"
```

Expected: exactly one row, `lobby`. The bot must never respond as Zory/Caio/Naia/Finance.

If any step fails: stop, root-cause, fix. Do not declare the install successful.

---

### Task 11: Cleanup + operator handoff

- [ ] **Step 1: Delete the one-shot scripts (they contain secrets and are not committed)**

```bash
cd /root/nanoclaw
rm -f scripts/lobby/_register-agent-group.ts scripts/lobby/_wire-bot.ts
ls scripts/lobby/   # expect only: cron-jobs.json  register-cron-jobs.ts
```

- [ ] **Step 2: Confirm no secrets were committed**

```bash
cd /root/nanoclaw
git log --oneline -5
git show --stat HEAD~2..HEAD | grep -E '_register-agent-group|_wire-bot' && echo "LEAK — investigate" || echo "clean — no one-shot scripts in history"
```

Expected: `clean — no one-shot scripts in history`.

- [ ] **Step 3: Tell the operator the two follow-ups**

Give the operator this note:

```
Lobby está no ar. Dois follow-ups recomendados:

1. Peça pra Naia atualizar a nota de liberação de exercício no perfil-clinico.md
   dela — hoje ainda diz "introduzir após 135 kg", e você já está liberado. O
   Lobby já trata o perfil-aluno.md dele como fonte de verdade, então não quebra
   nada, mas vale alinhar.
2. O webhook do Hevy (debrief automático pós-treino) ficou de fora deste standup
   — dá pra adicionar depois se você quiser.
```

- [ ] **Step 4: Final state check**

```bash
cd /root/nanoclaw
git status --short   # expect: clean (or only the untracked lobby/ source package)
```

The `lobby/` source package folder stays untracked as reference material — the operator can delete it whenever.

---

## Self-Review

**Spec coverage:**
- Component 1 (agent group) → Task 5 ✓
- Component 2 (Telegram bot) → Tasks 6, 7 ✓
- Component 3 (messaging wiring) → Task 7 ✓
- Component 4 (workspace, native format, 3 anti-"lost" disciplines) → Tasks 1–4 ✓ (routing table + memory protocol in Task 3 `CLAUDE.md`; persona/profile split across Tasks 2/3; lean always-on context = only 3 files imported)
- Component 5 (Hevy + Fireflies MCPs, no Composio) → Task 5 ✓
- Component 6 (Naia read-only cross-mount) → Task 5 (`additionalMounts`), Task 10 Step 2 (verified) ✓
- Component 7 (2 scheduled jobs) → Task 9 ✓
- First-contact behavior (pre-filled profile, short onboarding) → Task 2 ✓, verified Task 8 Step 3
- "Open items" from spec: `hevy-mcp` version → resolved (verified `1.23.10` on npm, Task 5 Step 2 re-checks); operator Telegram id → resolved (`telegram:8557164566`, verified in DB); cron script → resolved (`scripts/lobby/` copy, matching `scripts/finance/` precedent)
- Spec said `session_mode='agent-shared'`; implementation uses `session_mode='shared'` — corrected to match the actual value used by the sibling DM agents Naia and Finance in `data/v2.db`. Single-agent DM behavior is identical either way.

**Placeholder scan:** `<PASTE BOTFATHER TOKEN HERE>` in Task 7 is an intentional operator-fill slot (the token only exists at runtime), explicitly flagged. No other placeholders.

**Type consistency:** `createAgentGroup` is called with the full `AgentGroup` shape (`id, name, folder, agent_provider, container_config, created_at`) matching `src/types.ts`. `registerCronJobs`/`RegisterOptions`/`JobConfig` names are consistent between definition and CLI use in Task 9. The `cron-jobs.json` fields (`id, kind, recurrence, promptFile, firstRunOffsetMs`) match the `JobConfig` interface. IDs `mg-lobby-dm` / `mga-lobby` / `lobby` are used consistently across Tasks 7, 9, 10.
