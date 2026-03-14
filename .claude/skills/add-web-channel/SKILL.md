---
name: add-web-channel
description: Add a web browser channel with a Redis bridge and Next.js frontend template.
---

# Add Web Channel

This skill adds a browser-facing `web` channel to NanoClaw and ships a deployable Next.js template.

## Phase 1: Pre-flight

AskUserQuestion: Which Redis mode should we configure?
- **Upstash** (Recommended)
- **Self-hosted Redis**

AskUserQuestion: Web trust level?
- **Main** (Recommended)
- **Non-main**

Generate a 32+ character secret:

```bash
openssl rand -base64 32
```

## Phase 2: Apply Code Package

Detect whether automated skill apply tooling is available:

```bash
test -f scripts/apply-skill.ts && echo "has_apply_tool" || echo "manual_only"
```

If present, apply automatically:

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-web-channel
```

If missing, apply manually with explicit diff review:

```bash
# Added files
cp .claude/skills/add-web-channel/add/src/channels/web.ts src/channels/web.ts
cp .claude/skills/add-web-channel/add/src/channels/web.test.ts src/channels/web.test.ts

# Review modified snapshots before replacing
git diff --no-index src/channels/index.ts .claude/skills/add-web-channel/modify/src/channels/index.ts || true
git diff --no-index src/config.ts .claude/skills/add-web-channel/modify/src/config.ts || true
git diff --no-index .env.example .claude/skills/add-web-channel/modify/.env.example || true

# If approved, replace
cp .claude/skills/add-web-channel/modify/src/channels/index.ts src/channels/index.ts
cp .claude/skills/add-web-channel/modify/src/config.ts src/config.ts
cp .claude/skills/add-web-channel/modify/.env.example .env.example

npm install redis
```

## Phase 3: Configure Environment

Add to `.env`:

```bash
WEB_CHANNEL_ENABLED=true
WEB_CHANNEL_REDIS_URL=<redis-url>
WEB_CHANNEL_SECRET=<32+ char secret>
```

Sync env file:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Phase 4: Register `web:main`

If trust level is **Main**:

```bash
mkdir -p groups/web_main/logs
cat > groups/web_main/CLAUDE.md << 'EOF'
# Web Main Group

Authenticated web browser interface.
EOF

npx tsx setup/index.ts --step register \
  --jid "web:main" \
  --name "Web Main" \
  --folder "web_main" \
  --channel web \
  --is-main \
  --no-trigger-required
```

If trust level is **Non-main**:

```bash
mkdir -p groups/web_control/logs
cat > groups/web_control/CLAUDE.md << 'EOF'
# Web Control Group

Authenticated web browser interface with trigger-based processing.
EOF

npx tsx setup/index.ts --step register \
  --jid "web:main" \
  --name "Web Control" \
  --folder "web_control" \
  --channel web
```

## Phase 5: Frontend Template

Copy and install the template:

```bash
cp -r .claude/skills/add-web-channel/assets/web-template ~/nanoclaw-web
cd ~/nanoclaw-web
npm install
```

Create `.env.local` from template and set values:

- `REDIS_URL` (frontend template key; Upstash `rediss://...` or self-hosted `redis://...`)
- `WEB_CHANNEL_SECRET` (must match host `.env`)

Note: host NanoClaw uses `WEB_CHANNEL_REDIS_URL`, while the frontend template uses `REDIS_URL`.

Deploy:

```bash
npx vercel --prod
```

## Phase 6: Validate

```bash
npm run build
npx vitest run src/channels/web.test.ts
```

Smoke test:
1. Authenticate in web UI
2. Send message
3. Confirm reply
4. Disconnect/reconnect browser and confirm stream resume

## Security Notes

- `WEB_CHANNEL_SECRET` is host/frontend only (not container env allowlist).
- Inbound dedupe uses `SET NX EX` on `messageId`.
- Auth uses SHA-256 + `timingSafeEqual`.
- Stream route handles `req.signal` abort and always disconnects Redis in `finally`.
