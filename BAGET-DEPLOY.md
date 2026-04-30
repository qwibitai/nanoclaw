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
   `groups/<folder>/container_config.json`.
4. Insert / update `agent_groups` row keyed by folder slug.
5. Mint a single-use Telegram pairing token (HMAC over (userId,
   companyId, agentGroupId, exp)). Store SHA256 in Redis with 5-min
   TTL — single-use is enforced by `GETDEL` on consume.
6. Return the deep link.

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
