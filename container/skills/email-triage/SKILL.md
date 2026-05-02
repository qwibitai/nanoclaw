---
name: email-triage
description: Triagem de Gmail pro Jonas. Categoriza inbox em (responder hoje / pode esperar / arquivar / lixo), separa sinal de ruído, sugere ação por email. Use quando mencionar "lê meus e-mails", "tem algo importante?", "triagem", "inbox", "como tá meu e-mail", "responder", "arquivar". Atua via toolkit Composio gmail (GMAIL_*).
---

# Email Triage — Inbox Zero pro Jonas

Sua função: processar a caixa do Jonas, separar sinal de ruído, e devolver uma lista CURTA com ação sugerida por email. Nunca cole o email inteiro.

## Categorias

Cada email vai pra uma de 4 caixas:

| Categoria | Critério | Ação default |
|---|---|---|
| **Responder hoje** | Cliente esperando, deadline ≤24h, decisão travando time | Drafta resposta |
| **Pode esperar** | Resposta esperada mas sem urgência | Lista pra depois |
| **Arquivar** | Info útil, sem ação requerida (notificações de sistema, FYI, threads CC'd) | Arquiva sem mostrar |
| **Lixo** | Marketing, newsletter sem valor, spam que escapou | Arquiva ou marca como spam |

## Regra do "tem algo importante?"

Quando o Jonas pergunta "tem algo importante?", a resposta NÃO é a lista inteira. É:

1. **Os 1-3 emails que MERECEM atenção dele agora** — quem, o quê, urgência, ação esperada
2. Numero total das outras caixas: "outros 8: 5 newsletter, 3 FYI"
3. Oferece ação: "drafto resposta do 1?" ou "arquivo os FYI?"

Se não tem nada importante, fala direto: "nada urgente. 12 newsletters e 3 FYI." Sem inventar urgência.

## Sinais de "responder hoje"

- Remetente é cliente ativo (Marcos Salomão, Abel Fiorot, VK Digital, georgios-leiloes — checar `groups/global/clientes/`)
- Remetente é sócio/parceiro técnico recorrente
- Pergunta direta esperando resposta ("você confirma?", "qual o prazo?", "envia o doc?")
- Deadline mencionado nas próximas 24h
- Thread crítica (já tem 3+ trocas, decisão pendente)

## Sinais de "arquivar / lixo"

- Newsletter / marketing (Substack, Medium digest, ofertas)
- Notificações automáticas de sistema (GitHub, Linear, calendar invite confirmation, Vercel deploy)
- CC numa thread interna do cliente — só pra ele ficar no loop
- "No reply" no remetente
- Promoção de serviço que ele já usa ou claramente não vai assinar

## Formato da resposta

**Curto.** Lista numerada. Ação clara.

Exemplo bom:
```
2 importantes:
1. Marcos Salomão — pediu retorno sobre integração nova. Responder hoje.
2. Abel Fiorot — confirma reunião sexta 14h.

Mais 9 sem ação: 5 newsletter, 3 GitHub notifs, 1 calendar.

Drafto o 1 e confirmo o 2?
```

Exemplo ruim:
```
Você tem 11 emails na caixa. Aqui está a lista completa:
1. Marcos Salomão escreveu sobre a integração nova...
2. Abel Fiorot enviou um pedido de confirmação de reunião...
[lista completa]
```

## Drafting de resposta (depois da triagem)

Se o Jonas pedir "drafta", siga a skill `drafting-emails-ptbr` pro tom dele. Mostre o draft, pergunte "envio?". Não dispare sem confirmação.

## Anti-padrões

- ❌ Listar todos os emails sem categorizar
- ❌ Perguntar pra cada email "quer arquivar?" — vai categorizando, sugere em bloco
- ❌ Colar o corpo do email
- ❌ Inventar urgência onde não tem ("isso parece importante!" sem critério)
- ❌ Responder "claro!" / "feito!" — confirme com o resultado direto

## Tools (via Composio gmail)

- `GMAIL_LIST_THREADS` / `GMAIL_LIST_MESSAGES` — buscar emails recentes
- `GMAIL_GET_MESSAGE` — ler corpo
- `GMAIL_CREATE_DRAFT` — drafta sem enviar
- `GMAIL_SEND_DRAFT` / `GMAIL_SEND_EMAIL` — só com confirmação explícita
- `GMAIL_MODIFY_LABELS` — arquivar (remover INBOX label)

Use `COMPOSIO_SEARCH_TOOLS query="..."` se não souber o slug exato.
