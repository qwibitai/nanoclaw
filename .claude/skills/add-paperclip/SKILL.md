---
name: add-paperclip
description: Register NanoClaw as an HTTP adapter agent in Paperclip. Receives issue heartbeats, routes them to the configured group, and lets the agent post comments back via paperclip-reporter.
---

# Add Paperclip Integration

This skill wires NanoClaw into a Paperclip instance as an HTTP adapter agent. Paperclip sends issue heartbeats to NanoClaw's webhook; NanoClaw routes them to the configured group (typically a dedicated agent like k2) as task messages. The agent can post comments back to Paperclip runs using the included `paperclip-reporter` CLI helper.

Authentication uses HS256 JWTs signed with `PAPERCLIP_AGENT_JWT_SECRET` — the same mechanism Paperclip's own adapter system uses.

## Phase 1: Pre-flight

### Check if already applied

Check if `src/paperclip-webhook.ts` already exists. If it does, skip to Phase 3 (Configure).

### Collect connection details

Use `AskUserQuestion` to ask:

> 1. What is the URL of your Paperclip instance? (default: `http://paperclip:3100`)
> 2. What is your Paperclip agent JWT secret? (the HS256 signing secret configured in Paperclip for HTTP adapter agents)
> 3. What is the agent ID registered in Paperclip? (e.g. `k2`)
> 4. What is your Paperclip company ID?
> 5. What Bearer token should Paperclip use to authenticate heartbeats to NanoClaw? (choose any secret string — this becomes `PAPERCLIP_WEBHOOK_SECRET`)
> 6. What is the folder name of the group that should handle Paperclip tasks? (e.g. `k2` — must already be a registered group)

### Test Paperclip API connectivity

```bash
curl -s <PAPERCLIP_URL>/api/issues | head -c 500
```

The response must be valid JSON. If connection is refused, verify Paperclip is running and reachable from the NanoClaw host.

## Phase 2: Apply Code Changes

### Write the webhook server

Create `src/paperclip-webhook.ts` with exactly the following content:

> (File already created by this skill — check git status. If missing, recreate from the skill source.)

### Write the reporter helper

Create `container/agent-runner/src/paperclip-reporter.ts` — the CLI helper k2 uses to post comments back to Paperclip runs.

> (File already created by this skill — check git status. If missing, recreate from the skill source.)

### Wire webhook server into src/index.ts

Open `src/index.ts` and make two edits:

**1. Add import** — after the `startSchedulerLoop` import, add:

```typescript
import { startPaperclipWebhookServer } from './paperclip-webhook.js';
```

**2. Start the server** — immediately after the `startCredentialProxy` block, add:

```typescript
// Start Paperclip webhook server if configured
if (process.env.PAPERCLIP_WEBHOOK_SECRET || process.env.PAPERCLIP_GROUP_FOLDER) {
  const paperclipPort = parseInt(process.env.PAPERCLIP_WEBHOOK_PORT ?? '3102', 10);
  startPaperclipWebhookServer(paperclipPort, {
    storeMessage,
    enqueueGroup: (jid) => queue.enqueueMessageCheck(jid),
    registeredGroups: () => registeredGroups,
  });
}
```

### Add env passthrough to src/container-runner.ts

Open `src/container-runner.ts` and add the following blocks after the `OLLAMA_URL` block in `buildContainerArgs()`:

```typescript
  if (process.env.PAPERCLIP_URL) {
    args.push('-e', `PAPERCLIP_URL=${process.env.PAPERCLIP_URL}`);
  }
  if (process.env.PAPERCLIP_AGENT_JWT_SECRET) {
    args.push('-e', `PAPERCLIP_AGENT_JWT_SECRET=${process.env.PAPERCLIP_AGENT_JWT_SECRET}`);
  }
  if (process.env.PAPERCLIP_AGENT_ID) {
    args.push('-e', `PAPERCLIP_AGENT_ID=${process.env.PAPERCLIP_AGENT_ID}`);
  }
  if (process.env.PAPERCLIP_COMPANY_ID) {
    args.push('-e', `PAPERCLIP_COMPANY_ID=${process.env.PAPERCLIP_COMPANY_ID}`);
  }
```

Note: `PAPERCLIP_WEBHOOK_SECRET` is intentionally not forwarded to containers — it is a host-side secret and the container agent does not need it.

### Copy to per-group agent-runner

Existing groups have a cached copy of the agent-runner source. Update them:

```bash
for dir in data/sessions/*/agent-runner-src; do
  cp container/agent-runner/src/paperclip-reporter.ts "$dir/"
done
```

### Build

```bash
npm run build
./container/build.sh
```

Build must be clean before proceeding.

## Phase 2b: Update container-runner.ts

If this wasn't already done in Phase 2, verify the passthrough blocks are present:

```bash
grep -n "PAPERCLIP" src/container-runner.ts
```

Expected output: four lines for `PAPERCLIP_URL`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_COMPANY_ID`.

## Phase 3: Configure

### Configure environment variables

On Unraid/Docker deployments: add each variable directly to the NanoClaw container template via the Unraid Docker UI (edit container → add variable).

On standard Linux/macOS deployments: append to `.env` and sync:

```bash
PAPERCLIP_URL=http://paperclip:3100
PAPERCLIP_AGENT_JWT_SECRET=<jwt-signing-secret-from-paperclip>
PAPERCLIP_AGENT_ID=k2
PAPERCLIP_COMPANY_ID=<your-company-id>
PAPERCLIP_WEBHOOK_SECRET=<your-chosen-secret>
PAPERCLIP_GROUP_FOLDER=k2
# Optional — default is 3102:
# PAPERCLIP_WEBHOOK_PORT=3102
```

Then sync:
```bash
cp .env data/env/env
```

Also add placeholder entries to `.env.example` if not already present:

```bash
PAPERCLIP_URL=
PAPERCLIP_AGENT_JWT_SECRET=
PAPERCLIP_AGENT_ID=
PAPERCLIP_COMPANY_ID=
PAPERCLIP_WEBHOOK_SECRET=
PAPERCLIP_GROUP_FOLDER=
PAPERCLIP_WEBHOOK_PORT=
```

### Expose the webhook port

The webhook server listens on port 3102 (or `PAPERCLIP_WEBHOOK_PORT`). Ensure this port is accessible from Paperclip:

- **Unraid/Docker**: add a port mapping `3102:3102` to the NanoClaw container template.
- **macOS**: the port is available on the host directly; ensure firewall allows it.
- **Linux**: open the port in iptables/ufw if needed: `ufw allow 3102`.

If NanoClaw is on the same Docker network as Paperclip, no port exposure is needed — use the container name as the hostname.

### Restart the service

On Unraid/Docker:
```bash
docker restart NanoClaw
```
On standard Linux: `systemctl --user restart nanoclaw`
On macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`

## Phase 4: Register in Paperclip

### Register NanoClaw as an HTTP adapter agent

In Paperclip, create a new HTTP adapter agent with the following settings:

| Field | Value |
|-------|-------|
| Agent ID | `k2` (must match `PAPERCLIP_AGENT_ID`) |
| Adapter type | HTTP |
| Endpoint URL | `http://<nanoclaw-host>:3102/api/paperclip/heartbeat` |
| Auth header | `Authorization: Bearer <PAPERCLIP_WEBHOOK_SECRET>` |

The exact Paperclip UI path depends on your version — typically: **Settings → Agents → New Agent → HTTP Adapter**.

Note the JWT signing secret shown during agent creation — this becomes `PAPERCLIP_AGENT_JWT_SECRET`.

### Assign issues to the agent

In Paperclip, assign an issue to `k2`. Paperclip will POST a heartbeat to NanoClaw:

```json
{
  "agentId": "k2",
  "runId": "run_abc123",
  "context": {
    "issueId": "ISSUE-42",
    "title": "Fix the race condition in the auth middleware",
    "body": "Users are occasionally seeing 401s on valid sessions...",
    "labels": ["bug", "auth"]
  }
}
```

NanoClaw will:
1. Authenticate the Bearer token
2. Fetch full issue details from the Paperclip API (authenticated via HS256 JWT)
3. Format the issue as a task message and store it in the database
4. Enqueue the k2 group — the agent container starts and processes the task

## Phase 5: Verify

### Test the webhook manually

```bash
curl -s -X POST http://localhost:3102/api/paperclip/heartbeat \
  -H "Authorization: Bearer <PAPERCLIP_WEBHOOK_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"agentId":"k2","runId":"test-run-001","context":{"issueId":"TEST-1","title":"Test issue","body":"This is a test."}}'
```

Expected response: `{"ok":true}`

### Check the agent received the task

The k2 group should activate and the agent should process the task message:

```bash
tail -f logs/nanoclaw.log | grep -i paperclip
```

Look for:
- `Paperclip webhook server listening` — server started
- `Paperclip task routed to group` — heartbeat processed
- `Agent output:` — agent is working on the task

### Test posting a comment back

Inside the k2 container (or verify it works by running the compiled script directly):

```bash
PAPERCLIP_URL=http://paperclip:3100 \
PAPERCLIP_AGENT_JWT_SECRET=<secret> \
PAPERCLIP_AGENT_ID=k2 \
PAPERCLIP_COMPANY_ID=<id> \
  node dist/paperclip-reporter.js test-run-001 TEST-1 "Task received, starting work."
```

Expected: JSON response from Paperclip confirming the comment was created.

## Troubleshooting

### Webhook returns 401

The `Authorization` header Paperclip is sending doesn't match `PAPERCLIP_WEBHOOK_SECRET`. Verify:
1. `PAPERCLIP_WEBHOOK_SECRET` is set correctly in the NanoClaw environment
2. Paperclip is configured to send `Bearer <secret>` (not just the raw secret)

### `PAPERCLIP_GROUP_FOLDER does not match any registered group`

The value of `PAPERCLIP_GROUP_FOLDER` doesn't match any registered group's folder field. Check:
1. `echo $PAPERCLIP_GROUP_FOLDER` — confirm the value
2. Run "list registered groups" from your main group to see folder names
3. The folder must already be registered — use `/setup` or register it manually first

### k2 doesn't respond to the task

1. Confirm the group is registered: check the NanoClaw database or logs for group registration
2. Check k2's group has `requiresTrigger: false` — Paperclip tasks come from `sender: 'paperclip'`, not from a trigger word
3. Verify the webhook port is reachable: `curl http://localhost:3102/api/paperclip/heartbeat`
4. Check logs: `grep -i paperclip logs/nanoclaw.log`

### paperclip-reporter fails with "connection refused"

`PAPERCLIP_URL` inside the container doesn't reach Paperclip. Check:
1. Paperclip is running: `docker ps | grep paperclip`
2. The NanoClaw agent container and Paperclip are on the same Docker network
3. `PAPERCLIP_URL` passthrough is present in `src/container-runner.ts` (Phase 2b)
4. If using `host.docker.internal`, switch to the container name or bridge IP on Linux

### paperclip-reporter fails with JWT error

Paperclip rejected the JWT. Verify:
1. `PAPERCLIP_AGENT_JWT_SECRET` matches the secret configured for this agent in Paperclip
2. `PAPERCLIP_AGENT_ID` matches the agent ID registered in Paperclip
3. `PAPERCLIP_COMPANY_ID` is correct — check Paperclip's admin panel
4. Container clock isn't drifting — JWTs expire after 5 minutes (`exp: iat + 300`)

### Webhook server not starting

Check that at least one of `PAPERCLIP_WEBHOOK_SECRET` or `PAPERCLIP_GROUP_FOLDER` is set — the server only starts when either is present. Check logs on startup for `Paperclip webhook server listening`.

## Removal

To remove the Paperclip integration:

1. Delete `src/paperclip-webhook.ts` and `container/agent-runner/src/paperclip-reporter.ts`
2. Remove the `startPaperclipWebhookServer` import and call block from `src/index.ts`
3. Remove the `PAPERCLIP_URL`, `PAPERCLIP_AGENT_JWT_SECRET`, `PAPERCLIP_AGENT_ID`, and `PAPERCLIP_COMPANY_ID` passthrough blocks from `src/container-runner.ts`
4. Remove `PAPERCLIP_*` variables from `.env` and sync: `cp .env data/env/env`
5. Remove the port mapping from the container template (Unraid) or close the firewall port
6. Rebuild: `npm run build && ./container/build.sh`
7. Restart:
```bash
docker restart NanoClaw  # Unraid/Docker
# macOS: launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux: systemctl --user restart nanoclaw
```
