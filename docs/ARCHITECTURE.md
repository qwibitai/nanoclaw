# NanoClaw Architecture

Technical architecture reference for developers.

---

## 1. System Overview

```
 +-------------------------------------------------------------+
 |                     NanoClaw Host Process                    |
 |                     (single Node.js / TS)                    |
 |                                                              |
 |  +------------------+   +------------------+                 |
 |  | Channel Manager  |   |   State (SQLite) |                 |
 |  |                  |   |  - messages       |                 |
 |  |  +-----------+   |   |  - sessions       |                 |
 |  |  | WhatsApp  |   |   |  - groups         |                 |
 |  |  +-----------+   |   |  - router state   |                 |
 |  |  +-----------+   |   +------------------+                 |
 |  |  |   Gmail   |   |                                        |
 |  |  +-----------+   |   +------------------+                 |
 |  |  +-----------+   |   | Credential Proxy |                 |
 |  |  | Google    |   |   | :3001            |                 |
 |  |  |  Chat     |   |   |  /health         |                 |
 |  |  +-----------+   |   |  /metrics         |                 |
 |  |  +-----------+   |   |  API passthrough  |                 |
 |  |  |  Slack    |   |   +--------+---------+                 |
 |  |  +-----------+   |            |                            |
 |  |  +-----------+   |            |  injects credentials       |
 |  |  | Telegram  |   |            v                            |
 |  |  +-----------+   |   +------------------+                 |
 |  +------------------+   | Anthropic API    |                 |
 |                         | api.anthropic.com|                 |
 |  +------------------+   +------------------+                 |
 |  | Message Loop     |                                        |
 |  | (poll + process) |   +------------------+                 |
 |  +------------------+   | Task Scheduler   |                 |
 |                         | (cron tasks)     |                 |
 |  +------------------+   +------------------+                 |
 |  | IPC Watcher      |                                        |
 |  | (file-based IPC) |   +------------------+                 |
 |  +------------------+   | Group Queue      |                 |
 |                         | (concurrency)    |                 |
 +-------------------------------------------------------------+
           |                        |
           v                        v
 +-------------------+    +-------------------+
 | Container 1       |    | Container 2       |
 | (Linux VM/Docker) |    | (Linux VM/Docker) |
 | /workspace/group  |    | /workspace/group  |
 | Claude CLI agent  |    | Claude CLI agent  |
 +-------------------+    +-------------------+
```

**Key files:**
- `src/index.ts` -- orchestrator, wires all subsystems
- `src/channel-manager.ts` -- initializes channels, routes inbound messages
- `src/credential-proxy.ts` -- HTTP proxy on port 3001 (configurable)
- `src/message-loop.ts` -- polls DB for new messages, triggers processing
- `src/message-processor.ts` -- formats messages, spawns container agents
- `src/group-queue.ts` -- concurrency limiter (MAX_CONCURRENT_CONTAINERS)
- `src/container-runner.ts` -- builds CLI args, spawns child process
- `src/ipc.ts` -- watches data/{group}/ipc/ for file-based commands
- `src/task-scheduler.ts` -- cron-based scheduled task runner
- `src/db.ts` -- SQLite via better-sqlite3

---

## 2. Message Flow

```
  User sends message
       |
       v
 +-----------+     onMessage()      +----------------+
 |  Channel  | ------------------->  | Channel Mgr    |
 | (WhatsApp |     (chatJid, msg)   | storeMessage() |
 |  Gmail,   |                      +-------+--------+
 |  Chat...) |                              |
 +-----------+                              v
                                   +--------+--------+
                                   |   SQLite DB     |
                                   |  messages table |
                                   +--------+--------+
                                            |
                                            v
                                   +--------+--------+
                                   |  Message Loop   |
                                   |  (poll every    |
                                   |   2s default)   |
                                   +--------+--------+
                                            |
                                   checks for new messages
                                   since lastAgentTimestamp
                                            |
                                            v
                                   +--------+--------+
                                   |  Group Queue    |
                                   | enqueueMessage  |
                                   |  Check(jid)     |
                                   +--------+--------+
                                            |
                                   waits for concurrency slot
                                   (max 5 containers default)
                                            |
                                            v
                                   +--------+---------+
                                   | Message Processor|
                                   | processGroup     |
                                   |  Messages()      |
                                   +--------+---------+
                                            |
                              formatMessages() -> prompt
                                            |
                                            v
                                   +--------+---------+
                                   | Container Runner |
                                   | runContainerAgent|
                                   +--------+---------+
                                            |
                                   spawn child process
                                   (docker run / container run)
                                            |
                                            v
                               +------------+------------+
                               |    Agent Container      |
                               |  Claude CLI             |
                               |  API via proxy :3001    |
                               |  /workspace/group mount |
                               +------------+------------+
                                            |
                                   streams output (stdout)
                                   parsed as JSON results
                                            |
                                            v
                                   +--------+---------+
                                   | Channel.send     |
                                   |  Message(jid,    |
                                   |   text)          |
                                   +------------------+
```

---

## 3. Container Lifecycle

```
  processGroupMessages()
       |
       v
  runContainerAgent(group, input)
       |
       +-- buildVolumeMounts(group, isMain)
       |     - /workspace/group  -> groups/{folder}  (rw)
       |     - /workspace/data   -> data/{folder}    (rw)
       |     - /workspace/extra/ -> validated mounts  (ro/rw)
       |     - CLAUDE.md, skills -> container/        (ro)
       |
       +-- buildContainerArgs(mounts, containerName)
       |     - --rm, --name, --network none
       |     - --env ANTHROPIC_BASE_URL=http://host:3001
       |     - --env CLAUDE_MODEL, ASSISTANT_NAME, ...
       |     - --add-host host.docker.internal:host-gateway
       |     - volume mount args
       |
       v
  spawn("docker/container", ["run", ...args])
       |
       +-- onProcess(proc, containerName)
       |     registers with GroupQueue for tracking
       |
       +-- stdin.write(prompt)
       |     sends formatted message prompt
       |
       +-- stdout streaming
       |     |
       |     +-- parse JSON lines
       |     |     { result: "...", status: "success"|"error" }
       |     |     { newSessionId: "..." }
       |     |
       |     +-- onOutput callback
       |           sends result to channel
       |           tracks session ID
       |
       +-- idle timeout (30min default)
       |     closes stdin -> agent exits gracefully
       |
       +-- process exit
       |     --rm flag auto-removes container
       |
       v
  GroupQueue: activeCount--, drain next
```

---

## 4. Gmail Webhook Pipeline

```
  Sender
    |
    v
 +--------+        +------------------+       +------------------+
 | Gmail  | -----> | Google Pub/Sub   | ----> | Botti Voice      |
 | inbox  |  push  | gmail-push topic |  push | Cloud Function   |
 +--------+  notif +------------------+       | (webhook recv)   |
                                              +--------+---------+
                                                       |
                                              writes signal doc
                                                       |
                                                       v
                                              +--------+---------+
                                              | Firestore        |
                                              | Collection:      |
                                              | nanoclaw-signals |
                                              | /{instance}/     |
                                              |  gmail-webhook   |
                                              +--------+---------+
                                                       |
                                              polls every 5s
                                              (FIRESTORE_SIGNAL_POLL_MS)
                                                       |
                                                       v
                                              +--------+---------+
                                              | NanoClaw         |
                                              | GmailChannel     |
                                              | pollFirestore()  |
                                              +--------+---------+
                                                       |
                                              gmail.users.messages.list()
                                              gmail.users.messages.get()
                                                       |
                                              +--------+---------+
                                              | isAutomatedEmail |
                                              | filter           |
                                              |  - noreply       |
                                              |  - marketing     |
                                              |  - newsletter    |
                                              +--------+---------+
                                                       |
                                              passes -> onMessage
                                              callback -> DB
                                                       |
                                                       v
                                              (normal message flow)
```

**Fallback:** If no Firestore signal arrives within 5 minutes
(`GMAIL_WEBHOOK_FALLBACK_POLL_MS`), NanoClaw polls Gmail API directly.

---

## 5. Google Chat Pipeline

```
 +-------------+       +-----------------+       +------------------+
 | Google Chat  | ----> | Chat App /      | ----> | Botti Voice      |
 | (user sends  |  HTTP | Gateway         |  fwd  | Cloud Function   |
 |  message)    |       | (GCP project)   |       | (webhook recv)   |
 +-------------+       +-----------------+       +--------+---------+
                                                          |
                                                 writes message doc
                                                          |
                                                          v
                                                 +--------+---------+
                                                 | Firestore        |
                                                 | Collection:      |
                                                 | nanoclaw-messages|
                                                 | /{instance}/     |
                                                 |  google-chat     |
                                                 +--------+---------+
                                                          |
                                                 polls every 5s
                                                 (GOOGLE_CHAT_POLL_MS)
                                                          |
                                                          v
                                                 +--------+---------+
                                                 | NanoClaw         |
                                                 | GoogleChatChannel|
                                                 | pollFirestore()  |
                                                 +--------+---------+
                                                          |
                                                 onMessage -> DB
                                                 -> agent processes
                                                          |
                                                          v
                                                 +--------+---------+
                                                 | Google Chat API  |
                                                 | spaces.messages  |
                                                 |  .create()       |
                                                 +------------------+
```

Cross-posting: When a Google Chat message triggers a response, the reply
is also sent to the WhatsApp group via `lastGchatReplyTarget` tracking.

---

## 6. Security Model

```
 +--------------------------------------------------------------+
 |  HOST                                                         |
 |                                                               |
 |  ~/.config/nanoclaw/                                          |
 |    sender-allowlist.json    (who can trigger the agent)       |
 |    mount-allowlist.json     (what host paths containers see)  |
 |                                                               |
 |  .env                                                         |
 |    ANTHROPIC_API_KEY        (never mounted into containers)   |
 |    CLAUDE_CODE_OAUTH_TOKEN  (never mounted into containers)   |
 |                                                               |
 |  +----------------------------------------------------------+|
 |  | Credential Proxy (:3001, 127.0.0.1 only)                 ||
 |  |                                                           ||
 |  |  - Injects API key / OAuth token into upstream requests   ||
 |  |  - Circuit breaker (5 failures -> open for 60s)           ||
 |  |  - Daily spend limiter (blocks at $DAILY_API_LIMIT_USD)   ||
 |  |  - Containers see ANTHROPIC_BASE_URL=http://host:3001     ||
 |  |    but never the real API key                              ||
 |  +----------------------------------------------------------+||
 |                                                               |
 |  Mount Isolation:                                             |
 |  +----------------------------------------------------------+|
 |  |  Container mounts are validated against mount-allowlist:  ||
 |  |    - allowedRoots: list of host paths + rw/ro flags       ||
 |  |    - blockedPatterns: .ssh, .env, .aws, credentials, etc. ||
 |  |    - nonMainReadOnly: non-main groups forced read-only    ||
 |  |    - Symlink traversal resolved via fs.realpathSync       ||
 |  +----------------------------------------------------------+||
 |                                                               |
 |  Sender Allowlist:                                            |
 |  +----------------------------------------------------------+|
 |  |  Per-chat rules: allow specific senders or '*'            ||
 |  |  Modes: 'trigger' (store but ignore) / 'drop' (discard)  ||
 |  |  Hot-reloaded via 5s cache TTL                            ||
 |  +----------------------------------------------------------+||
 +--------------------------------------------------------------+
           |
           v
 +--------------------------------------------------------------+
 | CONTAINER (Linux VM / Docker)                                 |
 |                                                               |
 |  --network none     (no direct internet access)               |
 |  --rm               (auto-cleanup on exit)                    |
 |                                                               |
 |  Mounts:                                                      |
 |    /workspace/group  -> groups/{folder}/  (read-write)        |
 |    /workspace/data   -> data/{folder}/    (read-write)        |
 |    /workspace/extra/ -> validated paths   (per allowlist)     |
 |    container/        -> skills, CLAUDE.md (read-only)         |
 |                                                               |
 |  Environment:                                                 |
 |    ANTHROPIC_BASE_URL = http://host.docker.internal:3001      |
 |    (API key NOT present -- proxy injects it)                  |
 +--------------------------------------------------------------+
```

---

## 7. Multi-Instance Architecture

Multiple NanoClaw agents share one codebase but run as independent
processes, each with its own configuration, groups, and data.

```
 ~/nanoclaw/              (shared codebase, installed once)
    src/
    container/
    node_modules/

 ~/nanoclaw/data/sessions/
    whatsapp_main/        (instance 1: WhatsApp primary)
       .env               ASSISTANT_NAME=Andy, CREDENTIAL_PROXY_PORT=3001
       store/db.sqlite
       groups/
       data/

    whatsapp_main_2/      (instance 2: WhatsApp secondary)
       .env               ASSISTANT_NAME=Botti, CREDENTIAL_PROXY_PORT=3002
       store/db.sqlite
       groups/
       data/

    gmail_agent/          (instance 3: Gmail-only agent)
       .env               ASSISTANT_NAME=Mailer, CREDENTIAL_PROXY_PORT=3003
       store/db.sqlite
       groups/
       data/

    slack_agent/          (instance 4: Slack-only agent)
       .env               ASSISTANT_NAME=SlackBot, CREDENTIAL_PROXY_PORT=3004
       store/db.sqlite
       groups/
       data/
```

Each instance:
- Runs as a separate OS process (launchd plist or systemd unit)
- Has its own `.env` with unique `CREDENTIAL_PROXY_PORT`
- Has its own SQLite database (`store/db.sqlite`)
- Has its own `groups/` directory for agent filesystem isolation
- Can connect to different channels independently
- Shares the same container image (`nanoclaw-agent:latest`)

**Process management (macOS):**
```
~/Library/LaunchAgents/
  com.nanoclaw.plist                 (instance 1)
  com.nanoclaw-secondary.plist       (instance 2)
  ...
```

**Process management (Linux):**
```
~/.config/systemd/user/
  nanoclaw.service                   (instance 1)
  nanoclaw-secondary.service         (instance 2)
  ...
```
