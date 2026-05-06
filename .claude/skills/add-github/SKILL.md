---
name: add-github
description: Add GitHub channel integration. Supports two modes: polling (outbound-only, no exposed port) and webhook (real-time, requires an inbound port). PR and issue comment threads as conversations.
---

# Add GitHub Channel

Adds GitHub support so the agent participates in PR and issue comment threads.

Two transport modes are available. **Ask the user which applies to their server before doing anything else** (use AskUserQuestion):

> "Does your server have an inbound port accessible from the public internet — either directly or via a reverse proxy?"
>
> - **Yes — I can expose a port**: webhook mode (real-time, events pushed by GitHub)
> - **No — outbound-only / behind NAT / no reverse proxy**: polling mode (agent polls the GitHub API every 30s)

---

## Prerequisites (both modes)

You need a **dedicated GitHub bot account** (not your personal account). The adapter uses this account to post replies and filters out its own messages to avoid loops. Create a free GitHub account for your bot (e.g. `my-org-bot`), then invite it as a collaborator with write access to the repos you want monitored.

---

## Mode A: Webhook (real-time, inbound port required)

### ⚠️ Security warning — read before proceeding

Present this to the user and ask them to confirm they understand before continuing:

> **Exposing a webhook endpoint carries real security risks. These are not hypothetical:**
>
> - **DDoS / resource exhaustion**: Any IP on the internet can hammer the endpoint with fake POST requests. GitHub does not rate-limit from its side. A flood of requests will consume CPU, memory, and bandwidth.
>
> - **Zero-day exploit in the HTTP stack or adapter**: The listening port is live attack surface. A memory-corruption or parsing bug in Node's HTTP layer, the reverse proxy, or `@chat-adapter/github` could be exploited remotely before a patch is available.
>
> - **Webhook secret compromise**: The HMAC secret protecting the endpoint must be kept confidential. If it leaks (logs, git history, env dump), an attacker can forge arbitrary GitHub events and inject content into your agent's sessions.
>
> - **Supply chain**: `@chat-adapter/github` and its transitive dependencies are code you run on receipt of unauthenticated network traffic. A malicious or compromised package version is directly reachable.
>
> - **Server fingerprinting**: Exposing a port advertises your server's existence and location, making it easier to enumerate other services.
>
> **Mitigations you should have in place:**
> - A reverse proxy (nginx, Caddy) in front of Node — do not expose Node directly
> - Rate limiting at the proxy (e.g. 60 req/min per IP)
> - HMAC signature validation is on by default in the adapter — do not disable it
> - Store the webhook secret in OneCLI, not in `.env` or source
> - Firewall rules restricting which IPs can reach the port (GitHub publishes their IP ranges)
>
> **Polling mode avoids all of these risks entirely.** If you are unsure, choose polling.

Ask the user: "Do you want to continue with webhook mode, or switch to polling?"

If they switch to polling, jump to **Mode B** below. If they confirm webhook, continue.

### Install

NanoClaw doesn't ship channels in trunk. Copy the adapter from the `channels` branch:

#### 1. Fetch the channels branch

```bash
git fetch upstream channels 2>/dev/null || git fetch origin channels
```

#### 2. Copy the adapter

```bash
git show upstream/channels:src/channels/github.ts > src/channels/github.ts 2>/dev/null || \
  git show origin/channels:src/channels/github.ts > src/channels/github.ts
```

#### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './github.js';
```

#### 4. Install the adapter package (pinned)

```bash
pnpm install @chat-adapter/github@4.27.0
```

#### 5. Build

```bash
pnpm run build
```

### Credentials (webhook mode)

#### 1. Create a Personal Access Token for the bot account

Log in as your **bot account**, then:

1. Go to Settings → Developer Settings → Personal Access Tokens → **Fine-grained tokens**
2. Under **Repository access**, choose **Only select repositories** and pick the repos to monitor
   - If you only see a read-only "Public repositories" option, the bot account hasn't been invited to any repos yet. Invite it first, then create the token.
3. Under **Repository permissions**, set **Issues** and **Pull requests** to **Read and write**
4. Copy the token

#### 2. Set up a webhook on each repo

On each repo (logged in as the repo owner/admin):

1. Go to **Settings** → **Webhooks** → **Add webhook**
2. Payload URL: `https://your-domain/webhook/github` (default port 3000)
3. Content type: `application/json`
4. Secret: generate a strong random string — `openssl rand -hex 20`
5. Events: select **Issue comments** and **Pull request review comments**

#### 3. Configure environment

Add to `.env`:

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_WEBHOOK_SECRET=your-webhook-secret
GITHUB_BOT_USERNAME=your-bot-username
```

`GITHUB_BOT_USERNAME` must match the bot account's GitHub username exactly.

---

## Mode B: Polling (outbound-only, no exposed port)

The agent polls the GitHub REST API every 30 seconds for new comments. No inbound connection, no open port, no webhook secret. All traffic is outbound from your server to `api.github.com`.

### Install

#### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/github.ts` exists and contains `GITHUB_REPOS`
- `src/channels/index.ts` contains `import './github.js';`

Otherwise continue. Every step below is safe to re-run.

#### 1. Fetch the channels branch

```bash
git fetch upstream channels 2>/dev/null || git fetch origin channels
```

#### 2. Write the polling adapter

The Chat SDK webhook version from the `channels` branch will not work without an exposed port.
Write `src/channels/github.ts` with this content instead:

```typescript
/**
 * GitHub channel adapter — polling-based.
 * Polls GitHub REST API for new issue/PR comments on a configurable interval.
 * No inbound webhook required — the machine only makes outbound API calls.
 *
 * Env vars:
 *   GITHUB_TOKEN              — Personal Access Token (Issues + PRs read/write)
 *   GITHUB_BOT_USERNAME       — GitHub username of the bot account
 *   GITHUB_REPOS              — comma-separated list of "owner/repo" to monitor
 *   GITHUB_POLL_INTERVAL_MS   — poll interval in ms (default: 30000)
 *
 * platformId  = "github:owner/repo"
 * threadId    = issue or PR number (string)
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

interface GitHubComment {
  id: number;
  body: string;
  user: { login: string };
  created_at: string;
  html_url: string;
  /** e.g. "https://api.github.com/repos/owner/repo/issues/42" */
  issue_url: string;
}

type PollState = Record<string, string>; // repo -> ISO timestamp of last seen comment

const STATE_PATH = path.join(DATA_DIR, 'github-poll-state.json');

function loadState(): PollState {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8')) as PollState;
  } catch {
    return {};
  }
}

function saveState(state: PollState): void {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch (err) {
    log.warn('GitHub: failed to save poll state', { err });
  }
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text;
  }
  return null;
}

function createAdapter(
  token: string,
  botUsername: string,
  repos: string[],
  intervalMs: number,
): ChannelAdapter {
  let channelSetup: ChannelSetup | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let connected = false;
  const state = loadState();

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  async function fetchComments(repo: string, since: string): Promise<GitHubComment[]> {
    const url =
      `https://api.github.com/repos/${repo}/issues/comments` +
      `?since=${encodeURIComponent(since)}&sort=created&direction=asc&per_page=100`;
    const res = await fetch(url, { headers });
    if (res.status === 304) return [];
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json() as Promise<GitHubComment[]>;
  }

  async function pollRepo(repo: string): Promise<void> {
    // On first poll, look back 24h to avoid processing ancient history.
    const since = state[repo] ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const comments = await fetchComments(repo, since);

    const platformId = `github:${repo}`;
    let newest = since;

    for (const comment of comments) {
      // Skip own comments to avoid loops.
      if (comment.user.login.toLowerCase() === botUsername.toLowerCase()) continue;

      const match = /\/issues\/(\d+)$/.exec(comment.issue_url);
      if (!match) continue;
      const threadId = match[1];

      const isMention = comment.body.toLowerCase().includes(`@${botUsername.toLowerCase()}`);

      channelSetup!.onInbound(platformId, threadId, {
        id: `gh-${comment.id}`,
        kind: 'chat',
        content: {
          text: comment.body,
          author: comment.user.login,
          url: comment.html_url,
        },
        timestamp: comment.created_at,
        isMention,
        isGroup: true,
      });

      if (comment.created_at > newest) newest = comment.created_at;
    }

    if (newest !== since) {
      // Advance by 1ms so the next poll's `since` doesn't re-fetch this comment.
      state[repo] = new Date(new Date(newest).getTime() + 1).toISOString();
      saveState(state);
    }
  }

  async function poll(): Promise<void> {
    for (const repo of repos) {
      try {
        await pollRepo(repo);
      } catch (err) {
        log.error('GitHub: poll error', { repo, err });
      }
    }
  }

  return {
    name: 'github-polling',
    channelType: 'github',
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      channelSetup = config;
      connected = true;
      poll().catch((err) => log.error('GitHub: initial poll failed', { err }));
      timer = setInterval(
        () => poll().catch((err) => log.error('GitHub: poll failed', { err })),
        intervalMs,
      );
      log.info('GitHub polling adapter started', { repos, intervalMs });
    },

    async teardown(): Promise<void> {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      connected = false;
    },

    isConnected: () => connected,

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      if (!threadId) return;
      const repo = platformId.replace(/^github:/, '');
      const body = extractText(message);
      if (!body) return;

      const url = `https://api.github.com/repos/${repo}/issues/${threadId}/comments`;
      let res: Response;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        });
      } catch (err) {
        log.error('GitHub: deliver network error', { repo, threadId, err });
        return;
      }

      if (!res.ok) {
        log.error('GitHub: deliver failed', { repo, threadId, status: res.status });
        return;
      }

      const created = (await res.json()) as { id: number };
      return String(created.id);
    },
  };
}

registerChannelAdapter('github', {
  factory: () => {
    const env = readEnvFile([
      'GITHUB_TOKEN',
      'GITHUB_BOT_USERNAME',
      'GITHUB_REPOS',
      'GITHUB_POLL_INTERVAL_MS',
    ]);
    if (!env.GITHUB_TOKEN) return null;
    const repos = (env.GITHUB_REPOS ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (repos.length === 0) {
      log.warn('GitHub: GITHUB_REPOS not set — adapter disabled');
      return null;
    }
    const botUsername = env.GITHUB_BOT_USERNAME ?? '';
    const intervalMs = parseInt(env.GITHUB_POLL_INTERVAL_MS ?? '30000', 10);
    return createAdapter(env.GITHUB_TOKEN, botUsername, repos, intervalMs);
  },
});
```

#### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './github.js';
```

#### 4. Build

```bash
pnpm run build
```

> **Note:** `@chat-adapter/github` is NOT needed for the polling adapter. Do not install it.

### Credentials (polling mode)

#### 1. Create a Personal Access Token for the bot account

Log in as your **bot account**, then:

1. Go to Settings → Developer Settings → Personal Access Tokens → **Fine-grained tokens**
2. Under **Repository access**, choose **Only select repositories** and pick the repos to monitor
   - If you only see a read-only "Public repositories" option, the bot account hasn't been invited to any repos yet. Invite it first, then create the token.
3. Under **Repository permissions**, set **Issues** and **Pull requests** to **Read and write**
4. Copy the token

#### 2. Configure environment

Add to `.env` (host-side only — do NOT put the token in OneCLI for this adapter):

```bash
GITHUB_TOKEN=github_pat_...
GITHUB_BOT_USERNAME=your-bot-username
GITHUB_REPOS=owner/repo1,owner/repo2
# GITHUB_POLL_INTERVAL_MS=30000  # optional, default 30s
```

`GITHUB_BOT_USERNAME` must match the bot account's GitHub username exactly.

---

## Agent git/gh access via OneCLI (both modes)

**Ask the user (AskUserQuestion) before doing anything in this section:**

> "Should the agent container be able to run git operations (clone, push, fetch) and use the `gh` CLI to create PRs, manage branches, etc.? Or does it only need to read and comment on issues and PRs?"
>
> - **Yes — git/gh access**: the GitHub PAT is stored in OneCLI so the container can use it
> - **No — comments only**: the PAT stays in `.env` for the host adapter; skip this section

If the user says **No**, skip this entire section and continue to **Wiring**.

---

### 1. Store in OneCLI vault

Two secrets are needed — one for the GitHub API (`gh` CLI) and one for git over HTTPS:

```bash
# GitHub API (gh CLI uses Bearer auth)
onecli secrets create \
  --name "GitHub PAT (API)" \
  --type generic \
  --value "github_pat_..." \
  --host-pattern "api.github.com" \
  --header-name "Authorization" \
  --value-format "Bearer {value}"

# git over HTTPS (uses Basic auth: base64(username:token))
BASIC=$(echo -n "your-bot-username:github_pat_..." | base64 -w0)
onecli secrets create \
  --name "GitHub PAT (git)" \
  --type generic \
  --value "$BASIC" \
  --host-pattern "github.com" \
  --header-name "Authorization" \
  --value-format "Basic {value}"
```

### 2. Assign to the agent — safe merge (do NOT skip the read step)

`set-secrets` **replaces** the agent's entire secret list. Always read the existing list first and merge, or you will remove credentials the agent already has (e.g. the Anthropic API key).

```bash
# 1. Find the agent ID (identifier = agent group id)
onecli agents list

# 2. Read current secret IDs assigned to this agent
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')

# 3. Find the two new secret IDs
onecli secrets list

# 4. Merge and assign (deduplicates automatically)
NEW="<api-id>,<git-id>"
MERGED=$(printf '%s' "$CURRENT,$NEW" | tr ',' '\n' | sort -u | paste -sd ',')
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"

# 5. Verify
onecli agents secrets --id <agent-id>
```

The OneCLI credential proxy intercepts HTTPS traffic from the container and injects the right `Authorization` header before the request reaches GitHub — so `git`, `gh`, and direct API calls all work without any credential helper configuration.

### 3. Add gh CLI to the container image

In `container/Dockerfile`, add a `GH_VERSION` ARG and install step (after the mnemon block):

```dockerfile
ARG GH_VERSION=2.92.0
RUN ARCH=$(dpkg --print-architecture) && \
    GH_ARCH=$([ "$ARCH" = "arm64" ] && echo "linux_arm64" || echo "linux_amd64") && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_${GH_ARCH}.tar.gz" \
    | tar -xz -C /tmp && \
    install -m 0755 /tmp/gh_${GH_VERSION}_${GH_ARCH}/bin/gh /usr/local/bin/gh && \
    rm -rf /tmp/gh_*
```

Then rebuild: `./container/build.sh`

> **Note:** `git` is already installed in the base image.

---

## Wiring (both modes)

Ask the user: **Is this a private or public repo?**

- **Private repo** — use `unknown_sender_policy: 'public'`. Only collaborators can comment anyway.
- **Public repo** — use `unknown_sender_policy: 'strict'`. Only registered members can trigger the agent.

```sql
-- Create messaging group (one per repo)
INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
VALUES ('mg-github-myrepo', 'github', 'github:owner/repo', 'owner/repo', 1, '<policy>', datetime('now'));

-- Wire to agent group (per-thread so each PR/issue gets its own session)
INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, session_mode, priority, engage_mode, created_at)
VALUES ('mga-github-myrepo', 'mg-github-myrepo', '<your-agent-group-id>', 'per-thread', 10, 'mention', datetime('now'));
```

`engage_mode: 'mention'` means the agent responds only when `@bot-username` appears in a comment.

### Adding members (strict mode only)

When using `strict`, add each GitHub user who should be able to trigger the agent:

```sql
-- Add user (kind = 'github', id = 'github:<numeric-user-id>')
INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
VALUES ('github:<user-id>', 'github', '<username>', datetime('now'));

-- Grant membership to the agent group
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id)
VALUES ('github:<user-id>', '<agent-group-id>');
```

To find a GitHub user's numeric ID:

```bash
gh api users/<username> --jq .id
```

---

## Next Steps

Restart the service to pick up the new channel. Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

---

## Channel Info

- **type**: `github`
- **terminology**: GitHub has "repositories" containing "pull requests" and "issues." Each PR or issue comment thread is a separate conversation.
- **how-to-find-id**: The platform ID is `github:owner/repo` (e.g. `github:acme/backend`). Each PR/issue becomes its own thread automatically.
- **supports-threads**: yes
- **typical-use (polling)**: Checks for new comments every 30s. No open port needed. Up to 30s latency on first response.
- **typical-use (webhook)**: Real-time. Requires an inbound port and carries the security risks documented above.
- **default-isolation**: Use `per-thread` session mode.
