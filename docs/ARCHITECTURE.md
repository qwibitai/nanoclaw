# NanoClaw Architecture

Living architecture documentation. Last updated: March 27, 2026.

---

## System Overview

NanoClaw is a single Node.js process that orchestrates messaging channels, routes messages to Claude agents running in isolated Linux containers, and manages scheduled tasks. Security is achieved through OS-level container isolation, not application-level permissions.

```mermaid
graph TB
    subgraph Channels["Messaging Channels"]
        WA[WhatsApp<br/>Baileys]
        TG[Telegram<br/>Grammy]
        DC[Discord<br/>discord.js]
        SL[Slack<br/>Bolt]
        EM[Emacs<br/>Local dev]
    end

    subgraph Core["NanoClaw Process"]
        CR[Channel Registry]
        ORC[Orchestrator<br/>index.ts]
        DB[(SQLite)]
        GQ[Group Queue]
        RT[Router]
        TS[Task Scheduler]
        IPC[IPC Watcher]
        CP[Credential Proxy]
    end

    subgraph Containers["Isolated Containers"]
        C1[Agent Container 1<br/>Claude SDK]
        C2[Agent Container 2<br/>Claude SDK]
        C3[Agent Container N<br/>Claude SDK]
    end

    subgraph Storage["Filesystem"]
        GF[groups/<br/>Per-group folders]
        GM[global/<br/>Shared memory]
        IPCF[data/ipc/<br/>IPC files]
        SS[data/sessions/<br/>Agent sessions]
    end

    API[Anthropic API]

    Channels --> CR --> ORC
    ORC <--> DB
    ORC --> GQ --> Containers
    ORC --> RT --> Channels
    TS --> GQ
    IPC <--> IPCF
    IPC <--> ORC
    Containers <--> IPCF
    Containers --> CP --> API
    Containers <--> GF
    Containers -.-> GM
    Containers <--> SS
```

---

## Message Flow

From user message to agent response:

```mermaid
sequenceDiagram
    participant U as User
    participant CH as Channel<br/>(WhatsApp/Telegram/etc)
    participant DB as SQLite
    participant ORC as Orchestrator
    participant GQ as Group Queue
    participant CTR as Container
    participant SDK as Claude SDK
    participant RT as Router

    U->>CH: Send message
    CH->>DB: storeMessage()

    loop Every 2s
        ORC->>DB: getNewMessages()
    end

    ORC->>ORC: Check trigger pattern
    ORC->>ORC: Check sender allowlist
    ORC->>GQ: enqueueMessageCheck(groupJid)

    alt No active container
        GQ->>CTR: Spawn container (docker run)
        CTR->>CTR: Shadow .env, compile agent-runner
        CTR->>CTR: Drop privileges
    else Container idle
        GQ->>CTR: Pipe message to stdin
    end

    CTR->>SDK: Query agent with prompt
    SDK-->>CTR: Stream response
    CTR->>ORC: Emit OUTPUT markers
    ORC->>RT: formatOutbound()
    RT->>CH: sendMessage()
    CH->>U: Deliver response
```

---

## Container Lifecycle

Each container runs an isolated Claude agent with its own filesystem, memory, and IPC namespace:

```mermaid
stateDiagram-v2
    [*] --> Queued: enqueueMessageCheck()
    Queued --> Spawning: Slot available<br/>(max 5 concurrent)
    Spawning --> Running: docker run<br/>+ mount volumes
    Running --> Processing: Read stdin<br/>+ query Claude SDK
    Processing --> OutputEmitted: Agent responds<br/>OUTPUT markers
    OutputEmitted --> IdleWaiting: No pending work<br/>Poll IPC /500ms
    IdleWaiting --> Processing: New IPC input<br/>or stdin message
    IdleWaiting --> Closed: Idle timeout (30min)<br/>or _close sentinel
    Processing --> Closed: Agent completes
    Closed --> [*]: Cleanup

    OutputEmitted --> Processing: More results<br/>(agent teams)
    Queued --> Queued: Max containers reached<br/>Wait for slot
```

---

## Container Mount Architecture

```mermaid
graph LR
    subgraph Host["Host Filesystem"]
        PJ[Project Root<br/>read-only, main only]
        GF["groups/{name}/<br/>read-write"]
        GL[global/<br/>read-only]
        IP["data/ipc/{name}/<br/>read-write"]
        SE["data/sessions/{name}/<br/>read-write"]
        AR[container/agent-runner/<br/>read-write]
    end

    subgraph Container["Container"]
        WP["/workspace/project"]
        WG["/workspace/group"]
        WGL["/workspace/global"]
        WIPC["/workspace/ipc"]
        HC["/home/node/.claude"]
        APP["/app/src"]
    end

    PJ -->|mount ro| WP
    GF -->|mount rw| WG
    GL -->|mount ro| WGL
    IP -->|mount rw| WIPC
    SE -->|mount rw| HC
    AR -->|mount rw| APP
```

---

## Credential Security

Secrets never enter containers directly. A proxy intercepts API calls at the network boundary:

```mermaid
sequenceDiagram
    participant CTR as Container<br/>(placeholder key)
    participant CP as Credential Proxy<br/>(host :3001)
    participant API as Anthropic API

    CTR->>CP: POST /v1/messages<br/>x-api-key: placeholder
    CP->>CP: Replace placeholder<br/>with real API key
    CP->>API: POST /v1/messages<br/>x-api-key: sk-ant-...
    API-->>CP: Response
    CP-->>CTR: Response
```

---

## Channel System

Channels self-register at startup via a factory pattern:

```mermaid
graph TB
    subgraph Registry["Channel Registry"]
        RF[registerChannel<br/>name → factory]
    end

    subgraph Factories["Channel Factories"]
        WF["whatsapp → WhatsAppChannel()"]
        TF["telegram → TelegramChannel()"]
        DF["discord → DiscordChannel()"]
        SF["slack → SlackChannel()"]
        EF["emacs → EmacsChannel()"]
    end

    subgraph Interface["Channel Interface"]
        CN[connect]
        SM[sendMessage]
        IC[isConnected]
        OJ[ownsJid]
        DC[disconnect]
        ST[setTyping]
        SG[syncGroups]
    end

    Factories --> Registry
    Registry --> Interface
```

Each channel implements the `Channel` interface and provides two callbacks: `onMessage` for inbound messages and `onChatMetadata` for group discovery.

---

## Scheduled Tasks

```mermaid
sequenceDiagram
    participant SCH as Scheduler<br/>(60s loop)
    participant DB as SQLite
    participant GQ as Group Queue
    participant CTR as Container
    participant IPC as IPC Watcher
    participant CH as Channel

    loop Every 60s
        SCH->>DB: getDueTasks()
        DB-->>SCH: Tasks where next_run <= now
    end

    SCH->>GQ: enqueueTask(groupJid, taskId)
    GQ->>CTR: Spawn container with task prompt
    CTR->>CTR: Execute task

    opt Agent sends message
        CTR->>IPC: Write message JSON
        IPC->>CH: sendMessage(jid, text)
    end

    CTR-->>SCH: Task complete
    SCH->>DB: logTaskRun()
    SCH->>DB: updateTask(next_run)
```

---

## IPC System

Bidirectional communication between host and containers via filesystem:

```mermaid
graph TB
    subgraph Host["Host Process"]
        IW[IPC Watcher<br/>polls 1s]
        ORC[Orchestrator]
    end

    subgraph IPC["data/ipc/{group}/"]
        MSG["messages/<br/>Agent → Host"]
        TSK["tasks/<br/>Agent → Host"]
        INP["input/<br/>Host → Agent"]
        ERR["errors/<br/>Failed files"]
    end

    subgraph Container["Container"]
        AG[Agent Runner]
    end

    AG -->|Write JSON| MSG
    AG -->|Write JSON| TSK
    IW -->|Read + delete| MSG
    IW -->|Read + delete| TSK
    ORC -->|Write JSON| INP
    AG -->|Poll 500ms| INP
    IW -->|Move on error| ERR
```

**Authorization:** Main group can send to any JID and manage any task. Non-main groups are restricted to their own JID and tasks.

---

## Database Schema

```mermaid
erDiagram
    chats {
        text jid PK
        text name
        text channel
        integer is_group
        integer last_sync_timestamp
    }

    messages {
        text id PK
        text chat_jid FK
        text sender
        text content
        integer timestamp
    }

    registered_groups {
        text jid PK
        text config_json
    }

    sessions {
        text group_jid PK
        text session_id
    }

    scheduled_tasks {
        text id PK
        text group_jid FK
        text prompt
        text schedule_type
        text schedule_value
        text status
        integer next_run
    }

    task_run_logs {
        text id PK
        text task_id FK
        integer started_at
        integer duration_ms
        text result
    }

    router_state {
        text key PK
        text value
    }

    chats ||--o{ messages : contains
    registered_groups ||--o{ sessions : has
    scheduled_tasks ||--o{ task_run_logs : generates
```

---

## Key Configuration

| Setting | Default | Purpose |
|---------|---------|---------|
| `ASSISTANT_NAME` | `@Andy` | Trigger word prefix |
| `POLL_INTERVAL` | 2000ms | Message polling frequency |
| `CONTAINER_TIMEOUT` | 1800s | Max container runtime |
| `IDLE_TIMEOUT` | 1800s | Keep idle container alive |
| `MAX_CONCURRENT_CONTAINERS` | 5 | Concurrency limit |
| `IPC_POLL_INTERVAL` | 1000ms | IPC file check frequency |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | Task scheduler check |

---

## File Map

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/db.ts` | SQLite schema and queries |
| `src/container-runner.ts` | Spawn containers with mounts |
| `src/container-runtime.ts` | Runtime abstraction (Apple Container/Docker/Podman) |
| `src/credential-proxy.ts` | Secure credential injection proxy |
| `src/group-queue.ts` | Per-group concurrency control |
| `src/task-scheduler.ts` | Scheduled task execution |
| `src/ipc.ts` | Host-container IPC watcher |
| `src/router.ts` | Message formatting and channel lookup |
| `src/config.ts` | Environment-driven configuration |
| `src/types.ts` | Core interfaces |
| `src/channels/registry.ts` | Channel factory pattern |
| `src/channels/*.ts` | Channel implementations |
| `container/Dockerfile` | Agent container image |
| `container/agent-runner/` | Container entrypoint and agent SDK wrapper |
