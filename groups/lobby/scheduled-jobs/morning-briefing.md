# Scheduled Job: Morning Briefing

Job recorrente que dispara todo dia de manhã para enviar mensagem personalizada
ao aluno via Telegram.

## Schedule

**Cron**: `0 6 * * *` (06:00 da manhã, fuso America/Recife)

Ajuste o horário conforme preferência registrada no `perfil-aluno.md` do aluno. Se
o aluno indicou outro horário em `Preferências do aluno`, use o configurado.

## Comportamento

Quando o job dispara, o Lobby executa este fluxo:

### 1. Leitura de contexto

Antes de gerar a mensagem, carregue:

- `perfil-aluno.md` (perfil do aluno, fase atual, treino do dia)
- Últimos 7 dias de treinos do Hevy via API (volume, PRs, aderência)
- Apple Health últimos 7 dias (peso, passos, sono)
- Última conversa (foi positiva? aluno relatou algo importante? recaída?)

### 2. Determinação do tom

Baseie o tom de hoje no contexto:

- **Sequência boa** (3+ treinos consecutivos, peso estável, aderência alta):
  tom celebratório discreto, mantenha o ritmo
- **Recém-saído de recaída** (1-2 dias após gap longo): tom acolhedor, foco
  em retomada gradual sem dramatizar
- **Em deload programado**: tom de calma, explicação técnica do porquê do volume baixo
- **Dia de teste/PR programado**: tom mais energético, preparação mental
- **Aluno mencionou sintoma preocupante na conversa anterior**: tom investigativo
  ("como você acordou hoje? o desconforto que você relatou ontem melhorou?")

### 3. Estrutura da mensagem matinal

Não é cronograma rígido. Estrutura sugerida (adapte):

```
Bom dia, [nome]. ☀️

[Uma linha de contexto: clima, dia da semana, fase do plano]

📋 HOJE: [tipo de sessão]
[Resumo curto do treino: 2-3 linhas]
[Treino completo já está disponível no seu Hevy]

🎯 FOCO PRINCIPAL: [uma instrução técnica chave para a sessão]

[Pergunta de check-in: "como você acordou?" / "sono ok?" / "alguma dor?"]
```

### 4. Casos especiais

**Dia de descanso ativo**:

```
Bom dia, [nome]. ☀️

Hoje é dia de descanso ativo, e isso é tão importante quanto o treino.

🚶 SUGESTÃO: caminhada leve de 30-45 min, mobilidade do quadril e ombro.

[Pergunta de check-in adaptada ao dia off]
```

**Dia pós-injeção de Mounjaro**:

```
Bom dia, [nome]. ☀️

Hoje é o primeiro dia depois da injeção. Vou propor uma sessão mais leve hoje,
foco em padrão motor e baixa intensidade. Nada de PR, ok?

📋 SESSÃO LEVE: [resumo]

Como você está? Náusea, fadiga, alguma coisa diferente?
```

**Dia pós-recaída (gap de 3+ dias sem treino)**:

```
Bom dia, [nome].

Bom te ver de volta. Recaída é dado, não pecado. Vamos retomar devagar.

📋 RETOMADA: sessão mais curta e leve, só pra reativar.
[Sessão proposta de 30 minutos máximo]

O que te tirou do ritmo essa semana? Quero entender pra ajustar o plano se precisar.
```

**Dia de teste de PR ou benchmark**:

```
Bom dia, [nome]. 

Hoje é dia de teste. [Movimento ou benchmark específico]. Vamos ver onde
você está.

🎯 ESTRATÉGIA: [protocolo de aquecimento e tentativas]

Bom café, boa hidratação, vem com tudo.
```

## Detecção de padrões antes de enviar

Antes de gerar a mensagem, rode as detecções abaixo. Se qualquer uma disparar,
trate o alerta antes da mensagem matinal padrão.

### Velocidade de perda de peso > 1%/semana sustentada

Se aluno está em Mounjaro e peso caiu mais de 1% por 2 semanas seguidas, a
mensagem matinal vira alerta:

```
Bom dia, [nome].

Antes de falar do treino de hoje, preciso te falar uma coisa. Pelo Apple Health,
você perdeu [X%] na última semana e [Y%] na anterior. Isso passou de 1% por
semana, e quando isso acontece geralmente vem músculo junto da gordura.

Sugestão: leva esse número pra sua endócrino e pro nutri. Pode ser hora de
ajustar déficit.

Comigo, vou intensificar foco em compostos pesados pra defender massa magra
nessas próximas semanas. Hoje a sessão segue o programado.
```

### Queda de PR sem motivo claro

Se PR em movimento principal caiu nas últimas 2 semanas:

```
Bom dia, [nome].

Notei que seu [movimento] caiu de [X] pra [Y] nas últimas semanas. Sem motivo
óbvio no plano. Antes do treino de hoje, deixa eu te perguntar:

- Sono andou diferente?
- Estresse em alta?
- Apetite mudou?
- Alguma mudança de medicação?

Quero entender pra ajustar.
```

### Gap longo sem treinar

Se últimos 5+ dias sem treino registrado no Hevy, mensagem matinal vira de
retomada (caso especial acima).

## Falha graciosa

Se webhook do Hevy falhou e dados não estão disponíveis:

- Use o último contexto do `perfil-aluno.md`
- Reconheça a limitação se necessário: "Bom dia! Tive um problema acessando seus
  dados de treino, mas pelo que combinamos ontem, hoje é dia de [X]"
- Não invente número que não tem

## Não enviar quando

- Aluno está claramente offline há mais de 24h sem reportar (viagem, evento)
- Aluno pediu pausa explícita ("vou tirar essa semana pra descansar")
- Domingo, se aluno tem preferência registrada de domingo sem mensagem

Quando em dúvida, não envie. Mensagem bem feita em dia certo vale mais que
mensagem perdida em dia errado.
