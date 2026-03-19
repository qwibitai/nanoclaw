---
name: add-github-webhooks
description: Receive GitHub webhook events (issues, pull requests, push) as agent messages. Creates a webhook token, registers it with GitHub repos, and teaches the agent how to parse and respond to events.
---

# Add GitHub Webhooks

This skill connects NanoClaw to GitHub repositories via webhooks. When someone opens an issue, comments, creates a PR, or pushes code, the agent receives it as a message and can act on it.

NanoClaw's webhook server is already running — this skill wires it to GitHub.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `add-github-webhooks` is in `applied_skills`, skip to Phase 4 (Register a Repo). The infrastructure is already in place.

### Check webhook server

The webhook server starts automatically with NanoClaw on port 3333 (configurable via `WEBHOOK_PORT` in `.env`). Confirm it is running:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3333/webhook/test
```

Expected: `401` (server running, invalid token) or `404`. Any response confirms the server is up. If the command hangs or errors, check that NanoClaw is running.

### Ask the user

1. **Which group** should receive GitHub events? (Default: main group)
2. **Do they have a GitHub Personal Access Token** with `admin:repo_hook` scope? This is needed to register webhooks via the API. If no, they can register manually via the GitHub web UI and skip Phase 3.
3. **Public URL** for the webhook: do they have ngrok, a Cloudflare tunnel, or another way to expose port 3333? If not, explain the options and wait.

## Phase 2: Create Webhook Token

Create a webhook token scoped to the group's JID:

```bash
npx tsx scripts/webhook-token.ts create github
```

This prints the token and registers it in `data/webhooks.json`. Save the token — you'll need it for the webhook URL.

The webhook URL will be:

```
https://<public-url>/webhook/<token>
```

Example: `https://abc123.ngrok-free.dev/webhook/8b5aea47-b490-4ecc-b801-5dc63e75d2af`

Show this URL to the user — they need it for manual registration or to confirm the registration script used it correctly.

## Phase 3: Create Helper Scripts

Create a `skills/webhook/` directory in the group folder (e.g., `groups/main/skills/webhook/`).

### parse-github-event.js

Create `groups/main/skills/webhook/parse-github-event.js`. This script takes a raw GitHub webhook payload (JSON string) and returns a human-readable summary. It should handle:

- **issue_comment** (payload has both `comment` and `issue`): extract action, issue number and title, commenter login, comment body (truncated to 300 chars), and comment URL
- **issue** (payload has `issue` but no `comment`): extract action, issue number and title, opener login, body preview, and issue URL; mark as urgent if `action === 'opened'`
- **pull_request** (payload has `pull_request`): extract action, PR number and title, author login, body preview, and PR URL; mark as urgent if action is `opened` or `review_requested`
- **push** (payload has `ref` and `commits`): extract branch name, commit count, first 3 commits (message + author); not urgent
- **ping** (payload has `zen`): return the zen string and hook ID; not urgent
- **unknown**: return raw JSON truncated to 200 chars

The script should accept JSON via `process.argv[2]` or stdin, print the summary, and export `parseGitHubEvent(payload)` for programmatic use.

### github-register.js

Create `groups/main/skills/webhook/github-register.js`. This script registers Orac's webhook with a GitHub repository via the GitHub API. It should:

- Accept `<owner/repo>` as the first argument, optional event names as subsequent args
- Default events: `['issues', 'issue_comment', 'pull_request', 'push']`
- Read the public URL from a local config file (`webhook-config.json` in the same directory)
- Read the webhook token from `data/webhooks.json` (find the entry where `source === 'github'`)
- Read `GITHUB_TOKEN` from `secrets/github.env` or the project `.env`
- POST to `https://api.github.com/repos/<owner/repo>/hooks` with the webhook URL and events
- On success: print the hook ID and save a registration record to `registrations.json` in the same directory
- On failure: print the GitHub API error and exit nonzero

Also create `groups/main/skills/webhook/webhook-config.json`:

```json
{
  "public_base_url": "",
  "comment": "Set public_base_url to the tunnel URL exposing port 3333 (e.g. https://xxxx.ngrok-free.dev). Full webhook URL: {public_base_url}/webhook/{token}"
}
```

Ask the user for their public URL and fill it in.

### registrations.json

Create an empty `groups/main/skills/webhook/registrations.json`:

```json
{}
```

This will be populated by `github-register.js` as repos are registered.

## Phase 4: Update Group Memory

Add a section to the group's `CLAUDE.md` that tells the agent how to handle GitHub webhook events. The section should cover:

1. **Identifying webhook messages**: they arrive with `[WEBHOOK from github]` at the start of the content, followed by the JSON payload.

2. **Parsing them**: run `node skills/webhook/parse-github-event.js '<json>'` to get a human-readable summary.

3. **OKG recording**: if the payload's `sender.login` is not the agent's own GitHub account, record an OKG encounter for that actor via the OKG API.

4. **Event handling priorities**:
   - `issue_comment` → notify the collaborator immediately with summary and URL
   - `issue` opened → notify the collaborator immediately
   - `pull_request` opened or `review_requested` → notify immediately
   - `push` → log silently unless it is a repo being actively tracked
   - `ping` → confirm webhook is live, no notification needed

5. **Registering new repos**: run `node skills/webhook/github-register.js <owner/repo>` to register a webhook with a new repository.

## Phase 5: Register a Repo (Optional)

If the user has a GitHub PAT and wants to register a repo now:

```bash
node groups/main/skills/webhook/github-register.js <owner/repo>
```

Example:

```bash
node groups/main/skills/webhook/github-register.js myorg/my-project
```

If they want to register manually: direct them to their repo's **Settings > Webhooks > Add webhook**, set the Payload URL to the webhook URL from Phase 2, Content type to `application/json`, and select the desired events.

## Phase 6: Record Skill as Applied

Update `.nanoclaw/state.yaml` to record that this skill has been applied:

```bash
npx tsx scripts/apply-skill.ts --record add-github-webhooks
```

If the `--record` flag does not exist, add `add-github-webhooks` to the `applied_skills` list in `.nanoclaw/state.yaml` manually.

## Phase 7: Verify

### Send a test ping

After registering at least one repo, send a ping from GitHub:

> GitHub repo > Settings > Webhooks > select webhook > **Redeliver** (or use the ping button)

The agent should receive a message starting with `[WEBHOOK from github]` and containing `"zen":`.

### Check webhook server logs

```bash
tail -f logs/nanoclaw.log | grep webhook
```

Expected: `Webhook received` log line with `source: github`.

## Troubleshooting

### 401 from webhook server

Token was not created or `data/webhooks.json` was not saved. Re-run Phase 2.

### Webhook events not arriving

1. Confirm the public URL is reachable from the internet: `curl -s https://<public-url>/webhook/test` should return `{"error":"Invalid token"}` (401), confirming the server is reachable.
2. Confirm the tunnel is running and pointed at port 3333.
3. Check GitHub's delivery log: repo > Settings > Webhooks > select webhook > Recent Deliveries.

### Events arriving but not being processed

The group's CLAUDE.md must contain the `[WEBHOOK from github]` handling instructions (Phase 4). Check that they were added correctly.

### Token shows up in data/webhooks.json but the group JID is wrong

Delete the token and recreate: `npx tsx scripts/webhook-token.ts revoke <token>`, then `npx tsx scripts/webhook-token.ts create github`. Confirm the correct group JID is used.
