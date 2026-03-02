# Plan: Interactive Web Setup Wizard

## Context

Sovereign currently requires manually editing `.env` files and running CLI commands to set up. Non-technical users can't get started without help. We need a beautiful web-based setup wizard that runs at `localhost:3457/setup` — user fills in a form, wizard does everything else.

## Architecture

Single new file `src/setup-wizard.ts` exports a request handler that intercepts `/setup*` routes before the dashboard's auth gate. HTML/CSS/JS served as inline template literals (matching existing dashboard pattern). Wizard state persisted to `store/wizard-state.json`. Build step runs as background child processes with SSE streaming.

```
User runs: node dist/index.js (or npm run setup)
  → Browser opens localhost:3457/setup
  → Multi-step form (SPA, no page reloads)
  → Each step validates + writes config
  → Build step streams friendly progress via SSE
  → Done → redirect to dashboard
```

## Wizard Steps (6 Steps — Streamlined)

> **Design principle:** Build momentum with easy, creative wins before high-friction tasks. "Create, then connect" — let users define their agent before configuring infrastructure.

### Step 1: Welcome
- Prerequisites auto-check (Node version, Docker running, platform detection)
- Friendly language: "Let's set up your AI agent" not "Checking dependencies"
- If Docker not running: "Is the Docker Desktop app running?" (not technical error)

### Step 2: Identity (Name + Personality combined)
- "Who is your agent?" — single screen, two sections
- **Top:** Agent name input (default: "Adam")
- **Bottom:** Personality presets as visual cards
  - Entrepreneur (Adam Love) — bold, strategic, growth-focused
  - Assistant — helpful, organized, precise
  - Developer — technical, problem-solving, code-first
  - Custom — textarea for freeform personality description
- This is the fun creative step — builds emotional investment before config work

### Step 3: AI Engine (Provider + Budget combined)
- "Give [Agent Name] its brain"
- **Top:** Provider toggle — Anthropic Direct / OpenRouter
  - Embedded looping GIF/visual showing exactly where to find the API key on each platform
  - Paste API key → live validation via real HTTP call
  - Human-readable errors: "This key doesn't seem to have credits" not "401 Unauthorized"
- **Bottom:** Budget tier selector (appears after valid key)
  - Best Quality — uses top models, ~$X/day estimate
  - Balanced — smart routing, ~$X/day estimate
  - Budget — lightweight models, ~$X/day estimate
  - Shows which models each tier uses

### Step 4: Channel
- "Where will [Agent Name] live?"
- Pick Discord / Slack / WhatsApp (visual cards with platform logos)
- Guided bot creation with embedded GIFs/screenshots showing exact clicks
  - Discord: "Go to Discord Developer Portal → New Application → Bot → Copy Token"
  - Slack: "Create App → Socket Mode → Bot Token Scopes → Install → Copy Token"
  - WhatsApp: QR code scan flow
- Paste token → validates via platform API
- Human-readable errors: "This token was revoked or is from a different bot" not "403"

### Step 5: Build
- "Waking up [Agent Name]..."
- **NOT raw terminal output** — friendly phase indicators:
  1. "Validating configuration..." (checkmark when done)
  2. "Compiling [Agent Name]'s brain..." (TypeScript build, ~10s)
  3. "Building [Agent Name]'s home..." (Docker container, ~3-5 min)
  4. "Starting [Agent Name]..." (service setup)
- Subtle progress animation between phases
- **Collapsible "Technical Details" section** for power users who want raw logs
- **"Notify me when done" option** — browser notification permission request
- Estimated time remaining shown per phase
- If a phase fails: human-readable message + "Try Again" button
  - "Docker couldn't connect. Is Docker Desktop running?" not build error dump

### Step 6: Done
- Success screen with green checkmarks for each completed component
- "[Agent Name] is alive!" with personality preview
- "Open Dashboard" primary button → redirects to `/`
- Quick tips: "Send a message in [Discord/Slack/WhatsApp] to start talking"
- Link to docs for advanced configuration

## Files to Create

### `src/setup-wizard.ts` (~500-600 lines)
The entire wizard: HTML SPA, API route handlers, build job manager.

- `handleWizardRequest(req, res): boolean` — main entry, called from dashboard before auth
- Localhost guard on all routes (`127.0.0.1` / `::1` only)
- `GET /setup` → serves SPA HTML (template literal with inline CSS/JS)
- `GET /setup/api/state` → returns wizard progress JSON
- `POST /setup/api/check` → runs env detection (Node version, Docker status, platform)
- `POST /setup/api/identity` → saves agent name + personality to state
- `POST /setup/api/provider` → validates API key via HTTP call to provider, writes `.env`
- `POST /setup/api/model` → saves budget tier to state
- `POST /setup/api/channel` → validates Discord/Slack token via their APIs, writes `.env`
- `POST /setup/api/build` → kicks off async build (returns immediately)
- `GET /setup/api/build/stream` → SSE endpoint streaming build phases (not raw logs)
- `POST /setup/api/complete` → writes personality to `groups/main/CLAUDE.md`, writes `model-routing.json`, marks wizard done
- `GET /setup/api/verify` → health check (service running, docker OK, credentials OK)

### `src/wizard-state.ts` (~50 lines)
Thin persistence layer for wizard progress.

- `readWizardState(): WizardState`
- `writeWizardState(state): void`
- `isWizardComplete(): boolean`
- `markStepComplete(step): void`
- State stored at `store/wizard-state.json`

## Files to Modify

### `src/env.ts`
Add `writeEnvFile(updates: Record<string, string>): void`
- Reads existing `.env` (or creates if missing)
- For each key: replaces existing line or appends
- Quotes values containing spaces with double quotes
- Follows the pattern already used in `setup/register.ts` lines 153-169

### `src/dashboard.ts`
Four surgical changes:
1. Import `handleWizardRequest` from `setup-wizard.ts`
2. Insert as first handler in `http.createServer` callback — before `checkAuth`
3. Fix startup auth guard: don't throw when wizard is incomplete (wizard has its own localhost-only security)
4. Add `POST` to `Access-Control-Allow-Methods` in `setSecurityHeaders()`

### `src/index.ts`
Start dashboard server unconditionally during wizard mode (currently gated behind `DASHBOARD_ENABLED`):
```
if (DASHBOARD_ENABLED || !isWizardComplete()) {
  const { startDashboard } = await import('./dashboard.js');
  startDashboard();
}
```

## Build Step Strategy

The build step is the trickiest — `docker build` takes 3-5 minutes and existing setup modules call `process.exit()` on failure.

**Solution:** Spawn each build phase as a child process via `spawn()`. Track phases (not raw lines) and push phase transitions to connected browsers via SSE.

Build sequence:
1. `npm run build` (TypeScript compile, ~10s) → "Compiling [Name]'s brain..."
2. `docker build -t sovereign-agent:latest container/` (~3-5 min) → "Building [Name]'s home..."
3. Write launchd plist or systemd unit (inline, same logic as `scripts/deploy.sh`) → "Setting up auto-start..."
4. Start the service → "Starting [Name]..."

Module-level `buildJob` object tracks:
- `status`: `idle | running | done | failed`
- `phase`: current phase name
- `phases`: array of `{ name, status, startedAt, completedAt }`
- `rawLog`: full log lines (for collapsible technical details)

SSE pushes phase transitions + percentage estimate, not individual log lines.

## Security

- **Localhost only** — all `/setup*` routes hard-check `req.socket.remoteAddress`. Server already binds `127.0.0.1`.
- **First-run only** — once `store/wizard-state.json` has `completed: ['done']`, all wizard routes return 403.
- **API keys** — validated via real HTTP call, written directly to `.env` via `writeEnvFile()`. Never stored in wizard state JSON.
- **No CSRF concern** — localhost-only, no auth cookies.
- **Body size limit** — 64KB max on POST bodies.

## UI Design

- Dark theme matching dashboard (`#0d1117` background, `#c9d1d9` text)
- Progress bar at top (thin accent bar, 6 segments, fills left-to-right)
- Step cards with smooth CSS transitions (opacity + translateY)
- Each step: title, friendly description, input(s), "Next" button
- "Back" button to revisit previous steps (pre-populated with saved data)
- **Build step:** Phase-based progress (not raw terminal), collapsible technical details
- **Done step:** Green checkmarks, agent name personalized, "Open Dashboard" button
- Mobile-friendly (flexbox, readable on phone)
- **Error states:** Human-readable messages with actionable next steps, never raw error codes
- **Visual guides:** Embedded screenshots/GIFs for API key + bot token retrieval (like Stripe's onboarding)

## Error Message Philosophy

Every error the user might see must be:
1. **Human-readable** — no status codes, no stack traces
2. **Actionable** — tells them what to do, not just what went wrong
3. **Contextual** — references the platform/step they're on

Examples:
| Technical Error | User Sees |
|---|---|
| `401 Unauthorized` (Anthropic) | "This API key wasn't recognized. Double-check you copied the full key from console.anthropic.com" |
| `403 Forbidden` (Discord) | "This bot token was rejected by Discord. Make sure you copied the Token (not the Client ID) from the Bot tab" |
| `ECONNREFUSED` (Docker) | "Can't connect to Docker. Is Docker Desktop running? Look for the whale icon in your taskbar" |
| `npm run build` fails | "Something went wrong compiling. Click 'Show Details' for the technical log, or try again" |

## Implementation Order

### Phase 1 — Foundation
1. `src/wizard-state.ts` — state persistence
2. `src/env.ts` — add `writeEnvFile()`
3. `src/setup-wizard.ts` — HTTP skeleton + SPA HTML shell + `/setup/api/state`
4. `src/dashboard.ts` — wire wizard handler, fix auth guard
5. `src/index.ts` — start dashboard during wizard mode
6. Verify: `npm run dev` → `localhost:3457/setup` shows wizard frame

### Phase 2 — Steps 1-2 (Welcome + Identity)
1. Environment check endpoint (Node, Docker detection)
2. Identity save endpoint (name + personality)
3. SPA JavaScript: step navigation, fetch-based form submission, validation UI
4. Personality preset cards with visual selection

### Phase 3 — Step 3 (AI Engine)
1. Provider toggle + API key input
2. Key validation via real HTTP calls (Anthropic + OpenRouter)
3. Budget tier selector (appears after valid key)
4. Human-readable error messages for invalid keys
5. Embedded visual guides for finding API keys

### Phase 4 — Step 4 (Channel)
1. Channel selection cards (Discord / Slack / WhatsApp)
2. Token validation via platform APIs
3. Embedded visual guides for bot creation
4. Human-readable error messages for invalid tokens

### Phase 5 — Step 5 (Build & Deploy)
1. Build job manager with `spawn()`
2. Phase-based progress tracking (not raw log streaming)
3. SSE endpoint pushing phase transitions
4. Friendly phase labels personalized with agent name
5. Collapsible technical details for power users
6. Service setup (launchd/systemd) after container build

### Phase 6 — Step 6 (Done) + Polish
1. Health check verification endpoint
2. `POST /complete` — writes CLAUDE.md, model-routing.json, marks done
3. Success screen personalized with agent name
4. Auto-redirect from `/` to `/setup` when wizard incomplete
5. Error message polish pass (all human-readable)
6. Visual polish pass

## Verification

1. Delete `store/wizard-state.json` and `.env` to simulate fresh install
2. Run `npm run dev`
3. Open `localhost:3457/setup` — should show wizard
4. Walk through all steps with real API keys and bot tokens
5. Build step should show friendly phase progress (not raw terminal)
6. After completion, `/setup` should return 403, `/` shows dashboard
7. Restart process — should go straight to dashboard, not wizard

## Credits

UX flow refined with feedback from Gemini 2.5 Pro review (step consolidation, momentum-based ordering, humanized build phase, error message philosophy).
