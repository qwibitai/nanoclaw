# CodeClaw

A GitHub AI coding agent that responds to issues and pull requests using Claude in isolated containers.

## How It Works

```
GitHub webhook → CodeClaw → Container (Claude Agent SDK) → GitHub API response
```

When someone @mentions your bot in an issue or PR, CodeClaw:

1. Receives the webhook event
2. Checks permissions (configurable per-repo via `.github/codeclaw.yml`)
3. Clones the repo into an isolated container
4. Runs Claude Agent SDK with full access to the codebase
5. Posts comments, reviews, or creates PRs via the GitHub API

Agents run in Linux containers with filesystem isolation. They can only see the repo checkout and explicitly mounted directories.

## Quick Start

```bash
git clone <your-fork-url>
cd codeclaw
npm install
npm run build
./container/build.sh
npm start
```

On first start, CodeClaw launches a setup wizard at `http://localhost:3000/github/setup` to create and install a GitHub App via the manifest flow.

## Deploy to Fly.io

```bash
fly launch
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set GITHUB_APP_ID=...
fly secrets set GITHUB_WEBHOOK_SECRET=...
# Store your GitHub App private key
fly secrets set GITHUB_PRIVATE_KEY="$(cat github-app.pem)"
fly deploy
```

## Self-Host

Requirements:
- Node.js 20+
- Docker (for spawning agent containers)

Set these environment variables:
- `ANTHROPIC_API_KEY` — Claude API key
- `GITHUB_APP_ID` — from your GitHub App
- `GITHUB_WEBHOOK_SECRET` — webhook signature secret
- Store your private key at `~/.config/codeclaw/github-app.pem`

## Per-Repo Configuration

Create `.github/codeclaw.yml` in any repo where your GitHub App is installed:

```yaml
access:
  min_permission: triage    # minimum GitHub permission level to trigger the bot
  allow_external: false     # whether non-collaborators can trigger it
  rate_limit: 10            # max invocations per user per hour
```

Permission levels: `admin` > `maintain` > `write` > `triage` > `read` > `none`

## Architecture

Single Node.js process. Webhook-driven (no polling). Agents execute in isolated Linux containers with filesystem isolation.

Key files:
- `src/index.ts` — Orchestrator: webhook handling, repo checkout, agent invocation
- `src/webhook-server.ts` — HTTP server for GitHub webhooks
- `src/channels/github.ts` — GitHub channel: comments, reviews, PRs via Octokit
- `src/github/auth.ts` — GitHub App JWT auth + installation token caching
- `src/github/event-mapper.ts` — Webhook payload normalization
- `src/github/access-control.ts` — Permission checking + rate limiting
- `src/container-runner.ts` — Spawns agent containers with repo mounts
- `src/ipc.ts` — IPC watcher for structured GitHub responses
- `src/task-scheduler.ts` — Scheduled tasks
- `src/db.ts` — SQLite (messages, groups, processed events)

## License

MIT
