---
name: add-webhook
description: Set up a local webhook HTTP server with ngrok tunnel. Receives events from external services (Linear, GitHub, Slack, etc.) and routes them through Corsair plugins.
---

# Add Webhook Support

## Phase 1: Pre-flight

Check if Corsair is installed:

```bash
test -f src/corsair.ts && echo "found" || echo "missing"
```

If missing, tell the user to run `/add-corsair` first and stop.

Check if already applied:

```bash
test -f src/webhook-server.ts && echo "found" || echo "missing"
```

If found, skip to Phase 3.

## Phase 2: Create Webhook Server

Add `WEBHOOK_PORT` to `src/config.ts`:

```typescript
export const WEBHOOK_PORT = parseInt(process.env.WEBHOOK_PORT || '3002', 10);
```

Create `src/webhook-server.ts`:

```typescript
import http from 'http';
import { processWebhook } from 'corsair';
import { corsair } from './corsair.js';
import { logger } from './logger.js';
import { WEBHOOK_PORT } from './config.js';

export function startWebhookServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end('Method Not Allowed');
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400);
        res.end('Bad Request: invalid JSON');
        return;
      }

      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;

      try {
        const result = await processWebhook(
          corsair as Parameters<typeof processWebhook>[0],
          headers,
          body as Record<string, unknown>,
        );
        logger.info(
          { plugin: result.plugin, action: result.action },
          'Webhook received',
        );

        res.writeHead(result.response?.statusCode ?? 200, {
          'Content-Type': 'application/json',
        });
        res.end(JSON.stringify(result.response?.returnToSender ?? {}));
      } catch (err) {
        logger.error({ err }, 'Webhook error');
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });
  });

  server.listen(WEBHOOK_PORT, () =>
    logger.info({ port: WEBHOOK_PORT }, 'Webhook server listening'),
  );
  return server;
}
```

Wire into `src/index.ts` — add import and start it in `main()`:

```typescript
import { startWebhookServer } from './webhook-server.js';

// in main(), after startCredentialProxy:
const webhookServer = startWebhookServer();

// in shutdown():
webhookServer.close();
```

Build to validate:

```bash
npm run build
```

## Phase 3: Set Up ngrok

Check if ngrok is installed:

```bash
which ngrok || echo "missing"
```

If missing: `brew install ngrok/ngrok/ngrok`

Ask the user for their ngrok auth token (get it from https://dashboard.ngrok.com/get-started/your-authtoken), then:

```bash
ngrok config add-authtoken <token>
```

Start the tunnel:

```bash
ngrok http 3002 > /tmp/ngrok-nanoclaw.log 2>&1 &
sleep 3
curl -s http://localhost:4040/api/tunnels | python3 -c "import sys,json; t=json.load(sys.stdin)['tunnels']; print(next(x['public_url'] for x in t if x['public_url'].startswith('https')))"
```

Show the user the public HTTPS URL — this is the webhook URL they'll register in each service.

## Phase 4: Register Webhook URL

Ask the user which services they want to receive webhooks from (Linear, GitHub, Stripe, Shopify, HubSpot, other).

For each selected service, guide them to their webhook settings page and have them set the URL to the ngrok HTTPS URL from Phase 3. Key settings per service:

- **Linear** → Settings → API → Webhooks → New webhook
- **GitHub** → Repo Settings → Webhooks → Add webhook → Content type: `application/json`
- **Stripe** → Developers → Webhooks → Add endpoint
- **Shopify** → Settings → Notifications → Webhooks
- **HubSpot** → Settings → Integrations → Private Apps → Webhooks

If the service provides a **webhook secret**, add it to `.env` (e.g. `LINEAR_WEBHOOK_SECRET=...`, `GITHUB_WEBHOOK_SECRET=...`), then sync:

```bash
mkdir -p data/env && cp .env data/env/env
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 5: Verify

Send a test event from the service dashboard. Watch logs:

```bash
tail -f logs/nanoclaw.log | grep -i webhook
```

Or test locally:

```bash
curl -s -X POST http://localhost:3002 -H "Content-Type: application/json" -d '{"test":true}' -w "\nHTTP %{http_code}\n"
```

The ngrok web UI at http://localhost:4040 shows all requests in real time.
