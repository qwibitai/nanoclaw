# NanoClaw Migration Guide

Generated: 2026-04-30
Upgraded: 2026-04-30
Base (merge-base): fb66428eeb7561b663128d7712837a333a6c0b0d
HEAD at generation: c4a6dda34eb5d85f1d1595d10bb2f8dd91113311
HEAD after upgrade: c03b48790f9d1a4f62d825ca8bcebc11090ad594
Upstream at generation: 941a75f65d1599f94e9376f8bda7c1a57fe253a7
Fork origin: chiptoe-svg/nanoclaw_gccourse (v1.2.16 → v2.0.19)

Authoritative source: `docs/CUSTOMIZATIONS.md` — read it alongside this guide.

---

## Decisions Made

| Decision | Choice |
|---|---|
| Credential store | Native credential proxy (`/use-native-credential-proxy`), not OneCLI Vault |
| Auth mode toggle | Keep `/auth` command, port nearly verbatim |
| Per-agent provider | Yes — Claude + Codex from day one (`/add-codex` from `upstream/providers`) |
| OpenAI as a tool | Yes — extend image-gen skill pattern |
| Playground scope | Integrated workbench (config + chat + trace+cost), plus Live Trace standalone view |
| Playground session model | Port v1 lock pattern → AgentGroup (snapshot/restore via `container.json` + `CLAUDE.local.md`) |
| Playground auth | Loopback-only, no auth (drop `auth.ts` + `login.html`) |
| Playground skill source | Local `container/skills/` + external download |
| Model selection | Phase 2 — gated on PR #1968 (`feat/per-agent-provider-and-model-config`) |
| Token + cost tracking | Build ourselves (no upstream signal), independent of PR #1968 |

---

## Migration Plan

**Fork state**: v1 code with manual customizations (no skill branches formally merged). v2 is a large rewrite; this is a clean-base replay, not a merge.

**Order of operations** (from `docs/CUSTOMIZATIONS.md` § Recommended migration order):

1. **Buckets H + I + J** — gitleaks, CI tweaks, docs. Verbatim copies.
2. **Bucket B** — `personas/` directory, drop-in copy.
3. **Bucket F + Bucket D base** — apply upstream `add-voice-transcription` and `add-telegram` skills from `upstream/channels`.
4. **Bucket C** — port `image-gen`, `pdf-reader` container skills. Verify Bun runs `generate.js`.
5. **Bucket G** — port-publishing hook into v2 `container-runner.ts`.
6. **Bucket D layered features** — Markdown parse_mode, sandbox proxy, voice hook, `/auth` handler on top of v2 Telegram.
7. **Bucket E** — apply `/use-native-credential-proxy`, port OAuth refresh + `/auth`.
8. **Bucket L** — `/add-codex`, generalize auth-switch to per-provider modes.
9. **Bucket N** — token tracking + cost (foundation for workbench).
10. **Bucket A Phase 1** — `core.ts`, agent-builder skill, workbench UI.
11. **Bucket A Phase 2** — model dropdown (gated on PR #1968 merging).
12. **Bucket M** — additional OpenAI tool skills, additive post-migration.

**Staging**: Steps 1–6 are mechanical; validate build after each. Steps 7–10 are real engineering — plan and review before starting.

**Risk areas**:
- `src/index.ts`, `src/container-runner.ts`, `src/router.ts`, `src/ipc.ts` — all heavily rewritten in v2. Any custom logic touching these needs careful port.
- Telegram channel: now on `upstream/channels`, not in trunk. Custom features must layer on top of the v2 Telegram skill.
- Credential proxy: OneCLI Vault is v2 default; we skip it via `use-native-credential-proxy` skill.

---

## Applied Skills

No skill branches were formally merged into this fork (all customizations are manual code). The following upstream skills should be applied during upgrade in the worktree before layering manual customizations:

| Skill | Branch | Notes |
|---|---|---|
| `add-telegram` | `upstream/channels` | Apply from channels branch; fork's Telegram customizations layer on top |
| `add-voice-transcription` | `upstream/channels` | Prefer upstream version; drop fork's manual `src/transcription.ts` if covered |
| `use-native-credential-proxy` | `upstream/skill/native-credential-proxy` | Replaces OneCLI Vault default; required before Bucket E auth porting |
| `add-codex` | via `.claude/skills/add-codex/` in v2 main | Applied after base + credential proxy are in place |

**Custom skills** (user-created, copy from main tree into worktree):

- `.claude/skills/migrate-nanoclaw/` — this skill itself; copy as-is.
- `.claude/skills/setup/SKILL.md` — modified version of upstream setup skill; see Bucket E for what changed.

**Dropped skill**: `.claude/skills/add-dashboard/` — do not replay. Upstream now ships `add-dashboard`; use that if a dashboard is wanted later (Bucket K).

---

## Skill Interactions

- `add-telegram` (channels) and voice-transcription (channels) both touch `src/channels/telegram.ts` area. Apply `add-telegram` first, then wire voice-transcription hooks.
- `use-native-credential-proxy` and Bucket E auth-switch (`src/auth-switch.ts`) are tightly coupled — apply the skill first, then port fork's OAuth refresh logic on top.
- `add-codex` depends on `use-native-credential-proxy` being in place (credential routing).
- Bucket A workbench depends on Bucket N (token tracking) for cost display. Apply N before A.

---

## Customizations

### Bucket B — Personas Library

**Intent:** 13 role-specific markdown personas for the agent-builder workbench.

**Files:** `personas/` (13 files: account-manager, content-strategist, copywriter, creative-director, event-planner, graphic-designer, packaging-scientist, personal-assistant, photographer, print-expert, production-artist, social-media-manager, video-producer).

**How to apply:** Copy `personas/` directory verbatim from the fork into the worktree root. Will be read by `src/agent-builder/catalog.ts` (Bucket A).

---

### Bucket C — Container Skills (custom, host-mounted)

**Intent:** OpenAI image generation and PDF reading available to agents as CLI tools.

**Files:**
- `container/skills/image-gen/SKILL.md` + `container/skills/image-gen/generate.js`
- `container/skills/pdf-reader/SKILL.md` + `container/skills/pdf-reader/pdf-reader`
- `container/skills/google-workspace/SKILL.md` (doc-only)

**How to apply:**

1. Copy the three skill directories verbatim into `container/skills/` in the worktree.
2. After container rebuild, verify `image-gen/generate.js` runs under Bun (it's plain-JS `fetch`, should work as-is, but test it).
3. `image-gen` reads `OPENAI_API_KEY` through the native credential proxy — no rewire needed.
4. Remove these from the fork's files that were dropped in `801011b`: `canvas-design`, `frontend-design`, `internal-comms`, `pdf` (Anthropic-bundled). Do not copy them.

---

### Bucket D — Telegram Customizations

**Intent:** Richer Telegram UX on top of the v2 Telegram skill: Markdown formatting, image vision, PDF routing, voice transcription hook, `/auth` command handler, sandbox proxy.

**Files (source):** `src/channels/telegram.ts`, `src/channels/telegram.test.ts`, `src/image.ts`, `src/transcription.ts`.

**How to apply (after `add-telegram` skill is merged in worktree):**

1. **Markdown parse_mode**: In the v2 Telegram channel, find where messages are sent to the Telegram API. Add `parse_mode: 'MarkdownV2'` (or `'Markdown'` if MarkdownV2 causes escaping issues — check fork's `telegram.ts` for which was used).

2. **Photo → image-vision**: In the message handler, detect `message.photo`, download the largest photo, pass it to the image-vision pipeline. Fall back gracefully if vision isn't available. Port the logic from `src/image.ts` and the handler in `src/channels/telegram.ts`.

3. **PDF attachment routing**: Detect `message.document` with MIME type `application/pdf`, download the file, pass it through the pdf-reader skill. Port from `src/channels/telegram.ts` PDF handler.

4. **Voice transcription hook**: Detect `message.voice`, download the OGG file, transcribe via Whisper (prefer the upstream `add-voice-transcription` skill's transcription path; only port `src/transcription.ts` if upstream skill doesn't cover this exact flow). Port from the voice handler in `src/channels/telegram.ts`.

5. **Sandbox proxy** (`https.globalAgent`): The fork sets a custom `https.globalAgent` for a sandbox environment proxy. Check if this is still needed in v2 (it may be environment-specific). Port from `src/channels/telegram.ts` if required.

6. **`/auth` command handler**: Wire the `/auth` Telegram command to `auth-switch.ts` (Bucket E). The handler in `src/channels/telegram.ts` intercepts `/auth api-key` and `/auth oauth` (or similar), calls auth-switch, then sends a confirmation. Port this after Bucket E is in place.

7. **Test suite**: `src/channels/telegram.test.ts` (932 lines) — copy and update imports for v2 adapter pattern.

**v2 note**: Check if `upstream/channels` already covers image-vision or PDF reader as add-on skills. If so, prefer the upstream version and skip the manual port for that feature.

---

### Bucket E — Auth Switching (`/auth` command)

**Intent:** Toggle between API key and OAuth via Telegram (`/auth`), with auto-refresh of OAuth token from Claude CLI credentials file.

**Files (source):** `src/auth-switch.ts`, `src/credential-proxy.ts`, `src/channels/telegram.ts` (`/auth` handler), `.claude/skills/setup/SKILL.md`, `setup/verify.ts`.

**How to apply:**

1. Apply `use-native-credential-proxy` skill first — this handles the mode-by-`.env`-presence detection. Drop fork's `getCurrentAuthMode()` in favor of the skill's version.

2. Port `getOAuthToken()` from `src/credential-proxy.ts` onto v2's credential proxy. This is ~50 LOC that reads `~/.claude/.credentials.json` with a 5-minute refresh buffer. Key logic:
   ```typescript
   // Reads from ~/.claude/.credentials.json
   // Checks token expiry with 5-min buffer before expiry
   // Returns valid access_token or refreshes via OAuth flow
   ```
   This is genuinely additive — the upstream native proxy skill does not include OAuth refresh.

3. Port `src/auth-switch.ts` nearly verbatim. It edits `.env` to comment/uncomment `ANTHROPIC_API_KEY` to toggle API key vs OAuth mode. Update the permission check from the v1 channel-admin model to v2's `agent_group_members` user-role table.

4. Wire the Telegram `/auth` command handler (see Bucket D step 6).

5. Keep the post-restart "ready" notification (from commit `8c53d30`): after an auth switch triggers a restart, the bot sends a confirmation message to the user.

6. **Generalization for Bucket L**: Refactor `auth-switch.ts` from "Claude API/OAuth toggle" to a per-provider mode toggle: `/auth claude api-key`, `/auth claude oauth`, `/auth codex api-key`, `/auth codex subscription`. Same shape, parameterized.

7. Move setup OAuth detection from the old `/setup` skill into the `bash nanoclaw.sh` hand-off-to-Claude error-recovery flow (v2 install flow changed).

---

### Bucket F — Voice Transcription

**Intent:** Whisper-based transcription of Telegram voice notes.

**Files (source):** `src/transcription.ts` (90 LOC, OpenAI Whisper API).

**How to apply:** First check if `upstream/channels` `add-voice-transcription` skill covers this. If it does, prefer the upstream version. Only port `src/transcription.ts` manually if the upstream skill is missing fork-specific behavior (e.g., specific OGG format handling or API parameters used here).

---

### Bucket G — Web Hosting + Remote Control

**Intent:** Agent can expose loopback HTTP services for student demos. Port-publishing hook in container runner + remote-control command.

**Files (source):** `src/container-runner.ts` (port-publish hook), `src/remote-control.ts` + `src/remote-control.test.ts`, `groups/global/CLAUDE.md`, `src/channels/index.ts`, `docs/student-setup-guide.md`.

**How to apply:**

1. Compare upstream v2 `src/remote-control.ts` against the fork's version — upstream added remote-control in v1.2.14 and it may have carried forward. If upstream covers the fork's behavior, skip the manual port.

2. Port the port-publishing hook into v2's `container-runner.ts`. In v2, `container-runner.ts` was rewritten — find where container options are configured and attach the port-publish logic. From the fork's `src/container-runner.ts`, look for the section that calls `--publish` or equivalent on the container spawn.

3. Copy `groups/global/CLAUDE.md` verbatim (this is user content describing the global agent behavior including web hosting instructions).

---

### Bucket H — Security: Gitleaks

**Intent:** Pre-commit and CI secret scanning via gitleaks.

**Files:** `.husky/pre-commit`, `.github/workflows/gitleaks.yml`, `.gitleaks.toml`.

**How to apply:** Copy three files verbatim into the worktree. No modifications needed.

---

### Bucket I — CI Workflow Tweaks

**Intent:** Disable fork-sync workflows that require upstream GitHub App secrets not available in the fork.

**Files:** `.github/workflows/bump-version.yml`, `.github/workflows/update-tokens.yml` (disabled triggers).

**How to apply:** After migration, identify equivalent v2 CI workflows that require upstream secrets (fork-sync, token-update). Disable their triggers the same way the fork did (comment out or set `on: {}` / remove trigger events). Check the fork's versions for the exact pattern used.

---

### Bucket J — Docs

**Intent:** Student-facing setup and playground guides.

**Files:** `docs/student-setup-guide.md`, `docs/student-playground-setup.md`, `docs/student-playground-multi-agent-prompt.md`, `plans/plan_agentplayground.md`.

**How to apply:** Copy verbatim, then do a doc-pass to update v1 references: `/setup` → `bash nanoclaw.sh`, agent-runner overlays → composed `CLAUDE.md`, any v1 API paths or command names that changed.

---

### Bucket L — Codex Provider

**Intent:** OpenAI's Codex CLI as a per-agent provider parallel to Claude. Auth mirrors Claude: ChatGPT subscription or `OPENAI_API_KEY` in `.env`.

**How to apply:**

1. Run `/add-codex` skill after v2 base + credential proxy are in place. The skill copies provider files from `upstream/providers`, wires barrels, installs `@openai/codex` in the container, and rebuilds the image.

2. Generalize `auth-switch.ts` (from Bucket E) to per-provider modes. Commands: `/auth claude api-key`, `/auth claude oauth`, `/auth codex api-key`, `/auth codex subscription`.

3. Wire Codex into `src/agent-builder/core.ts` (Bucket A) as a provider option in the Phase 1 provider dropdown.

**Upstream watch**: PR #1994 (Codex custom endpoint) is open. If it merges before Codex is installed, re-merge the providers branch after to pick it up.

---

### Bucket N — Token Tracking + Cost (foundation)

**Intent:** Track per-session token usage and compute cost. Required by Bucket A workbench cost display. No upstream equivalent — build from scratch.

**How to apply (net-new engineering, ~150–200 LOC):**

1. **Provider event union** — extend `ProviderEvent` in `container/agent-runner/src/providers/types.ts`:
   ```typescript
   | { type: 'usage'; usage: { input: number; output: number; cache_creation?: number; cache_read?: number } }
   ```

2. **Claude provider** — emit `usage` event on each result message (SDK provides this in the message stream).

3. **Codex provider** — emit equivalent from app-server JSON-RPC events.

4. **Poll-loop** — capture usage events, write to `outbound.db`. Add a `usage_events` table or extend the existing message table with usage columns. DB migration required.

5. **Host API** — endpoint to read aggregated usage per agent group / session.

6. **`src/pricing.ts`** — per-model rates table (`input_per_mtok`, `output_per_mtok`, optional cache rates). Hand-maintained. ~50 LOC.

7. **Cost function** — `cost(usage, model) → number`. Pure function, easy to test.

**Dependency**: independent of everything else, but must exist before Bucket A workbench ships cost display.

---

### Bucket A — Agent Playground (rebuild as v2 workbench)

**Intent:** Single-page agent workbench: edit config left, chat right, trace+cost below. Backed by `src/agent-builder/core.ts` (also consumed by an agent-builder Claude Code skill). Separate Live Trace page for watching channel-deployed agents.

**v1 source files:**
```
src/playground/{auth,draft,library,paths,personas,run,server,session,skill-sources,skills,state,trace}.ts
src/playground/public/{app.js,index.html,login.html,style.css}
```

**How to apply (new engineering, not a port):**

1. **`src/agent-builder/core.ts`** — pure library. API: build / list / wire / spawn / duplicate AgentGroups. Two front-ends: playground server (HTTP) and agent-builder skill (Bash). Design this API first before either front-end.

2. **Workbench UI** — three-region single page:
   ```
   ┌──────────────────┬────────────────────────────────┐
   │  Agent config    │  Chat                          │
   │  Provider ▾      │  > test prompt…                │
   │  Model ▾ (P2)    │  …response…                    │
   │  Persona [edit]  │                                │
   │  Skills [+]      │                                │
   │  [Save] [Cancel] │                                │
   ├──────────────────┴────────────────────────────────┤
   │  Trace + cost (live tail of outbound.db)          │
   │  Session total: 4,820 in / 1,140 out · $0.083     │
   └───────────────────────────────────────────────────┘
   ```

3. **v1 → v2 primitive mapping** (see `docs/CUSTOMIZATIONS.md` § Bucket A for full table):
   - Draft → AgentGroup row + `groups/<folder>/{container.json, CLAUDE.local.md}`
   - Active draft lock + snapshot → same lock pattern, snapshot reads `container.json` + `CLAUDE.local.md`
   - Persona content → `groups/<folder>/CLAUDE.local.md`
   - Selected skills → `container.json.skills: string[] | 'all'`
   - Provider → `container.json.provider`

4. **auth.ts → deleted** (loopback-only, no auth). **login.html → deleted**.

5. **server.ts** → thin HTTP layer over `core.ts`. Drop most local state.

6. **session.ts / state.ts / paths.ts / run.ts** → replaced by `core.ts` + AgentGroup DB rows + lock module.

7. **skill-sources.ts / library.ts** → move content into `src/agent-builder/catalog.ts`.

8. **trace.ts** → restructure to consume `outbound.db` + token-usage events from Bucket N.

9. **public/app.js, index.html, style.css** → rewrite handlers to hit new endpoints; restructure DOM for three-region layout.

10. **Live Trace standalone view** — separate page, port from commit `3d56752`.

**Phase 2** (gated on PR #1968): model dropdown plugged into `agent_groups.model` + `sessions.model`. Do not implement until PR #1968 merges.

**Dependencies**: Bucket N (token tracking) must exist before cost display works. `core.ts` API must be designed before server or skill front-end.

---

### Bucket M — Additional OpenAI Tool Skills

**Intent:** Extend image-gen pattern (Bucket C) with more OpenAI capabilities (chat, TTS, Whisper) as Claude-callable tools.

**How to apply:** Ship `image-gen` (Bucket C) first. Add other skills as discrete additive PRs post-migration. None are blocking.

---

## v2 Breaking Changes (Quick Reference)

1. New entity model — users/roles separate; "main channel = admin" retired. → Buckets A, E.
2. Two-DB session split — `inbound.db` / `outbound.db`. → Bucket A trace; use v2 helpers in `src/db/`.
3. Install flow: `bash nanoclaw.sh` replaces `/setup`. → Bucket E setup-OAuth path.
4. Channels moved to `channels` branch. → Bucket D.
5. Providers moved to `providers` branch. → Bucket L.
6. Three-level channel isolation (`session_mode`). → Bucket A lock pattern targets AgentGroup.
7. Shared-source agent-runner (composed `CLAUDE.md`, no per-group overlays). → Bucket A persona path.
8. Bun in container. → Bucket C (verify `image-gen/generate.js`).
9. OneCLI Vault default credential path. → Skipped via `use-native-credential-proxy`. Bucket E.

---

## Upstream Watch List

| Item | Status (2026-04-30) | Impact |
|---|---|---|
| PR #1968 `feat/per-agent-provider-and-model-config` | Open, mergeable, last updated 2026-04-25 | Bucket A Phase 2 model dropdown gated on this. Re-check ~2026-05-14. |
| `upstream/feat/per-group-provider-config` (gavrielc) | Stalled 2026-04-17, no PR | Older design; PR #1968 more comprehensive. |
| PR #2136 Gemini provider | Open, recent | If Gemini added later, fold into Bucket L pattern. |
| PR #1994 Codex custom endpoint | Open | Re-merge providers branch after this lands if Codex was already installed. |

---

## Bucket K — Do Not Replay

- **Dashboard skill / pusher** (`add-dashboard` in `.claude/skills/`, `dashboard-pusher.ts`) — use upstream `add-dashboard` skill if a dashboard is wanted later.
- **Bundled Anthropic skills** (`canvas-design`, `frontend-design`, `internal-comms`, `pdf`) — already removed; students add via playground.
- **Old fork-sync workflow** — already removed.
