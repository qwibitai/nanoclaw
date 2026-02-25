# CodeClaw Requirements

Architecture decisions and design rationale.

---

## Why This Exists

A lightweight, secure GitHub coding agent. CodeClaw receives webhook events from your repos, runs Claude agents in isolated containers with the repo checked out, and responds via the GitHub API (comments, reviews, pull requests).

---

## Philosophy

### Small Enough to Understand

The entire codebase should be something you can read and understand. One Node.js process. A handful of source files. No microservices, no message queues, no abstraction layers.

### Security Through True Isolation

Instead of application-level permission systems trying to prevent agents from accessing things, agents run in actual Linux containers. The isolation is at the OS level. Agents can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

### Built for One User

This is working software for personal use on your own repos. You install a GitHub App on the repos you want, and the bot responds when mentioned.

### Customization = Code Changes

No configuration sprawl. If you want different behavior, modify the code. The codebase is small enough that this is safe and practical.

### AI-Native Development

The codebase assumes you have an AI collaborator (Claude Code). It doesn't need to be excessively self-documenting because Claude is always there.

---

## Architecture Decisions

### Webhook-Driven

- GitHub App sends webhook events to CodeClaw's HTTP server
- Events: `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment`
- Signature verification via HMAC-SHA256
- Idempotent processing via `processed_events` table in SQLite
- Bot loop prevention: events from bot accounts are rejected

### Message Routing

- Webhook events are normalized into a common message format
- JID format: `gh:owner/repo` (repo-level), `gh:owner/repo#issue:42` (thread-level)
- Only installed repos are processed
- One group per repo (auto-registered on first event)

### Access Control

- Per-repo configuration via `.github/codeclaw.yml`
- Permission levels checked against GitHub collaborator API
- Configurable minimum permission (default: `triage`)
- Optional external contributor access
- In-memory rate limiting per user per repo

### Repo Checkout

- Repos are cloned/fetched before each agent run
- Checkout mounted at `/workspace/repo` in the container (read-write)
- GitHub installation token passed to container via stdin (never in env vars)
- Agent can push commits, create branches

### Memory System

- **Per-group memory**: Each group (repo) has a folder with its own `CLAUDE.md`
- **Global memory**: `groups/global/CLAUDE.md` is read by all groups
- **Files**: Groups can create/read files in their folder

### Container Isolation

- All agents run inside containers (lightweight Linux VMs)
- Each agent invocation spawns a container with mounted directories
- Containers provide filesystem isolation — agents can only see mounted paths
- Bash access is safe because commands run inside the container, not on the host
- Browser automation via agent-browser with Chromium in the container

### Structured Output

- Agents can produce structured GitHub responses via IPC:
  - `github_comment` — post a comment on an issue/PR
  - `github_review` — submit a pull request review (approve, request changes, comment)
  - `github_create_pr` — create a new pull request
- Plain text output is posted as a comment on the originating thread

### Scheduled Tasks

- Users can schedule recurring or one-time tasks
- Tasks run as full agents in their group's container context
- Schedule types: cron expressions, intervals, or one-time timestamps
- Task runs logged to SQLite with duration and result

### GitHub App Setup

- One-click setup via GitHub App Manifest flow
- Visit `/github/setup` to create the App automatically
- Callback handler exchanges the code for App credentials
- Private key stored at `~/.config/codeclaw/github-app.pem`

---

## Integration Points

### GitHub

- GitHub App for bot identity (JWT auth, installation tokens)
- Octokit for API calls (comments, reviews, PRs, permission checks)
- Webhook signature verification
- Installation token caching with expiry

### Scheduler

- Built-in scheduler runs on the host, spawns containers for task execution
- Custom `codeclaw` MCP server (inside container) provides scheduling tools
- Tools: `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task`, `send_message`
- Tasks stored in SQLite with run history

### Web Access

- Built-in WebSearch and WebFetch tools
- Standard Claude Agent SDK capabilities

### Browser Automation

- agent-browser CLI with Chromium in container
- Snapshot-based interaction with element references
- Screenshots, PDFs, video recording

---

## Deployment

### Fly.io (Recommended)

- `Dockerfile.deploy` builds the host process image
- Agent containers spawned as sibling containers via Docker socket
- Persistent volume at `/data` for SQLite and state
- Auto-stop/auto-start for cost efficiency

### Self-Host

- Single Node.js process
- Docker required for agent containers
- macOS: launchd service (`com.codeclaw`)
- Linux: systemd user service (`codeclaw.service`)

---

## Project Name

**CodeClaw** — A GitHub AI coding agent, forked from NanoClaw.
