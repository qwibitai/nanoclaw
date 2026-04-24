---
name: ui-mockup
description: Generate AI-powered UI redesign mockups of live web pages. Use when asked to create visual mockups, UI redesign concepts, or design explorations for any service in the ecosystem.
allowed-tools: Bash(curl:*) Bash(node:*) Bash(python3:*) Bash(base64:*) Bash(google-chrome:*)
---

# UI Mockup Pipeline

Generate AI-powered UI redesign mockups in 5 phases: context → screenshot → prompt → generate → save.

## Prerequisites

- **Xvfb** running on `:99` — `sudo systemctl status xvfb`
- **Playwright** at `/home/jkeyser/playwright-automation/node_modules/playwright` (system Chrome: `/usr/bin/google-chrome`)
- **AI Proxy API key** — retrieve from Solo Vault (see Phase 3)
- **Agent credentials** — for authenticated screenshots of pay-auth-gated apps

### Service URLs (Container Context)

All `localhost` references use `host.docker.internal` from inside the container:

| Service | URL |
|---------|-----|
| Solo Vault | `http://host.docker.internal:3015` |
| AI Proxy | `http://host.docker.internal:3005` |
| Image Studio | `http://host.docker.internal:3030` |
| Pay Auth | `https://pay.jeffreykeyser.net` (external — CORS requires HTTPS) |

---

## Phase 1: Screenshot

### Option A: Unauthenticated (public pages)

```bash
DISPLAY=:99 google-chrome \
  --headless \
  --screenshot=/tmp/current-ui.png \
  --window-size=1920,1080 \
  --disable-gpu \
  --no-sandbox \
  http://host.docker.internal:<FRONTEND_PORT>
```

### Option B: Authenticated (pay-auth-gated apps)

**Step 1: Retrieve credentials from Solo Vault**

```bash
PAY_AUTH_EMAIL=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/PAY_AUTH_EMAIL | jq -r '.data.value')
PAY_AUTH_PASSWORD=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/PAY_AUTH_PASSWORD | jq -r '.data.value')
```

**Step 2: Write and run Playwright script**

Write this to `/tmp/screenshot-script.js`:

```javascript
const { chromium } = require('/home/jkeyser/playwright-automation/node_modules/playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-gpu']
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  const email = process.env.PAY_AUTH_EMAIL;
  const pass = process.env.PAY_AUTH_PASSWORD;

  // MUST use public HTTPS URL — localhost causes CORS failures on Pay auth calls
  await page.goto('https://<APP>.jeffreykeyser.net', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  // === Method 1 (best): window.__PAY_AUTH__ programmatic API ===
  // Available on apps using pay-auth-integration v6.6.20+.
  const hasWindowAPI = await page.evaluate(() => !!window.__PAY_AUTH__);
  if (hasWindowAPI) {
    await page.evaluate(async ({email, pass}) => {
      await window.__PAY_AUTH__.login(email, pass);
    }, { email, pass });
    await page.waitForTimeout(3000);
  }

  // === Method 2 (good): data-testid selectors + fill() ===
  else if (await page.locator('[data-testid="login-email"]').isVisible().catch(() => false)) {
    await page.fill('[data-testid="login-email"]', email);
    await page.fill('[data-testid="login-password"]', pass);
    await page.click('[data-testid="login-submit"]');
    await page.waitForTimeout(5000);
  }

  // === Method 3 (fallback): React onChange hack ===
  else {
    await page.evaluate(({email, pass}) => {
      const emailEl = document.querySelector('input[type="email"]');
      const passEl = document.querySelector('input[type="password"]');
      const getProps = (el) => el[Object.keys(el).find(k => k.startsWith('__reactProps$'))];
      getProps(emailEl).onChange({ target: { value: email } });
      getProps(passEl).onChange({ target: { value: pass } });
    }, { email, pass });
    await page.waitForTimeout(300);
    await page.locator('[role="dialog"] button:has-text("Sign In")').click({ force: true });
    await page.waitForTimeout(5000);
  }

  // Reload to populate data (first load after login may show "Failed to load")
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  const failed = await page.getByText('Failed to load').isVisible().catch(() => false);
  if (failed) {
    await page.getByText('Try Again').click({ force: true });
    await page.waitForTimeout(5000);
  }

  await page.screenshot({ path: '/tmp/current-ui.png' });
  await browser.close();
})();
```

Run with:

```bash
DISPLAY=:99 PAY_AUTH_EMAIL="$PAY_AUTH_EMAIL" PAY_AUTH_PASSWORD="$PAY_AUTH_PASSWORD" \
  node /tmp/screenshot-script.js
```

### Verify screenshot

```bash
ls -la /tmp/current-ui.png
```

Then read the file to confirm it captured the expected content.

---

## Phase 2: Compose Prompt

Combine codebase context, user guidance, and reference screenshot into a structured prompt:

```
A high-fidelity desktop UI mockup (16:9, 1920x1080) redesigning [PAGE NAME] for [APP NAME].

CURRENT STATE (reference image attached):
[Brief description of what's in the screenshot — layout, components visible, current theme]

REQUESTED CHANGES:
[User's design guidance, translated into specific visual instructions]

KEEP UNCHANGED:
[Elements that should remain as-is]

LAYOUT:
[Describe the target spatial arrangement]

COLOR SCHEME:
[Specific colors, theme, gradients]

STYLE REFERENCE:
[Design system references — "like Linear", "Vercel dashboard aesthetic", etc.]

IMPORTANT: This is a UI mockup — show realistic data, proper typography, and pixel-perfect detail. Do not include browser chrome or device frames.
```

Present to user for approval before generating.

---

## Phase 3: Generate Mockup

### 3a. Retrieve API key

```bash
AI_PROXY_API_KEY=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/AI_PROXY_API_KEY \
  | jq -r '.data.value')
```

### 3b. Encode screenshot and build JSON payload

**IMPORTANT:** Base64-encoded screenshots are too large for shell variables or `jq --arg` (causes `Argument list too long`). Use Python to build the JSON:

```bash
# 1. Encode screenshot to file (not variable)
base64 -w 0 /tmp/current-ui.png > /tmp/ref-b64.txt

# 2. Write prompt to file
cat > /tmp/prompt.txt << 'PROMPT_EOF'
<the full prompt text from Phase 2>
PROMPT_EOF

# 3. Build JSON with Python
python3 -c "
import json
with open('/tmp/ref-b64.txt') as f:
    ref_data = f.read().strip()
with open('/tmp/prompt.txt') as f:
    prompt_text = f.read().strip()
payload = {
    'model': 'gemini-3.1-flash-image-preview',
    'prompt': prompt_text,
    'referenceImages': [{'data': ref_data, 'mimeType': 'image/png'}],
    'config': {'aspectRatio': '16:9'}
}
with open('/tmp/request.json', 'w') as f:
    json.dump(payload, f)
"
```

### 3c. Submit job and poll for completion

The AI Proxy uses an **async job pattern** — submit returns a `job_id`, then poll until `completed`:

```bash
# Submit job
JOB_RESULT=$(curl -s -X POST http://host.docker.internal:3005/v1/image \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AI_PROXY_API_KEY" \
  -d @/tmp/request.json)
JOB_ID=$(echo "$JOB_RESULT" | jq -r '.job_id')
echo "Job submitted: $JOB_ID"

# Poll until complete (typically 15-60 seconds)
while true; do
  POLL=$(curl -s "http://host.docker.internal:3005/v1/image/jobs/$JOB_ID" \
    -H "Authorization: Bearer $AI_PROXY_API_KEY")
  STATUS=$(echo "$POLL" | jq -r '.status')
  echo "Status: $STATUS"
  if [ "$STATUS" = "completed" ]; then
    echo "$POLL" | jq -r '.result.images[0].data' | base64 -d > /tmp/mockup.png
    echo "Mockup saved to /tmp/mockup.png"
    break
  elif [ "$STATUS" = "failed" ]; then
    echo "Failed: $(echo "$POLL" | jq -r '.error.message')"
    break
  fi
  sleep 5
done
```

---

## Phase 4: Save to Image Studio

**IMPORTANT:** Auth requires a **user login JWT** from Pay auth, NOT the admin system token (`PAY_AUTH_TOKEN` from vault). The admin token has a non-UUID `id` that causes 500 errors.

```bash
# Get credentials (reuse from Phase 1 if already set)
PAY_AUTH_EMAIL=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/PAY_AUTH_EMAIL | jq -r '.data.value')
PAY_AUTH_PASSWORD=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/PAY_AUTH_PASSWORD | jq -r '.data.value')

# Login to get JWT
IMAGE_STUDIO_JWT=$(curl -s -X POST https://pay.jeffreykeyser.net/api/v1/users/login \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$PAY_AUTH_EMAIL\", \"passwordPlainText\": \"$PAY_AUTH_PASSWORD\"}" \
  | jq -r '.data.accessToken')

IMAGE_STUDIO_BASE=http://host.docker.internal:3030

# Create image record
IMAGE_RECORD=$(curl -s -X POST "$IMAGE_STUDIO_BASE/api/v1/images" \
  -H "Authorization: Bearer $IMAGE_STUDIO_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"<SERVICE_NAME> UI Redesign Mockup\"}")
IMAGE_ID=$(echo "$IMAGE_RECORD" | jq -r '.data.id')

# Upload as version 1 (field name MUST be "image", not "file")
curl -s -X POST "$IMAGE_STUDIO_BASE/api/v1/images/$IMAGE_ID/versions" \
  -H "Authorization: Bearer $IMAGE_STUDIO_JWT" \
  -F "image=@/tmp/mockup.png"

echo "Stored as image $IMAGE_ID, version 1"
```

For iterations, upload new versions to the same image record instead of creating a new one.

---

## Phase 5: Review

1. Read `/tmp/mockup.png` to display to user
2. Compare side-by-side with `/tmp/current-ui.png`
3. If changes needed: adjust prompt, re-run Phase 3, add new version in Phase 4

---

## Quick Reference (Minimal End-to-End)

```bash
# 1. Screenshot (public page)
DISPLAY=:99 google-chrome --headless --screenshot=/tmp/current-ui.png \
  --window-size=1920,1080 --disable-gpu --no-sandbox http://host.docker.internal:<PORT>

# 2. Get API key
AI_PROXY_API_KEY=$(curl -s -H "Authorization: Bearer $SOLO_VAULT_KEY" \
  http://host.docker.internal:3015/v1/secrets/agent-services/production/AI_PROXY_API_KEY \
  | jq -r '.data.value')

# 3. Encode + build payload
base64 -w 0 /tmp/current-ui.png > /tmp/ref-b64.txt
cat > /tmp/prompt.txt << 'EOF'
A high-fidelity desktop UI mockup redesigning the main page. Dark theme, modern layout.
EOF
python3 -c "
import json
with open('/tmp/ref-b64.txt') as f: ref = f.read().strip()
with open('/tmp/prompt.txt') as f: prompt = f.read().strip()
json.dump({'model':'gemini-3.1-flash-image-preview','prompt':prompt,
  'referenceImages':[{'data':ref,'mimeType':'image/png'}],
  'config':{'aspectRatio':'16:9'}}, open('/tmp/request.json','w'))
"

# 4. Submit + poll
JOB_ID=$(curl -s -X POST http://host.docker.internal:3005/v1/image \
  -H "Content-Type: application/json" -H "Authorization: Bearer $AI_PROXY_API_KEY" \
  -d @/tmp/request.json | jq -r '.job_id')
while true; do
  POLL=$(curl -s "http://host.docker.internal:3005/v1/image/jobs/$JOB_ID" \
    -H "Authorization: Bearer $AI_PROXY_API_KEY")
  STATUS=$(echo "$POLL" | jq -r '.status')
  [ "$STATUS" = "completed" ] && { echo "$POLL" | jq -r '.result.images[0].data' | base64 -d > /tmp/mockup.png; break; }
  [ "$STATUS" = "failed" ] && { echo "FAILED"; break; }
  sleep 5
done
```

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `Argument list too long` | Base64 in shell variable | Use file-based approach with Python (see Phase 3b) |
| Auth 500 on Image Studio | Using admin token instead of user JWT | Login as `agent@jeffreykeyser.net` via Pay auth |
| CORS failure on screenshot | Using `localhost` URL for auth-gated app | Use `https://<app>.jeffreykeyser.net` (public HTTPS) |
| Screenshot shows login modal | Credentials not passed or login failed | Check Solo Vault key, try all 3 login methods |
| Policy violation (422) | Prompt triggered content filter | Rephrase prompt, remove potentially flagged terms |
| Job timeout | Generation taking too long | Check AI Proxy health, retry |
| Blank screenshot | Xvfb not running | `sudo systemctl start xvfb` |
| `Cannot find module playwright` | Wrong path | Use `/home/jkeyser/playwright-automation/node_modules/playwright` |

### Aspect Ratios

| Target | Ratio |
|--------|-------|
| Desktop page | `16:9` (default) |
| Tablet view | `4:3` |
| Mobile view | `9:16` |
| Component detail | `1:1` |
