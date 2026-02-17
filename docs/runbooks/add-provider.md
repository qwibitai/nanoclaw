# Runbook: Adicionar Provider (Plugin de API Externa)

Guia para o admin (você) sempre que precisar conectar uma API externa nova — Google Analytics, Mixpanel, Intercom, Stripe, etc.

**Frequência**: 1x por integração. Depois o Flux gerencia grants/revokes sozinho.

---

## Pré-requisitos

- Acesso root ao VPS (`ssh root@...`)
- Credenciais da API externa (token, key, etc.)
- Saber quais ações os agentes precisam (read, write, produção)

---

## Passo 1: Criar o provider

Copie o template e adapte:

```bash
cp src/ext-providers/github.ts src/ext-providers/{nome}.ts
```

### Estrutura mínima

```typescript
// src/ext-providers/{nome}.ts
import { z } from 'zod';
import type { ExtAction, ExtActionResult, ExtProvider, ProviderSecrets } from '../ext-broker-providers.js';

// --- Helper para chamar a API ---

const BASE_URL = 'https://api.exemplo.com/v1';

async function apiCall(
  path: string,
  secrets: ProviderSecrets,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${secrets.EXEMPLO_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- Ações ---

const listItems: ExtAction = {
  level: 1,                           // L1=read, L2=write, L3=produção
  description: 'Listar items',
  idempotent: true,                    // true para reads, false para writes
  params: z.object({                   // Zod schema — validado pelo broker
    limit: z.number().max(100).default(20),
  }),
  summarize: (p) => {
    const { limit } = p as { limit: number };
    return `List items (limit=${limit})`;
  },
  execute: async (p, secrets) => {
    const { limit } = p as { limit: number };
    const data = await apiCall(`/items?limit=${limit}`, secrets);
    return { ok: true, data, summary: `Listed items (limit=${limit})` };
  },
};

// --- Exportar provider ---

export const exemploProvider: ExtProvider = {
  name: 'exemplo',                     // nome usado em ext_call("exemplo", "list_items", {...})
  requiredSecrets: ['EXEMPLO_API_KEY'], // checados no startup
  actions: {
    list_items: listItems,
    // adicionar mais ações aqui
  },
};
```

### Regras por nível

| Nível | Quando usar | Expira? | Precisa de task? |
|-------|-------------|---------|------------------|
| L1 | Leitura (get, list, search) | Não | Não |
| L2 | Escrita (create, update, delete) | 7 dias | Sim (DOING/APPROVAL) |
| L3 | Produção, dinheiro, irreversível | 7 dias | Sim + 2 aprovações |

---

## Passo 2: Adicionar secrets ao `.env`

```bash
nano /root/nanoclaw/.env
```

Adicionar:

```env
EXEMPLO_API_KEY=sk-xxx-yyy
```

---

## Passo 3: Registrar no broker

Editar `src/ext-broker.ts`, duas alterações:

### 3a. Mapa de secrets (~linha 56)

```typescript
const PROVIDER_SECRETS: Record<string, ProviderSecrets> = {
  github: { GITHUB_TOKEN: process.env.GITHUB_TOKEN || '' },
  'cloud-logs': {},
  exemplo: { EXEMPLO_API_KEY: process.env.EXEMPLO_API_KEY || '' },  // ← ADD
};
```

### 3b. Registrar no `initExtBroker()` (~linha 695)

```typescript
export function initExtBroker(): void {
  ensureExtBrokerSentinelTask();

  // ... providers existentes ...

  import('./ext-providers/exemplo.js').then(({ exemploProvider }) => {  // ← ADD
    import('./ext-broker-providers.js').then(({ registerProvider }) => {
      registerProvider(exemploProvider);
      logger.info('External provider registered: exemplo');
    });
  });
}
```

---

## Passo 4: Build + restart

```bash
cd /root/nanoclaw
npm run build
systemctl restart nanoclaw
```

Verificar nos logs:

```bash
journalctl -u nanoclaw --since "1 min ago" | grep "provider registered"
```

Deve aparecer: `External provider registered: exemplo`

---

## Passo 5: Testar (opcional mas recomendado)

Criar um teste rápido:

```bash
# No VPS, testar o provider isolado
node -e "
  import('./dist/ext-providers/exemplo.js').then(async ({ exemploProvider }) => {
    const r = await exemploProvider.actions.list_items.execute(
      { limit: 5 },
      { EXEMPLO_API_KEY: process.env.EXEMPLO_API_KEY }
    );
    console.log(JSON.stringify(r, null, 2));
  });
"
```

---

## Passo 6: Pronto — Flux cuida do resto

A partir daqui, tudo é automático. Flux gerencia via MCP tools:

```
# Flux concede acesso L1 ao developer
ext_grant(group_folder="developer", provider="exemplo", access_level=1)

# Flux concede acesso L2 com ações específicas
ext_grant(group_folder="developer", provider="exemplo", access_level=2,
          allowed_actions=["create_item", "update_item"],
          denied_actions=["delete_item"])

# Developer usa a integração
ext_call(provider="exemplo", action="list_items", params={limit: 10})

# Flux revoga quando não precisa mais
ext_revoke(group_folder="developer", provider="exemplo")
```

---

## Checklist rápido

```
[ ] 1. Criar src/ext-providers/{nome}.ts
[ ] 2. Adicionar secret ao .env
[ ] 3a. Adicionar ao PROVIDER_SECRETS em ext-broker.ts
[ ] 3b. Registrar no initExtBroker() em ext-broker.ts
[ ] 4. npm run build && systemctl restart nanoclaw
[ ] 5. Verificar log "provider registered"
[ ] 6. (Opcional) Testar o provider isolado
```

---

## Exemplos de providers comuns

### Google Analytics (GA4)

```
Nome: google-analytics
Secret: GA_API_KEY ou GOOGLE_SERVICE_ACCOUNT_JSON
Ações L1: get_pageviews, get_active_users, get_top_pages, get_traffic_sources
Ações L2: create_event, update_property
```

### Mixpanel

```
Nome: mixpanel
Secret: MIXPANEL_API_SECRET
Ações L1: get_events, get_funnels, get_retention, get_insights
Ações L2: track_event, create_annotation
```

### Intercom / Customer Success

```
Nome: intercom
Secret: INTERCOM_ACCESS_TOKEN
Ações L1: list_conversations, get_user, search_contacts
Ações L2: reply_conversation, tag_user, create_note
Ações L3: delete_user, export_data
```

### Stripe

```
Nome: stripe
Secret: STRIPE_SECRET_KEY
Ações L1: list_customers, get_subscription, list_invoices, get_balance
Ações L2: create_customer, update_subscription, create_coupon
Ações L3: create_charge, refund_payment, cancel_subscription
```

### Vercel

```
Nome: vercel
Secret: VERCEL_TOKEN
Ações L1: list_deployments, get_project, list_domains
Ações L2: create_deployment, update_env_vars
Ações L3: promote_to_production, delete_project
```

### Resend (Email)

```
Nome: resend
Secret: RESEND_API_KEY
Ações L1: list_emails, get_email
Ações L2: send_email, create_contact
```

---

## Referência: Arquivos envolvidos

| Arquivo | O que faz | Quem edita |
|---------|-----------|------------|
| `src/ext-providers/{nome}.ts` | Define ações + validação + execução | Admin (1x) |
| `src/ext-broker.ts:56` | Mapa de secrets | Admin (1x) |
| `src/ext-broker.ts:695` | Registrar provider no startup | Admin (1x) |
| `.env` | Credentials reais | Admin (1x) |
| `src/ext-broker-providers.ts` | Interface (NÃO editar) | — |
| `src/ext-broker-db.ts` | DB de capabilities (NÃO editar) | — |
