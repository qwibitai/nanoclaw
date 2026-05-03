# Baget × NanoClaw Path B1 — Handoff

**Date:** 2026-04-30
**Owner:** samuel@baget.ai
**Status:** Channel layer shipped + verified live. LLM step blocked by Bun↔Anthropic-SDK incompat. **Next: build a Gemini provider in `container/agent-runner/src/providers/gemini.ts`.**

This doc is self-contained — read it cold, run the commands at the bottom, and you can continue without backreading the conversation.

---

## 1. Goal

Path B1 from the original spec: a paired Baget founder DMs `@baget_team_staging_bot` on Telegram, the message routes through this fork (`BagetAI/baget-channel`) instead of the in-app webhook in `BagetAI/baget.ai`, and the founder gets a reply from THEIR team (Louis/Tristan/etc., resolved per-company) with persona prefix.

Architecture, contract, env-var matrix → see [`BAGET.md`](../../BAGET.md) and [`BAGET-DEPLOY.md`](../../BAGET-DEPLOY.md).

## 2. Branch + PR state

- **Working branch:** `baget/close-known-gaps` (local) → pushed to `origin/baget/single-process-mode`
- **PR:** [BagetAI/baget-channel#1](https://github.com/BagetAI/baget-channel/pull/1) — DRAFT, base `baget/initial-fork`
- **Latest commit on remote:** check `git log origin/baget/single-process-mode -1`
- **Local-only commits not yet pushed:** several token-fix + Bun-compat experimental commits (run `git status` + `git log` to compare against `origin/baget/single-process-mode`)

The PR contains: schema migration 014, single-process runtime, admin pairing API, Telegram channel adapter, persona prefix, Dockerfile, railway.json, 272 unit tests.

## 3. Deploy state

**Railway service:** `baget-channel` in project `brave-mercy` (id `5001ee84-c29c-4365-a401-a7480bca8bd9`), env `staging`

- **Public URL:** `https://baget-channel-staging.up.railway.app`
- **Custom domain attempted:** `nanoclaw.baget.ai` — Railway-side registered, **DNS NOT propagated** (records were added in Vercel UI but `baget.ai`'s authoritative NS is Squarespace via `ns-cloud-c*.googledomains.com.`, not Vercel; user has not yet added them at the right registrar)
- **Healthcheck:** `GET /healthz` returns `{"ok":true}` ✅

**Telegram webhook** is currently pointed at the Railway URL:
- URL: `https://baget-channel-staging.up.railway.app/api/channels/telegram/webhook`
- Bot: `@baget_team_staging_bot` (id 8713383593, "Baget Team (staging)")
- `pending_update_count: 0`, no errors per `getWebhookInfo`

**Env vars set on `baget-channel` (staging):**
| Var | Value / source |
|-----|---------|
| `RUNTIME` | `single-process` |
| `NODE_ENV` | `production` |
| `BAGET_ADMIN_TOKEN` | random 64-hex (stashed at `/tmp/baget-channel-secrets.env` mode 0600) |
| `BAGET_ADMIN_PORT` | `8443` (overridden at runtime by Railway's `PORT=8080`) |
| `TELEGRAM_WEBHOOK_SECRET` | random 64-hex (same stash) |
| `TELEGRAM_WEBHOOK_PORT` | `3001` (DEAD — single-port refactor mounted webhook on admin server) |
| `BAGET_TELEGRAM_BOT_USERNAME` | `baget_team_staging_bot` |
| `BAGET_API_BASE_URL` | `https://stg-app.baget.ai` |
| `TELEGRAM_BOT_TOKEN` | reference `${{@baget/worker.TELEGRAM_BOT_TOKEN}}` |
| `GOOGLE_AI_API_KEY` | reference `${{@baget/worker.GOOGLE_AI_API_KEY}}` |
| `GOOGLE_GENERATIVE_AI_API_KEY` | reference `${{@baget/worker.GOOGLE_GENERATIVE_AI_API_KEY}}` |
| `AI_PROVIDER` | reference `${{@baget/worker.AI_PROVIDER}}` (DEAD — agent-runner reads from `container.json`, not env) |
| `SENTRY_DSN` | reference `${{@baget/worker.SENTRY_DSN}}` |
| `SENTRY_ENVIRONMENT` | `staging` |
| `ANTHROPIC_API_KEY` | live key set during smoke testing — **flagged for rotation** (see § 7) |

## 4. What works (verified end-to-end against Railway)

| Layer | Status | Evidence |
|-------|--------|----------|
| Admin pairing API auth | ✅ | curl `/baget/agent-groups` w/o bearer → 401; with bearer → 200 |
| HMAC token mint → DB row | ✅ | `tokenHash` matches DB `token_sha256`, single-use CAS verified in tests |
| Pairing token format | ✅ | 32-hex opaque (Telegram-spec compliant; the OLD JWT-shape was the round-1 bug) |
| Telegram webhook receive | ✅ | secret-token constant-time check; bad token → 401 |
| update_id dedup | ✅ | SQLite `baget_seen_updates` + in-memory half-drain |
| `/start <token>` consume | ✅ | log: `Baget telegram: paired chat to agent_group` |
| messaging_group + messaging_group_agents bind | ✅ | log: `Session created`, `Message routed engage_mode=pattern` |
| Inbound message routing | ✅ | router fires; spawns the agent runner |
| Persona prefix renderer | ✅ | unit-tested; would prefix `cos: hi` → `🧭 Louis: hi` if agent ever replied |
| Outbound Telegram send | ✅ | `sendBotMessage` works (used by /start welcome before runner died) |
| Single-port admin+webhook | ✅ | both routes on `$PORT=8080` |
| Schema migration 014 | ✅ | 12 migrations applied on every fresh boot |

## 5. What's broken (the LLM step)

**Symptom:** Every spawned agent runner crashes with exit code 1 within ~60ms of start. Verbatim error from Railway logs (`runner=baget-11111111-aaaaaaaa`):

```
[agent-runner] Starting v2 agent-runner (provider: claude)
[poll-loop] Processing 1 message(s), kinds: chat
649 |       this[kSetRawMode](!1);
650 |     this.closed = !0, this.emit("close");
651 |   }
652 |   pause() {
653 |     if (this.paused)
654 |     return this.input.pause(), this.paused = !0, this.emit("pause"), this;
                                       ^
TypeError: this.input.pause is not a function. (In 'this.input.pause()', 'this.input.pause' is undefined)
      at pause (node:readline:654:28)
      at close (node:readline:647:19)
      at emitError (node:events:43:23)
      at <anonymous> (node:child_process:686:20)
Bun v1.2.20 (Linux x64)
```

**Root cause:** `@anthropic-ai/claude-agent-sdk` uses **Ink (React-for-CLI)** which calls `readline.createInterface({ input: process.stdin })`. When the interface is closed, `pause()` runs `this.input.pause()`. **Bun's `process.stdin` does not implement `.pause()`** — it returns undefined.

Why upstream NanoClaw doesn't hit this: upstream spawns the runner inside `docker run` which allocates a pseudo-TTY by default. Inside that TTY, `process.stdin` is a real readable stream. Single-process mode (this fork's contribution for Railway) skips Docker → no TTY → SDK crashes on teardown.

**Fixes attempted that did NOT work:**
1. `stdio: ['pipe', 'pipe', 'pipe']` + `child.stdin.end()` at spawn site (`src/container-runner.ts`) — Bun's `process.stdin` inside the child is independent of what the parent piped
2. Polyfill `process.stdin.pause/resume/setRawMode` at top of `container/agent-runner/src/index.ts` — either Bun returns a fresh stdin object per access, or `Object.defineProperty` silently fails on a non-configurable property

Both fixes are still in the tree (commit them or revert before merging — see § 9).

## 6. Decision points awaiting user

The user (samuel@baget.ai) was asked to choose between:

| Option | Effort | Outcome |
|--------|--------|---------|
| **Build Gemini provider** in `container/agent-runner/src/providers/gemini.ts` using `@google/genai` SDK | 1–2 days | What user actually wants for prod (per memory: "staging + prod use Vertex Gemini Flash"). Sidesteps Bun↔Ink/readline. |
| Refactor agent-runner to Node + `better-sqlite3` instead of Bun + `bun:sqlite` | 1 day | Lets Anthropic SDK work; doubles sqlite-driver complexity in the tree |
| Add `node-pty` to spawn with a real TTY | half-day | Native dep, fragile Docker build, doesn't address the design mismatch |

User leaning: **Option 1 (Gemini provider)** — based on multiple direct statements ("we need google ai sdk yes", "We are going to use GOOGLE_AI_API_KEY not anthropic"). User's previous claim that "we did it in another PR trust me" did NOT match the codebase — there is currently NO Gemini provider; only `claude.ts` and `mock.ts` exist in `container/agent-runner/src/providers/`.

User has NOT explicitly said "go" on which option as of this handoff.

## 7. Open security follow-ups

1. **Vertex GCP service-account private key leaked** in earlier `--kv` listing.
   - Service account: `baget-vertex@production-baget-ai.iam.gserviceaccount.com`
   - Key ID: `44f5ac1b501833a740b940c5c3646dc06126e729`
   - User aware, has not confirmed rotation. **Top priority — rotate.**

2. **Live Anthropic API key pasted in chat** by user during smoke debugging.
   - Key prefix: `sk-ant-api03-RAniN…SQAA`
   - User: "I don't care about the leaked key — I set up a limit"
   - Currently set as `ANTHROPIC_API_KEY` on Railway baget-channel staging service
   - Will be useless once Gemini provider lands; rotate then or sooner

3. **`baget.ai` DNS confusion**: NS is Squarespace (formerly Google Domains) via `ns-cloud-c*.googledomains.com.`, NOT Vercel. User added `nanoclaw` CNAME + TXT in Vercel UI which had no effect. Records still need to be added in Squarespace DNS (or the existing GCP DNS zone if it's actually delegated there — needs investigation; Cloud DNS API isn't enabled on `production-baget-ai`).

## 8. Synthetic smoke-test artifact (clean up after)

Created during testing — **not real user data**, but uses up a folder + DB row:
- `agent_groups.id`: varies per redeploy (Railway volume isn't persistent — gets wiped). Most recent: `ag-4c4c9e94-7891-43b5-893b-b7e32699c029`
- `agent_groups.user_id`: `11111111-2222-3333-4444-555555555555`
- `agent_groups.company_id`: `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`
- `agent_groups.folder`: `baget-11111111-aaaaaaaa`
- Telegram chat: `8479591682` (samuel@baget.ai's personal account, currently bound to the synthetic group)

Cleanup options:
- Soft-delete via `DELETE /baget/agent-groups/<id>` (works) → unbinds chat
- Or just let the next Railway redeploy wipe the volume

## 9. Quick-start for the next agent

```bash
# Worktree (separate from baget.ai monorepo)
cd /Users/samjfk/baget.ai/.claude/worktrees/baget-channel
git status                        # check uncommitted experimental fixes (stdio + stdin polyfill)
git log --oneline -10             # recent history; PR is at #1
git log origin/baget/single-process-mode --oneline -3   # what's on remote

# Tests + typecheck
npm run typecheck                 # ✓ clean as of last check
npm test                          # ✓ 272 passed

# Railway state
railway list                      # baget project = brave-mercy
railway link --project brave-mercy --environment staging --service baget-channel
railway status
railway variables --json | python3 -c 'import json,sys; [print(k) for k in sorted(json.load(sys.stdin).keys()) if not k.startswith("RAILWAY_")]'
railway logs --service baget-channel --lines 30   # current state

# Smoke recipe (Telegram pairing flow)
URL="https://baget-channel-staging.up.railway.app"
source /tmp/baget-channel-secrets.env             # has ADMIN_TOKEN + WEBHOOK_SECRET
curl -sS -X POST "${URL}/baget/agent-groups" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"userId":"...","companyId":"...","companyName":"...",
       "teamMembers":{"cos":"Louis","developer":"Valentin","marketing":"Chloé","analyst":"Théo","design":"Nicolas","ops":"Marie"},
       "channelTokenCredentialName":"baget-channel-token-smoke",
       "bagetApiBaseUrl":"https://stg-app.baget.ai"}'
# → returns telegramDeepLink with 32-hex token, 5-min TTL

# Tail logs while user taps the deep link
railway logs --service baget-channel --lines 50

# Inbound flow:
#   /start <token>  →  Baget telegram: paired chat to agent_group  ✅ (works)
#   plain DM        →  Spawning single-process runner              ✅ (works)
#   runner spawn    →  TypeError: this.input.pause is not a function  ❌ (Bun↔Ink/readline)
```

**Recommended first action:** read `container/agent-runner/src/providers/claude.ts` for the AgentProvider interface shape, then create `container/agent-runner/src/providers/gemini.ts` implementing the same interface using `@google/genai`. Wire it via the barrel at `container/agent-runner/src/providers/index.ts`. Update `setup/baget-template/container_config.json` to set `"provider": "gemini"`. Don't try to keep the Anthropic SDK working — that's a dead end under Bun without a TTY.

## 10. Files of interest

| File | Why |
|------|-----|
| [`src/baget-admin-server.ts`](../../src/baget-admin-server.ts) | Pairing API + token mint — note `mintPairingToken` reserves an `adminToken?` arg for future HMAC re-introduction |
| [`src/channels/baget-telegram.ts`](../../src/channels/baget-telegram.ts) | Webhook adapter; `/start` regex requires `/^[a-f0-9]{32}$/` shape |
| [`src/container-runner.ts`](../../src/container-runner.ts) | Single-process spawn; experimental stdio fix at line ~340 |
| [`src/db/baget-pairing-tokens.ts`](../../src/db/baget-pairing-tokens.ts) | SHA256-stored single-use token; consume is atomic CAS |
| [`src/db/migrations/014-baget-pairing.ts`](../../src/db/migrations/014-baget-pairing.ts) | Schema for agent_groups extension + pairing tables |
| [`container/agent-runner/src/index.ts`](../../container/agent-runner/src/index.ts) | Top has experimental Bun stdin polyfill (delete or keep) |
| [`container/agent-runner/src/providers/claude.ts`](../../container/agent-runner/src/providers/claude.ts) | Reference impl for AgentProvider interface |
| [`container/agent-runner/src/providers/types.ts`](../../container/agent-runner/src/providers/types.ts) | The interface a Gemini provider must implement |
| [`setup/baget-template/container_config.json`](../../setup/baget-template/container_config.json) | Set `provider: gemini` here once new provider lands |
| [`Dockerfile`](../../Dockerfile) | Runtime image; installs both Node host + Bun runner deps. Bun pinned to 1.2.20 |
| [`BAGET-DEPLOY.md`](../../BAGET-DEPLOY.md) | Env-var matrix + deploy/smoke recipe |

## 11. Lessons (raw — append to `tasks/lessons.md`)

- `[design:smoke-first]` — Token format matters MORE than security depth. The original JWT-shape `<payload>.<hmac>` was secure but Telegram's `?start=<param>` spec caps at 64 bytes of `[A-Z a-z 0-9 _ -]` only. **Why:** silent truncation by Telegram broke the pairing flow on first real-user smoke. **How to apply:** when designing tokens for a specific transport, check the transport's char-set + length limits first; the longer security argument can adapt.
- `[design:bun-claude-sdk]` — `@anthropic-ai/claude-agent-sdk` does not work under Bun without a TTY. **Why:** Ink (React TUI) → readline → `process.stdin.pause()` which Bun doesn't implement. **How to apply:** if running this SDK in a non-Docker context under Bun, plan for either node-pty, switch to Node + better-sqlite3, or use a different SDK (Google's `@google/genai` is non-interactive).
- `[process:hooks]` — Auto mode + a strict permissions hook produces friction. Several legitimate actions ("create Railway service", "register custom domain", "set ANTHROPIC_API_KEY") needed re-authorization beyond the initial broad consent. **How to apply:** write narrower permission rules in `.claude/settings.json` BEFORE starting an autonomous deployment task — see "fewer-permission-prompts" skill.
- `[tooling:railway-kv-leak]` — `railway variables --kv` flattens multi-line JSON values onto one line and pipes them through any sed redaction unfiltered. A Vertex GCP service-account private key got dumped into context. **How to apply:** never use `--kv` on services with JSON-shaped secrets. Use `--json` + `python3 -c 'json.load(sys.stdin); [print(k) for k in keys]'` to list keys only.
