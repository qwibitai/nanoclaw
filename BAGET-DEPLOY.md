# Baget × NanoClaw — deployment + pairing contract

This doc covers (a) where the baget-channel host runs, and (b) the
admin API contract baget.ai uses to provision per-founder agents.

## Hosting: Railway, single-process mode

The baget-channel host is a long-lived Node.js process running on
Railway alongside the existing `@baget/worker - main` service.

**Why Railway, not Fly.io / DigitalOcean / a VM:**

NanoClaw upstream uses Docker-in-Docker — the host process spawns a
child Docker container per session. Railway, like most managed PaaS,
blocks Docker socket access in service containers. That rules out the
upstream container-per-session model on Railway.

**Why we don't need DinD:** NanoClaw's container isolation defends
against agents that have shell access (Claude Code's Bash tool). Baget's
agent has NO shell — it can only call:
- The 19 `baget-mcp` tools (each fans through baget.ai public API with
  a tenant-scoped bearer token)
- Web search / fetch (read-only HTTP)
- `schedule_message` (writes a row, no exec)

The blast radius of a compromised agent is one founder's bearer token —
which is already scoped per (user, company). OS-level filesystem
isolation is overkill for this threat model.

**Single-process refactor:** the fork's `src/container-runner.ts` is
modified to skip the Docker spawn and run the agent loop in the same
process as the host. Per-session message DBs (the 3-DB model) still
provide isolation at the data layer — every founder's inbound /
outbound queues are separate SQLite files.

When we want filesystem-level isolation later (e.g., to add Bash for
power users), migrate to Fly.io Machines with the upstream Docker
runtime — same code, just toggle the runtime selector in
`src/container-runtime.ts`.

## Service shape on Railway

```
Railway project: baget
├── @baget/worker - main          (existing — BullMQ runner)
└── baget-channel - main          (NEW — this fork)
    ├── Service URL: nanoclaw.baget.ai (custom domain)
    ├── Env:
    │   - DATABASE_URL              (per-host SQLite OR Neon for central state)
    │   - ANTHROPIC_API_KEY          (Claude Agent SDK)
    │   - TELEGRAM_BOT_TOKEN         (the shared @baget_team_bot)
    │   - TELEGRAM_WEBHOOK_SECRET    (constant-time check)
    │   - BAGET_ADMIN_TOKEN          (HMAC for the pairing API)
    │   - BAGET_API_BASE_URL         (https://app.baget.ai for prod)
    │   - ONECLI_*                   (vault config)
    └── Network: receives Telegram webhook directly OR via a forwarder
```

## Pairing contract: baget.ai ↔ baget-channel

### POST /baget/agent-groups

Provisions a per-founder agent_group. Idempotent on (userId, companyId)
— calling twice refreshes the rendered prompt without creating a
duplicate group.

**Auth:** `Authorization: Bearer ${BAGET_ADMIN_TOKEN}` — shared HMAC
between baget.ai and baget-channel, rotated on incident.

**Body:**

```ts
{
  userId: string;        // Baget user UUID
  companyId: string;     // Baget company UUID
  companyName: string;   // Display name for the prompt header
  teamMembers: {         // Per-founder team names from
    cos: string;         //   @baget/shared::getAgentName(companyId, role)
    strategist: string;
    developer: string;
    marketing: string;
    analyst: string;
    design: string;
  };
  channelTokenCredentialName: string;  // OneCLI cred name for this
                                       // founder's bearer token
}
```

**Response (200):**

```ts
{
  ok: true;
  agentGroupId: string;        // ULID, persists across re-provisions
  folder: string;              // e.g. baget-a1b2c3d4-e5f6g7h8
  telegramDeepLink: string;    // t.me/baget_team_bot?start=<token>
  pairingTokenExpiresAt: string;  // ISO 8601, ~5 min from now
}
```

**Behavior:**

1. Compute folder slug: `baget-<userId-prefix-8>-<companyId-prefix-8>`.
2. Render `setup/baget-template/CLAUDE.md.template` with the provided
   `teamMembers` + `companyName` → write atomically to
   `groups/<folder>/CLAUDE.local.md`.
3. Render `setup/baget-template/container_config.json` with patched env
   (`BAGET_COMPANY_ID = companyId`, `BAGET_API_BASE_URL = …`) +
   `secrets: [channelTokenCredentialName]` → write to
   `groups/<folder>/container.json`.
4. Insert / update `agent_groups` row keyed by folder slug.
5. Mint a single-use Telegram pairing token (HMAC over (userId,
   companyId, agentGroupId, exp)). Store SHA256 in Redis with 5-min
   TTL — single-use is enforced by `GETDEL` on consume.
6. Return the deep link.

### POST /baget/agent-groups/bind-telegram

Direct-bind variant for the baget.ai Login Widget flow. Same auth and
body shape as create, plus:

```ts
{
  telegramUserId: number;
  telegramFirstName?: string;
}
```

Behavior:

1. Provision / refresh the founder group as above.
2. Get-or-create the founder's `baget-telegram` messaging_group.
3. Normalize the founder channel into DM semantics:
   - `unknown_sender_policy = 'public'`
   - `is_group = 0`
   - `denied_at = NULL`
   - wiring upgraded to `sender_scope='all'`, `ignored_message_policy='drop'`
4. Enforce one active founder binding per Telegram chat. Rebinding the
   same chat to a new company replaces the old `messaging_group_agents`
   row so delivery remains persona-safe and 1:1.
5. Attempt the immediate welcome DM, but report whether Telegram
   accepted it. If Telegram refuses because the founder has not opened
   the bot chat yet, baget.ai gets a canonical `telegramOpenUrl` it can
   surface in the UI.

Response (200):

```ts
{
  ok: true;
  agentGroupId: string;
  folder: string;
  messagingGroupCreated: boolean;
  welcomeMessageDelivered: boolean;
  founderActionRequired: boolean;
  telegramOpenUrl: string; // https://t.me/<bot_username>
}
```

### POST /baget/agent-groups/:groupId/refresh-prompt

Re-renders the persona prompt — used when a founder renames a team
member on the dashboard. Same auth + body shape as create, but skips
the pairing-token mint. Idempotent.

### DELETE /baget/agent-groups/:groupId

Tears down an agent_group when the founder revokes the channel pairing
from the dashboard. Steps:

1. Set `agent_groups.archived_at = now()` (soft-delete; preserves
   inbound/outbound message history).
2. Revoke the OneCLI credential.
3. Send goodbye message via the bot to the bound chat.
4. Unbind the `conversation_channels` row.

## Telegram bot — single shared bot, multi-founder routing

```
@baget_team_bot (one bot, one TELEGRAM_BOT_TOKEN)
        │
        │  Telegram update → webhook
        │
        ▼
Telegram webhook handler in baget-channel
        │
        │  X-Telegram-Bot-Api-Secret-Token check
        │  update_id dedup (Redis SETNX, 24h TTL)
        │
        ▼
Channel adapter
        │
        │  resolves: (platform='telegram', chat_id) → conversation_channels
        │            → conversation → agent_group
        │
        ▼
Agent loop (this founder's CLAUDE.local.md, this founder's MCP creds)
```

Founder identity is fully derived from the chat_id binding established
during pairing. The model never sees a userId/companyId from the
message — those are looked up server-side after auth.

## Cost estimate (low-end)

- Railway service: ~$10/mo for a 512MB / 0.5 vCPU instance, scales to
  ~50 active founders before needing a bump.
- Anthropic API: same as today, no double-pay (the agent loop runs
  the same prompts, just from a different host).
- Net adder vs current architecture: ~$10–20/mo.

## Phasing

| Phase | Deliverable | ETA |
|-------|------------|-----|
| 1 | Single-process refactor on `baget/single-process-mode` branch | day 1–2 |
| 2 | `src/baget-pairing.ts` (renderer + provision) — DONE in initial commit | landed |
| 3 | Pairing admin API route (`POST /baget/agent-groups`) | day 3 |
| 4 | Telegram webhook handler + chat→group routing | day 3–4 |
| 5 | Dockerfile + Railway service spin-up | day 4 |
| 6 | baget.ai dashboard CTA + backend bridge | day 5 (separate PR on baget.ai) |
| 7 | Feature-flag staging traffic | day 5 |
| 8 | Soak + delete deprecated `apps/web/src/lib/channels/*` | sprint+1 |

## Env vars (single-process mode)

The Railway service reads these at startup. Set them on the
`baget-channel - main` service env tab.

| Var | Required | Default | Purpose |
|-----|---------|---------|---------|
| `RUNTIME` | yes | `docker` | Set to `single-process` on Railway. Skips Docker readiness check, spawns the agent runner as a child Bun process per session. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes (or `GOOGLE_AI_API_KEY`) | — | Primary Gemini credential. Read by the default `gemini` agent-runner provider. |
| `GOOGLE_AI_API_KEY` | yes (or `GOOGLE_GENERATIVE_AI_API_KEY`) | — | Backward-compatible Gemini credential alias. |
| `BAGET_GEMINI_MODEL` | no | `gemini-2.5-flash` | Optional model override for the default `gemini` provider. |
| `ANTHROPIC_API_KEY` | no | — | Legacy Claude provider credential. Keep only if you intentionally switch an agent group back to `claude`. |
| `TELEGRAM_BOT_TOKEN` | yes | — | Bot token for `@baget_team_bot`. Single shared bot across all founders; per-founder routing happens via `messaging_group_agents`. |
| `TELEGRAM_WEBHOOK_SECRET` | yes | — | Echoed in `X-Telegram-Bot-Api-Secret-Token` on every webhook delivery. Constant-time-checked. |
| `TELEGRAM_WEBHOOK_PORT` | no | `3001` | HTTP server port for inbound Telegram webhooks. |
| `BAGET_TELEGRAM_BOT_USERNAME` | yes | `baget_team_bot` | Used to build the `t.me/<username>?start=<token>` deep link returned by the pairing API. Falls back to this username for legacy / global-bot pairings; new pairings under multi-bot pool mode get their own per-company bot username. |
| `BAGET_PUBLIC_BASE_URL` | no | derived from `RAILWAY_PUBLIC_DOMAIN` | Public origin for this Railway service (e.g. `https://nanoclaw.baget.ai`). Required to opt into multi-bot pool mode — used to build the per-bot Telegram webhook URL `<publicBaseUrl>/api/channels/telegram/bot/<username>/webhook` at bind time. When unset, the bind handler falls back to the legacy global-bot path (no per-bot setWebhook); existing single-bot deployments keep working unchanged. |
| `BAGET_ADMIN_TOKEN` | yes | — | Bearer token shared with `baget.ai`. ≥ 16 chars. Rotate by changing both ends; rotate on any incident. Also used as the HMAC key for pairing tokens. |
| `BAGET_ADMIN_PORT` | no | `8443` | HTTP port for the admin pairing API. |
| `BAGET_API_BASE_URL` | yes | — | The baget.ai public API the agent fans tool calls into (`https://app.baget.ai` for prod, `https://stg-app.baget.ai` for staging). Written into each rendered `container.json`. |
| `ONECLI_URL`, `ONECLI_API_KEY` | yes (docker) / no (single-process) | — | Vault config. In single-process mode the agent inherits the host process env, so OneCLI is optional. |
| `BAGET_BUN_PATH` | no | `bun` | Override the `bun` binary path. Useful for local dev where bun lives at `~/.bun/bin/bun`. |
| `DATABASE_URL` | no | `data/v2.db` | Currently the host writes a per-volume SQLite file under `data/`. Future: switch to a managed Postgres if multi-replica becomes a thing. |
| `WEBHOOK_PORT` | no | `3000` | Used by the upstream Chat-SDK webhook server (legacy). Distinct from `TELEGRAM_WEBHOOK_PORT` above. |

**Important:** `RUNTIME=single-process` does NOT bypass tenant isolation. Every founder still gets a distinct `agent_groups` row, distinct session DB files (3-DB model), and distinct OneCLI bearer-token credential. What it bypasses is the kernel-level Docker isolation between sessions — safe in our threat model because the agent has no shell. See § "Why we don't need DinD" above.

**Provider note:** existing group folders keep whichever provider was last rendered into `groups/<folder>/container.json`. New groups pick up the `gemini` default from `setup/baget-template/container_config.json`; older test groups may need to be re-provisioned if they were rendered before this default changed.

## Build & deploy

```bash
# Local Dockerfile build (smoke check)
docker build -t baget-channel:dev .

# Railway-managed deploy: railway.json declares Dockerfile builder, so a
# `git push` to a Railway-linked branch is enough.
git push origin baget/single-process-mode

# Health check (Railway probes /healthz on the admin port — no auth required)
curl -fsS https://nanoclaw.baget.ai/healthz
```

## Telegram webhook setup

After the service is up:

```bash
# Tell Telegram where to deliver updates. Use the same secret you set
# in TELEGRAM_WEBHOOK_SECRET so the channel adapter accepts them.
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://nanoclaw.baget.ai/api/channels/telegram/webhook",
    "secret_token": "${TELEGRAM_WEBHOOK_SECRET}",
    "allowed_updates": ["message"]
  }'
```

The `/api/channels/telegram/webhook` path is owned by the
`baget-telegram` channel adapter, which listens on
`TELEGRAM_WEBHOOK_PORT` (3001 by default). Put a Railway-managed
reverse proxy in front of it on `nanoclaw.baget.ai`.

## Pairing flow end-to-end (smoke test)

```bash
# 1. baget.ai backend asks baget-channel to provision the founder.
curl -X POST https://nanoclaw.baget.ai/baget/agent-groups \
  -H "Authorization: Bearer ${BAGET_ADMIN_TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "user-uuid-...",
    "companyId": "company-uuid-...",
    "companyName": "Acme",
    "teamMembers": {
      "cos": "Louis", "strategist": "Tristan", "developer": "Valentin",
      "marketing": "Chloé", "analyst": "Théo", "design": "Nicolas"
    },
    "channelTokenCredentialName": "baget-channel-token-user-co",
    "bagetApiBaseUrl": "https://app.baget.ai"
  }'
# → { ok: true, agentGroupId, folder, telegramDeepLink, pairingTokenExpiresAt }

# 2. Founder taps deep link, lands at @baget_team_bot, types /start.
#    Telegram delivers a webhook update to baget-channel.
#    The adapter consumes the pairing token + binds the chat.

# 3. Send any DM. Reply comes back as `🧭 Louis: …`.
```
