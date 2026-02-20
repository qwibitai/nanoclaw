# Deploy `add-slack` From Raw NanoClaw

## 1. Start from a clean base repo

```bash
git clone https://github.com/qwibitai/nanoclaw.git nanoclaw_raw
cd nanoclaw_raw
npm install
```

## 2. Add the skill package

Place the Slack skill at:

```text
.claude/skills/add-slack/
```

Expected contents:

- `SKILL.md`
- `manifest.yaml`
- `add/src/channels/slack.ts`
- `add/src/channels/slack.test.ts`
- `modify/...` (index/config/group-queue/types/routing.test/package.json/.env.example)
- `references/slack-app-manifest.yaml`
- `references/slack-setup.md`
- `scripts/apply-slack-mvp.sh`
- `scripts/verify-slack-mvp.sh`

## 3. Initialize skill state (first time only)

```bash
npx tsx scripts/apply-skill.ts --init
```

## 4. Apply the Slack skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-slack
```

Or:

```bash
.claude/skills/add-slack/scripts/apply-slack-mvp.sh
```

## 5. Verify skill application

```bash
.claude/skills/add-slack/scripts/verify-slack-mvp.sh
```

## 6. Slack-side setup

1. Go to Slack app management and create an app from manifest.
2. Paste:
   - `.claude/skills/add-slack/references/slack-app-manifest.yaml`
3. Create an App-Level Token with scope:
   - `connections:write`
   This is your `SLACK_APP_TOKEN` (`xapp-...`).
4. Install app to workspace.
5. Copy credentials:
   - `SLACK_BOT_TOKEN` (`xoxb-...`)
   - `SLACK_APP_TOKEN` (`xapp-...`)
   - `SLACK_SIGNING_SECRET`
6. Invite bot to channels you want to use.

## 7. Runtime config

Set in `.env`:

```bash
GATEWAY_CHANNEL=slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

Channel modes:

- `whatsapp` = WhatsApp only
- `slack` = Slack only
- `both` = both gateways (recommended for phased rollout)

Claude credentials are still required for agent execution:

- `CLAUDE_CODE_OAUTH_TOKEN=...` or
- `ANTHROPIC_API_KEY=...`

## 8. Start + smoke test

1. Start NanoClaw (`npm run dev` or your service runner).
2. In a Slack channel, mention bot once (`@NanoClawAgent ...`) and confirm auto-registration.
3. In Slack DM, send a message and confirm DM handling (if DM is enabled in Slack App settings).
4. Send a long request, then run `/abort` and confirm cancellation.
5. Send a WhatsApp test message and confirm unchanged behavior when `GATEWAY_CHANNEL=both`.

## 9. Quick troubleshooting

- `Connected to Slack (Socket Mode)` missing:
  - Re-check Slack tokens, Socket Mode, app install, and workspace.
- Message received but agent replies `Not logged in · Please run /login`:
  - Add `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) to `.env`, then restart.
- DM shows “Sending messages to this app has been turned off”:
  - Enable DM/App Home messaging in Slack app settings, then reinstall app.
