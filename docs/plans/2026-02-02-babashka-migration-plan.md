# NanoClaw: TypeScript to Babashka Migration Plan

**Date**: 2026-02-02
**Updated**: 2026-02-02 (Telegram replaces WhatsApp)
**Author**: Claude
**Status**: Planning Phase

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current Architecture Overview](#current-architecture-overview)
3. [Data Structures & Interfaces](#data-structures--interfaces)
4. [Function Signatures](#function-signatures)
5. [Library Mapping](#library-mapping)
6. [Migration Strategy](#migration-strategy)
7. [Detailed Component Analysis](#detailed-component-analysis)
8. [Risk Assessment](#risk-assessment)
9. [Recommendations](#recommendations)

---

## Executive Summary

This document outlines a plan to migrate NanoClaw from TypeScript/Node.js to Babashka (Clojure), replacing WhatsApp with Telegram as the messaging platform.

**Key Decision**: Replacing WhatsApp with Telegram dramatically simplifies the migration. Telegram's HTTP-based Bot API can be called directly from Babashka using the built-in `babashka.http-client` - **no hybrid architecture or external runtimes needed**.

### Key Findings

| Component | Migration Path | Difficulty |
|-----------|---------------|------------|
| Telegram Client | babashka.http-client (built-in) | **Low** |
| SQLite Database | pod-babashka-go-sqlite3 | Low |
| Container Runner | babashka.process | Low |
| Task Scheduler | at-at + manual cron parsing | Medium |
| IPC Watcher | pod-babashka-fswatcher | Low |
| JSON Handling | cheshire.core (built-in) | Low |
| Schema Validation | malli | Low |
| MCP Server (container) | clojure-mcp or modex | Medium |

### Architecture: Pure Babashka

```
┌─────────────────────────────────────────────────────────────────────┐
│                    BABASHKA (Single Process)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Telegram Bot API ←──HTTP──→ babashka.http-client                   │
│  SQLite           ←─────────→ pod-babashka-go-sqlite3               │
│  Containers       ←─────────→ babashka.process                      │
│  File Watching    ←─────────→ pod-babashka-fswatcher                │
└─────────────────────────────────────────────────────────────────────┘
```

**No Node.js, no nbb, no hybrid architecture required.**

---

## Current Architecture Overview

### Current (TypeScript + WhatsApp)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                   (Single Node.js Process)                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌────────────────────┐    ┌───────────────┐   │
│  │  WhatsApp    │    │   SQLite Database  │    │  Registered   │   │
│  │  (baileys)   │───▶│   (better-sqlite3) │    │  Groups JSON  │   │
│  └──────────────┘    └─────────┬──────────┘    └───────────────┘   │
│                                │                                    │
│  ┌──────────────────┐  ┌───────┴───────┐  ┌───────────────────┐   │
│  │  Message Loop    │  │  Scheduler    │  │  IPC Watcher      │   │
│  │  (2s polling)    │  │  (60s polling)│  │  (1s file polling)│   │
│  └────────┬─────────┘  └───────┬───────┘  └─────────┬─────────┘   │
│           │                    │                    │              │
│           └────────────────────┴────────────────────┘              │
│                                │                                    │
│                       Container Runner                              │
│                    (spawn Apple Container)                          │
├─────────────────────────────────────────────────────────────────────┤
│                  APPLE CONTAINER (Linux VM)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Runner (Node.js) + Claude Agent SDK + IPC MCP Server        │
└─────────────────────────────────────────────────────────────────────┘
```

### Target (Babashka + Telegram)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                    (Single Babashka Process)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌────────────────────┐    ┌───────────────┐   │
│  │  Telegram    │    │   SQLite Database  │    │  Registered   │   │
│  │  (HTTP API)  │───▶│   (go-sqlite3 pod) │    │  Groups EDN   │   │
│  └──────────────┘    └─────────┬──────────┘    └───────────────┘   │
│                                │                                    │
│  ┌──────────────────┐  ┌───────┴───────┐  ┌───────────────────┐   │
│  │  Long Polling    │  │  Scheduler    │  │  IPC Watcher      │   │
│  │  (30s timeout)   │  │  (at-at pool) │  │  (fswatcher pod)  │   │
│  └────────┬─────────┘  └───────┬───────┘  └─────────┬─────────┘   │
│           │                    │                    │              │
│           └────────────────────┴────────────────────┘              │
│                                │                                    │
│                       Container Runner                              │
│                    (babashka.process)                               │
├─────────────────────────────────────────────────────────────────────┤
│                  APPLE CONTAINER (Linux VM)                         │
├─────────────────────────────────────────────────────────────────────┤
│  Agent Runner (Node.js) + Claude Agent SDK + IPC MCP Server        │
└─────────────────────────────────────────────────────────────────────┘
```

### Source File Inventory

| File | Lines | Purpose |
|------|-------|---------|
| `src/index.ts` | 613 | Main: WhatsApp, routing, IPC |
| `src/container-runner.ts` | 440 | Container orchestration |
| `src/db.ts` | 285 | SQLite operations |
| `src/task-scheduler.ts` | 139 | Scheduler loop |
| `src/mount-security.ts` | 385 | Mount validation |
| `src/config.ts` | 32 | Configuration |
| `src/types.ts` | 80 | TypeScript interfaces |
| `src/utils.ts` | 19 | JSON utilities |
| `container/agent-runner/src/index.ts` | 290 | Container entry point |
| `container/agent-runner/src/ipc-mcp.ts` | 322 | MCP server for IPC |

**Total**: ~2,585 lines of TypeScript

---

## Data Structures & Interfaces

### Core Domain Types

```typescript
// src/types.ts

// Mount configuration for containers
interface AdditionalMount {
  hostPath: string;      // Absolute path on host (supports ~)
  containerPath: string; // Path inside container
  readonly?: boolean;    // Default: true
}

// Security allowlist (external config)
interface MountAllowlist {
  allowedRoots: AllowedRoot[];
  blockedPatterns: string[];
  nonMainReadOnly: boolean;
}

interface AllowedRoot {
  path: string;
  allowReadWrite: boolean;
  description?: string;
}

// Per-group container configuration
interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number;
  env?: Record<string, string>;
}

// Registered chat/group (WhatsApp → Telegram)
interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
}

// Session mapping (group folder -> session ID)
interface Session {
  [folder: string]: string;
}

// Message from database
interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
}

// Scheduled task
interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

// Task execution log
interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}
```

### Clojure Equivalents (using Malli)

```clojure
(ns nanoclaw.schemas
  (:require [malli.core :as m]))

;; Mount configuration
(def AdditionalMount
  [:map
   [:host-path :string]
   [:container-path :string]
   [:readonly {:optional true :default true} :boolean]])

(def AllowedRoot
  [:map
   [:path :string]
   [:allow-read-write :boolean]
   [:description {:optional true} :string]])

(def MountAllowlist
  [:map
   [:allowed-roots [:vector AllowedRoot]]
   [:blocked-patterns [:vector :string]]
   [:non-main-read-only :boolean]])

(def ContainerConfig
  [:map
   [:additional-mounts {:optional true} [:vector AdditionalMount]]
   [:timeout {:optional true} :int]
   [:env {:optional true} [:map-of :string :string]]])

(def RegisteredGroup
  [:map
   [:name :string]
   [:folder :string]
   [:trigger :string]
   [:added-at :string]
   [:container-config {:optional true} ContainerConfig]])

(def NewMessage
  [:map
   [:id :string]
   [:chat-jid :string]
   [:sender :string]
   [:sender-name :string]
   [:content :string]
   [:timestamp :string]])

(def ScheduleType [:enum "cron" "interval" "once"])
(def ContextMode [:enum "group" "isolated"])
(def TaskStatus [:enum "active" "paused" "completed"])

(def ScheduledTask
  [:map
   [:id :string]
   [:group-folder :string]
   [:chat-jid :string]
   [:prompt :string]
   [:schedule-type ScheduleType]
   [:schedule-value :string]
   [:context-mode ContextMode]
   [:next-run [:maybe :string]]
   [:last-run [:maybe :string]]
   [:last-result [:maybe :string]]
   [:status TaskStatus]
   [:created-at :string]])

(def TaskRunLog
  [:map
   [:task-id :string]
   [:run-at :string]
   [:duration-ms :int]
   [:status [:enum "success" "error"]]
   [:result [:maybe :string]]
   [:error [:maybe :string]]])
```

### Container I/O Types

```typescript
// container-runner.ts

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}
```

```clojure
;; Clojure equivalents
(def ContainerInput
  [:map
   [:prompt :string]
   [:session-id {:optional true} :string]
   [:group-folder :string]
   [:chat-jid :string]
   [:is-main :boolean]
   [:is-scheduled-task {:optional true} :boolean]])

(def ContainerOutput
  [:map
   [:status [:enum "success" "error"]]
   [:result [:maybe :string]]
   [:new-session-id {:optional true} :string]
   [:error {:optional true} :string]])

(def VolumeMount
  [:map
   [:host-path :string]
   [:container-path :string]
   [:readonly {:optional true} :boolean]])

(def AvailableGroup
  [:map
   [:jid :string]
   [:name :string]
   [:last-activity :string]
   [:is-registered :boolean]])
```

### Database Schema

```sql
-- SQLite Tables

CREATE TABLE chats (
  jid TEXT PRIMARY KEY,
  name TEXT,
  last_message_time TEXT
);

CREATE TABLE messages (
  id TEXT,
  chat_jid TEXT,
  sender TEXT,
  sender_name TEXT,
  content TEXT,
  timestamp TEXT,
  is_from_me INTEGER,
  PRIMARY KEY (id, chat_jid),
  FOREIGN KEY (chat_jid) REFERENCES chats(jid)
);

CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_type TEXT NOT NULL,
  schedule_value TEXT NOT NULL,
  context_mode TEXT DEFAULT 'isolated',
  next_run TEXT,
  last_run TEXT,
  last_result TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
```

---

## Function Signatures

### Host Application (src/)

#### config.ts
```typescript
// Constants (no functions)
const ASSISTANT_NAME: string
const POLL_INTERVAL: number         // 2000ms
const SCHEDULER_POLL_INTERVAL: number  // 60000ms
const MOUNT_ALLOWLIST_PATH: string
const STORE_DIR: string
const GROUPS_DIR: string
const DATA_DIR: string
const MAIN_GROUP_FOLDER: string     // "main"
const CONTAINER_IMAGE: string
const CONTAINER_TIMEOUT: number     // 300000ms
const CONTAINER_MAX_OUTPUT_SIZE: number  // 10MB
const IPC_POLL_INTERVAL: number     // 1000ms
const TRIGGER_PATTERN: RegExp
const TIMEZONE: string
```

#### utils.ts
```typescript
function loadJson<T>(filePath: string, defaultValue: T): T
function saveJson(filePath: string, data: unknown): void
```

#### db.ts
```typescript
// Initialization
function initDatabase(): void

// Chat operations
function storeChatMetadata(chatJid: string, timestamp: string, name?: string): void
function updateChatName(chatJid: string, name: string): void
function getAllChats(): ChatInfo[]
function getLastGroupSync(): string | null
function setLastGroupSync(): void

// Message operations
function storeMessage(msg: proto.IWebMessageInfo, chatJid: string, isFromMe: boolean, pushName?: string): void
function getNewMessages(jids: string[], lastTimestamp: string, botPrefix: string): { messages: NewMessage[]; newTimestamp: string }
function getMessagesSince(chatJid: string, sinceTimestamp: string, botPrefix: string): NewMessage[]

// Task operations
function createTask(task: Omit<ScheduledTask, 'last_run' | 'last_result'>): void
function getTaskById(id: string): ScheduledTask | undefined
function getTasksForGroup(groupFolder: string): ScheduledTask[]
function getAllTasks(): ScheduledTask[]
function updateTask(id: string, updates: Partial<Pick<ScheduledTask, ...>>): void
function deleteTask(id: string): void
function getDueTasks(): ScheduledTask[]
function updateTaskAfterRun(id: string, nextRun: string | null, lastResult: string): void
function logTaskRun(log: TaskRunLog): void
function getTaskRunLogs(taskId: string, limit?: number): TaskRunLog[]
```

#### mount-security.ts
```typescript
function loadMountAllowlist(): MountAllowlist | null
function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult
function validateAdditionalMounts(mounts: AdditionalMount[], groupName: string, isMain: boolean): ValidatedMount[]
function generateAllowlistTemplate(): string
```

#### container-runner.ts
```typescript
function runContainerAgent(group: RegisteredGroup, input: ContainerInput): Promise<ContainerOutput>
function writeTasksSnapshot(groupFolder: string, isMain: boolean, tasks: TaskSnapshot[]): void
function writeGroupsSnapshot(groupFolder: string, isMain: boolean, groups: AvailableGroup[], registeredJids: Set<string>): void
```

#### task-scheduler.ts
```typescript
interface SchedulerDependencies {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
}

function startSchedulerLoop(deps: SchedulerDependencies): void
```

#### index.ts (Main Application)
```typescript
// Internal functions
async function setTyping(jid: string, isTyping: boolean): Promise<void>
function loadState(): void
function saveState(): void
function registerGroup(jid: string, group: RegisteredGroup): void
async function syncGroupMetadata(force?: boolean): Promise<void>
function getAvailableGroups(): AvailableGroup[]
async function processMessage(msg: NewMessage): Promise<void>
async function runAgent(group: RegisteredGroup, prompt: string, chatJid: string): Promise<string | null>
async function sendMessage(jid: string, text: string): Promise<void>
function startIpcWatcher(): void
async function processTaskIpc(data: IpcTaskData, sourceGroup: string, isMain: boolean): Promise<void>
async function connectWhatsApp(): Promise<void>
async function startMessageLoop(): Promise<void>
function ensureContainerSystemRunning(): void
async function main(): Promise<void>
```

### Container Application (container/agent-runner/)

#### index.ts
```typescript
async function readStdin(): Promise<string>
function writeOutput(output: ContainerOutput): void
function log(message: string): void
function getSessionSummary(sessionId: string, transcriptPath: string): string | null
function createPreCompactHook(): HookCallback
function sanitizeFilename(summary: string): string
function generateFallbackName(): string
function parseTranscript(content: string): ParsedMessage[]
function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string
async function main(): Promise<void>
```

#### ipc-mcp.ts
```typescript
interface IpcMcpContext {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

function writeIpcFile(dir: string, data: object): string
function createIpcMcp(ctx: IpcMcpContext): McpServer

// MCP Tools:
// - send_message(text: string)
// - schedule_task(prompt, schedule_type, schedule_value, context_mode?, target_group?)
// - list_tasks()
// - pause_task(task_id)
// - resume_task(task_id)
// - cancel_task(task_id)
// - register_group(jid, name, folder, trigger)
```

---

## Library Mapping

### Direct Replacements (Available in Babashka)

| TypeScript | Babashka | Notes |
|------------|----------|-------|
| `better-sqlite3` | `pod-babashka-go-sqlite3` | Babashka pod, synchronous API |
| `zod` | `malli` | Built-in to bb, more powerful |
| `pino` | `taoensso.timbre` | Built-in logging |
| `fs` | `babashka.fs` | Built-in, cross-platform |
| `path` | `babashka.fs` | Path operations included |
| `child_process` | `babashka.process` | Built-in, excellent API |
| JSON parsing | `cheshire.core` | Built-in |

### Requires Additional Work

| TypeScript | Babashka Approach | Complexity |
|------------|-------------------|------------|
| `@whiskeysockets/baileys` | **REPLACED**: Telegram Bot API via `babashka.http-client` | **Low** |
| `cron-parser` | Manual impl OR `at-at` for scheduling | Medium |
| `@anthropic-ai/claude-agent-sdk` | Keep as subprocess (Node.js) | Medium |
| MCP Server creation | `modex`, `mcp-clj`, or manual impl | Medium |

### Telegram Bot API (NEW)

The Telegram Bot API is HTTP/JSON-based and works perfectly with Babashka's built-in HTTP client.

```clojure
(require '[babashka.http-client :as http]
         '[cheshire.core :as json])

(def token (System/getenv "TELEGRAM_BOT_TOKEN"))
(def base-url (str "https://api.telegram.org/bot" token))

;; Send a message
(defn send-message [chat-id text]
  (-> (http/post (str base-url "/sendMessage")
        {:headers {"Content-Type" "application/json"}
         :body (json/generate-string {:chat_id chat-id :text text})})
      :body
      (json/parse-string true)))

;; Long polling for updates (30 second timeout)
(defn get-updates [offset]
  (-> (http/get (str base-url "/getUpdates")
        {:query-params {:offset offset :timeout 30}})
      :body
      (json/parse-string true)))

;; Typing indicator
(defn send-typing [chat-id]
  (http/post (str base-url "/sendChatAction")
    {:headers {"Content-Type" "application/json"}
     :body (json/generate-string {:chat_id chat-id :action "typing"})}))

;; Message reactions (Bot API 7.0+)
(defn set-reaction [chat-id message-id emoji]
  (http/post (str base-url "/setMessageReaction")
    {:headers {"Content-Type" "application/json"}
     :body (json/generate-string
             {:chat_id chat-id
              :message_id message-id
              :reaction [{:type "emoji" :emoji emoji}]})}))
```

**Features supported via direct HTTP**:
- ✅ Send/receive messages
- ✅ Group chat support (chat_id works for groups)
- ✅ Typing indicators (`sendChatAction`)
- ✅ Message reactions (`setMessageReaction`)
- ✅ Long polling (no webhooks needed)

### Library Details

#### SQLite: pod-babashka-go-sqlite3

```clojure
(require '[babashka.pods :as pods])
(pods/load-pod 'org.babashka/go-sqlite3 "0.3.13")
(require '[pod.babashka.go-sqlite3 :as sqlite])

;; Execute DDL
(sqlite/execute! db-path ["CREATE TABLE IF NOT EXISTS chats ..."])

;; Query
(sqlite/query db-path ["SELECT * FROM messages WHERE chat_jid = ?" jid])

;; Insert
(sqlite/execute! db-path ["INSERT INTO messages VALUES (?, ?, ?)" id jid content])
```

#### Process Management: babashka.process

```clojure
(require '[babashka.process :refer [process shell]]
         '[clojure.java.io :as io])

;; Spawn container with stdin/stdout pipes
(def container
  (process ["container" "run" "-i" "--rm" "-v" mount image]
           {:in :pipe :out :pipe :err :inherit}))

;; Write JSON to stdin
(let [stdin (io/writer (:in container))]
  (.write stdin (cheshire/generate-string input))
  (.close stdin))

;; Read JSON from stdout
(with-open [rdr (io/reader (:out container))]
  (-> (slurp rdr)
      (extract-json-between-markers)
      (cheshire/parse-string true)))

;; Wait with timeout
(deref container timeout-ms :timeout)
```

#### File System Watching: pod-babashka-fswatcher

```clojure
(require '[babashka.pods :as pods])
(pods/load-pod 'org.babashka/fswatcher "0.0.5")
(require '[pod.babashka.fswatcher :as fw])

(fw/watch ipc-dir
  (fn [{:keys [type path]}]
    (when (and (= type :create) (str/ends-with? path ".json"))
      (process-ipc-file path)))
  {:recursive true})
```

#### Validation: Malli

```clojure
(require '[malli.core :as m]
         '[malli.error :as me])

(def Message
  [:map
   [:id :string]
   [:content :string]
   [:timestamp :string]])

(m/validate Message data)  ; => true/false
(me/humanize (m/explain Message bad-data))  ; => error messages
```

#### Scheduling: at-at + manual cron

```clojure
(require '[overtone.at-at :as at])

(def scheduler-pool (at/mk-pool))

;; Run every 60 seconds
(at/every 60000 check-due-tasks scheduler-pool)

;; Run once at specific time
(at/at (-> target-time .toInstant .toEpochMilli)
       run-task
       scheduler-pool)
```

For cron parsing, a simple implementation:

```clojure
(defn parse-cron [expr]
  ;; "0 9 * * 1" -> {:minute 0 :hour 9 :day-of-week 1}
  (let [[min hour dom month dow] (str/split expr #"\s+")]
    {:minute (parse-field min)
     :hour (parse-field hour)
     :day-of-month (parse-field dom)
     :month (parse-field month)
     :day-of-week (parse-field dow)}))

(defn next-cron-time [cron-map from-time]
  ;; Calculate next execution time using java.time
  ...)
```

---

## Migration Strategy

### Recommended Approach: Pure Babashka

With Telegram replacing WhatsApp, we can use a **pure Babashka architecture**. No hybrid systems, no nbb, no subprocess bridges needed.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        HOST (macOS)                                  │
│                    (Single Babashka Process)                        │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │           BABASHKA (bb src/nanoclaw/core.clj)                 │  │
│  │                                                                │  │
│  │  • Telegram Bot API (babashka.http-client)                    │  │
│  │  • SQLite database (pod-babashka-go-sqlite3)                  │  │
│  │  • Task scheduling (at-at)                                     │  │
│  │  • Container spawning (babashka.process)                       │  │
│  │  • IPC file watching (pod-babashka-fswatcher)                 │  │
│  │  • Mount security validation                                   │  │
│  │  • State management                                           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Migration Phases

#### Phase 1: Core Infrastructure (Week 1)

**Goal**: Set up Babashka project structure and migrate stateless components.

1. **Project Setup**
   ```
   nanoclaw/
   ├── bb.edn                 # Babashka config, pods, deps
   ├── src/
   │   └── nanoclaw/
   │       ├── core.clj       # Main entry point
   │       ├── config.clj     # Configuration
   │       ├── schemas.clj    # Malli schemas
   │       ├── db.clj         # SQLite operations
   │       ├── telegram.clj   # Telegram Bot API client
   │       ├── container.clj  # Container runner
   │       ├── scheduler.clj  # Task scheduler
   │       ├── ipc.clj        # IPC watcher
   │       ├── mount_security.clj
   │       └── utils.clj
   └── test/
   ```

2. **Migrate**:
   - `config.ts` → `config.clj`
   - `types.ts` → `schemas.clj` (Malli)
   - `utils.ts` → `utils.clj`
   - `db.ts` → `db.clj` (pod-babashka-go-sqlite3)
   - `mount-security.ts` → `mount_security.clj`

**Deliverable**: Database operations working, all schemas defined.

#### Phase 2: Telegram Client (Week 2)

**Goal**: Implement Telegram Bot API client.

1. **Create** `telegram.clj`:
   ```clojure
   (ns nanoclaw.telegram
     (:require [babashka.http-client :as http]
               [cheshire.core :as json]
               [nanoclaw.config :as config]))

   ;; Core API functions
   (defn send-message [chat-id text] ...)
   (defn get-updates [offset] ...)
   (defn send-typing [chat-id] ...)

   ;; Long-polling loop
   (defn start-polling [handler] ...)
   ```

2. **Test**: Send/receive messages, typing indicators.

**Deliverable**: Can send/receive Telegram messages.

#### Phase 3: Container Management (Week 3)

**Goal**: Migrate container spawning and IPC.

1. **Migrate**:
   - `container-runner.ts` → `container.clj`
   - IPC watcher → `ipc.clj` (using fswatcher pod)

2. **Test**: Spawn containers, handle stdin/stdout, parse output.

**Deliverable**: Can run agent containers from Babashka.

#### Phase 4: Scheduler & Main Loop (Week 4)

**Goal**: Complete the migration.

1. **Migrate**:
   - `task-scheduler.ts` → `scheduler.clj`
   - `index.ts` main loop → `core.clj`

2. **Integration testing**: End-to-end message flow.

**Deliverable**: Fully functional Babashka-based NanoClaw.

#### Phase 5: Container Agent (Optional)

**Goal**: Migrate container-side code.

**Note**: This is optional. The container agent can remain in TypeScript since it runs in isolation and the Claude Agent SDK is Node.js-based.

If migrating:
1. Use nbb inside container for ClojureScript
2. Implement MCP server using `modex` or `mcp-clj`

---

## Detailed Component Analysis

### Component: Telegram Client (LOW RISK - Replaces WhatsApp)

**Current**: `@whiskeysockets/baileys` - Pure JavaScript WebSocket implementation for WhatsApp.

**Migration**: Telegram Bot API via `babashka.http-client` - **Direct HTTP calls, no libraries needed.**

**Why Telegram is easier**:
- HTTP/JSON API (no WebSocket protocol to implement)
- Official, documented, stable API
- Long polling works without webhooks
- No authentication complexity (just a bot token)

```clojure
;; telegram.clj - Full implementation
(ns nanoclaw.telegram
  (:require [babashka.http-client :as http]
            [cheshire.core :as json]
            [taoensso.timbre :as log]))

(def token (System/getenv "TELEGRAM_BOT_TOKEN"))
(def base-url (str "https://api.telegram.org/bot" token))

(defn api-call [method params]
  (let [response (http/post (str base-url "/" method)
                   {:headers {"Content-Type" "application/json"}
                    :body (json/generate-string params)
                    :throw false})]
    (-> response :body (json/parse-string true))))

(defn send-message [chat-id text]
  (api-call "sendMessage" {:chat_id chat-id :text text}))

(defn send-typing [chat-id]
  (api-call "sendChatAction" {:chat_id chat-id :action "typing"}))

(defn get-updates
  "Long polling with 30 second timeout"
  [offset]
  (let [response (http/get (str base-url "/getUpdates")
                   {:query-params (cond-> {:timeout 30}
                                    offset (assoc :offset offset))
                    :timeout 35000  ; slightly longer than API timeout
                    :throw false})]
    (-> response :body (json/parse-string true))))

(defn extract-message [update]
  (when-let [msg (:message update)]
    {:update-id (:update_id update)
     :chat-id (get-in msg [:chat :id])
     :chat-type (get-in msg [:chat :type])
     :chat-title (get-in msg [:chat :title])
     :from-id (get-in msg [:from :id])
     :from-name (or (get-in msg [:from :first_name])
                    (get-in msg [:from :username]))
     :text (:text msg)
     :message-id (:message_id msg)
     :timestamp (:date msg)}))

(defn start-polling
  "Start long-polling loop. Calls handler for each message."
  [handler]
  (log/info "Starting Telegram long-polling")
  (loop [offset nil]
    (let [{:keys [ok result]} (get-updates offset)]
      (when ok
        (doseq [update result]
          (when-let [msg (extract-message update)]
            (try
              (handler msg)
              (catch Exception e
                (log/error "Error handling message" {:error (.getMessage e)})))))
        (recur (when (seq result)
                 (inc (:update_id (last result)))))))))
```

**Comparison**:

| Aspect | WhatsApp (baileys) | Telegram Bot API |
|--------|-------------------|------------------|
| Protocol | WebSocket + custom | HTTP/JSON |
| Auth | QR code scan | Bot token (string) |
| Library needed | Yes (baileys) | No (just HTTP) |
| Babashka support | None | Native |
| Complexity | High | Low |

### Component: Database (LOW RISK)

**Current**: `better-sqlite3` - Synchronous SQLite bindings.

**Migration**: `pod-babashka-go-sqlite3` - Direct replacement.

```clojure
;; db.clj
(ns nanoclaw.db
  (:require [babashka.pods :as pods]
            [pod.babashka.go-sqlite3 :as sqlite]
            [nanoclaw.config :as config]))

(defn init-database []
  (sqlite/execute! config/db-path
    ["CREATE TABLE IF NOT EXISTS chats (
       jid TEXT PRIMARY KEY,
       name TEXT,
       last_message_time TEXT
     )"]))

(defn store-message [{:keys [id chat-jid sender content timestamp is-from-me]}]
  (sqlite/execute! config/db-path
    ["INSERT OR REPLACE INTO messages VALUES (?, ?, ?, ?, ?, ?)"
     id chat-jid sender content timestamp (if is-from-me 1 0)]))

(defn get-new-messages [jids last-timestamp bot-prefix]
  (when (seq jids)
    (let [placeholders (str/join "," (repeat (count jids) "?"))
          sql (str "SELECT * FROM messages WHERE timestamp > ? "
                   "AND chat_jid IN (" placeholders ") "
                   "AND content NOT LIKE ? ORDER BY timestamp")]
      (sqlite/query config/db-path
        (into [sql last-timestamp] (conj (vec jids) (str bot-prefix ":%")))))))
```

### Component: Container Runner (MEDIUM RISK)

**Current**: `child_process.spawn` with stdin/stdout pipes.

**Migration**: `babashka.process` - Excellent API, well-documented.

```clojure
;; container.clj
(ns nanoclaw.container
  (:require [babashka.process :as p]
            [cheshire.core :as json]
            [clojure.java.io :as io]
            [nanoclaw.config :as config]))

(def output-start-marker "---NANOCLAW_OUTPUT_START---")
(def output-end-marker "---NANOCLAW_OUTPUT_END---")

(defn build-container-args [mounts]
  (into ["container" "run" "-i" "--rm"]
        (mapcat (fn [{:keys [host-path container-path readonly]}]
                  (if readonly
                    ["--mount" (format "type=bind,source=%s,target=%s,readonly"
                                       host-path container-path)]
                    ["-v" (format "%s:%s" host-path container-path)]))
                mounts)))

(defn run-container-agent [group input]
  (let [mounts (build-volume-mounts group (:is-main input))
        args (conj (build-container-args mounts) config/container-image)
        proc (p/process args {:in :pipe :out :pipe :err :inherit})
        start-time (System/currentTimeMillis)]

    ;; Write input to stdin
    (with-open [w (io/writer (:in proc))]
      (.write w (json/generate-string input))
      (.flush w))

    ;; Wait with timeout
    (let [result (deref proc (:timeout config/container-config config/default-timeout) :timeout)]
      (if (= result :timeout)
        {:status "error" :error "Container timed out"}
        (let [stdout (slurp (:out proc))
              json-str (extract-between-markers stdout output-start-marker output-end-marker)]
          (json/parse-string json-str true))))))

(defn extract-between-markers [s start end]
  (let [start-idx (str/index-of s start)
        end-idx (str/index-of s end)]
    (when (and start-idx end-idx (< start-idx end-idx))
      (subs s (+ start-idx (count start)) end-idx))))
```

### Component: Task Scheduler (LOW-MEDIUM RISK)

**Current**: `setTimeout` loop with `cron-parser`.

**Migration**: `at-at` for scheduling, manual cron parsing.

```clojure
;; scheduler.clj
(ns nanoclaw.scheduler
  (:require [overtone.at-at :as at]
            [nanoclaw.db :as db]
            [nanoclaw.container :as container]
            [taoensso.timbre :as log])
  (:import [java.time LocalDateTime ZonedDateTime ZoneId]
           [java.time.format DateTimeFormatter]))

(def pool (at/mk-pool))

(defn parse-cron-field [field]
  (cond
    (= field "*") :any
    (str/starts-with? field "*/") {:every (parse-long (subs field 2))}
    :else (parse-long field)))

(defn parse-cron [expr]
  (let [[min hour dom month dow] (str/split expr #"\s+")]
    {:minute (parse-cron-field min)
     :hour (parse-cron-field hour)
     :day-of-month (parse-cron-field dom)
     :month (parse-cron-field month)
     :day-of-week (parse-cron-field dow)}))

(defn next-cron-time [cron-map from]
  ;; Implementation using java.time
  ...)

(defn run-task [task deps]
  (log/info "Running task" {:id (:id task)})
  (let [start (System/currentTimeMillis)
        group (get ((:registered-groups deps)) (:chat-jid task))
        result (container/run-container-agent group
                 {:prompt (:prompt task)
                  :group-folder (:group-folder task)
                  :chat-jid (:chat-jid task)
                  :is-main (= (:group-folder task) "main")
                  :is-scheduled-task true})]
    (db/log-task-run
      {:task-id (:id task)
       :run-at (java.time.Instant/now)
       :duration-ms (- (System/currentTimeMillis) start)
       :status (if (= (:status result) "success") "success" "error")
       :result (:result result)
       :error (:error result)})))

(defn check-due-tasks [deps]
  (doseq [task (db/get-due-tasks)]
    (run-task task deps)))

(defn start-scheduler-loop [deps]
  (log/info "Starting scheduler")
  (at/every 60000 #(check-due-tasks deps) pool))
```

### Component: IPC Watcher (LOW RISK)

**Current**: `fs.readdirSync` polling loop.

**Migration**: `pod-babashka-fswatcher` for event-based watching.

```clojure
;; ipc.clj
(ns nanoclaw.ipc
  (:require [babashka.pods :as pods]
            [pod.babashka.fswatcher :as fw]
            [babashka.fs :as fs]
            [cheshire.core :as json]
            [taoensso.timbre :as log]))

(defn process-ipc-file [path source-group is-main handlers]
  (try
    (let [data (json/parse-string (slurp path) true)]
      (case (:type data)
        "message" ((:on-message handlers) data source-group is-main)
        "schedule_task" ((:on-schedule handlers) data source-group is-main)
        "pause_task" ((:on-pause handlers) data source-group is-main)
        "resume_task" ((:on-resume handlers) data source-group is-main)
        "cancel_task" ((:on-cancel handlers) data source-group is-main)
        "register_group" ((:on-register handlers) data source-group is-main)
        (log/warn "Unknown IPC type" {:type (:type data)}))
      (fs/delete path))
    (catch Exception e
      (log/error "IPC processing error" {:path path :error (.getMessage e)})
      (fs/move path (fs/path (fs/parent path) ".." "errors" (fs/file-name path))))))

(defn start-ipc-watcher [ipc-base-dir handlers]
  (fw/watch ipc-base-dir
    (fn [{:keys [type path]}]
      (when (and (= type :create)
                 (str/ends-with? (str path) ".json"))
        (let [parts (str/split (str path) #"/")
              source-group (nth parts (- (count parts) 3))
              is-main (= source-group "main")]
          (process-ipc-file path source-group is-main handlers))))
    {:recursive true})
  (log/info "IPC watcher started"))
```

---

## Risk Assessment

### High Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Claude Agent SDK changes | Container agent breaks | Keep container in TypeScript |

### Medium Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Cron parsing edge cases | Missed scheduled tasks | Port comprehensive tests |
| Process management complexity | Orphaned processes | Proper cleanup, process groups |
| State serialization differences | Data corruption | Version state files, migration |
| Telegram API rate limits | Messages blocked | Implement backoff, queue messages |

### Low Risk

| Risk | Impact | Mitigation |
|------|--------|------------|
| Telegram API connectivity | HTTP calls fail | Built-in retry, error handling |
| SQLite API differences | Query failures | pod has similar API |
| JSON parsing differences | Parse errors | cheshire handles edge cases |
| Logging format changes | Log analysis breaks | Use structured logging |

### Eliminated Risks (WhatsApp → Telegram)

The following risks from the original plan are **no longer applicable**:

| Eliminated Risk | Why |
|-----------------|-----|
| WhatsApp library compatibility | Telegram uses simple HTTP API |
| Hybrid architecture complexity | Pure Babashka, single runtime |
| nbb runtime stability | Not needed |
| WebSocket protocol issues | HTTP only |
| QR code authentication | Bot token (string) |

---

## Recommendations

### Short-Term (Immediate)

1. **Keep container agent in TypeScript**: The Claude Agent SDK is Node.js-native. Migrating the container code provides minimal benefit.

2. **Use pure Babashka**: With Telegram, no hybrid architecture needed. Single runtime, single language.

3. **Maintain compatibility**: Keep the same SQLite schema to allow rollback. State files can migrate from JSON to EDN.

4. **Start with Telegram Bot API**: Create a BotFather bot, get token, start building.

### Medium-Term (Post-Migration)

1. **Explore MCP in Clojure**: Once stable, consider migrating container MCP server to `modex` or `mcp-clj`.

2. **Add property-based testing**: Use `test.check` for schema validation and state transitions.

3. **Implement message queuing**: Handle Telegram rate limits gracefully with a message queue.

### Long-Term

1. **Evaluate GraalVM native-image**: Could compile Babashka scripts to native binaries for faster startup.

2. **Consider sci-based plugins**: Allow users to extend NanoClaw with Clojure scripts evaluated at runtime.

3. **Multi-platform support**: Telegram's simple API makes it easy to add other platforms later (Discord, Slack) via similar HTTP clients.

---

## Appendix A: Complete bb.edn Configuration

```clojure
{:paths ["src"]
 :deps {org.clojure/clojure {:mvn/version "1.11.1"}
        metosin/malli {:mvn/version "0.13.0"}
        cheshire/cheshire {:mvn/version "5.12.0"}
        com.taoensso/timbre {:mvn/version "6.3.1"}
        overtone/at-at {:mvn/version "1.2.0"}}
 :pods {org.babashka/go-sqlite3 {:version "0.3.13"}
        org.babashka/fswatcher {:version "0.0.5"}}
 :tasks
 {dev {:doc "Run in development mode"
       :task (shell "bb -m nanoclaw.core")}

  test {:doc "Run tests"
        :task (shell "bb test/runner.clj")}

  repl {:doc "Start a REPL"
        :task (clojure "-M:repl")}}}
```

**Note**: No `package.json` or Node.js dependencies needed for the host application.

## Appendix B: File Structure After Migration

```
nanoclaw/
├── bb.edn                          # Babashka configuration
├── src/
│   └── nanoclaw/                   # Babashka (Clojure)
│       ├── core.clj                # Main entry point
│       ├── config.clj              # Configuration
│       ├── schemas.clj             # Malli schemas
│       ├── db.clj                  # SQLite operations
│       ├── telegram.clj            # Telegram Bot API client
│       ├── container.clj           # Container runner
│       ├── scheduler.clj           # Task scheduler
│       ├── ipc.clj                 # IPC watcher
│       ├── mount_security.clj      # Mount validation
│       └── utils.clj               # Utilities
├── test/
│   └── nanoclaw/
│       ├── telegram_test.clj
│       ├── db_test.clj
│       └── ...
├── container/                      # Unchanged (TypeScript)
│   └── agent-runner/
├── groups/                         # Unchanged (per-group memory)
├── data/                           # Unchanged (sessions, IPC)
│   ├── sessions/
│   ├── ipc/
│   └── env/
└── docs/
    └── plans/
        └── 2026-02-02-babashka-migration-plan.md
```

**Key difference from original plan**: No `whatsapp_bridge.cljs`, no `package.json` for host.

---

## Appendix C: Estimated Effort

| Phase | Duration | FTEs | Deliverables |
|-------|----------|------|--------------|
| Phase 1: Core Infrastructure | 1 week | 1 | Schemas, DB, config, utils |
| Phase 2: Telegram Client | 1 week | 1 | HTTP client, long polling |
| Phase 3: Container Management | 1 week | 1 | Container runner, IPC watcher |
| Phase 4: Main Loop | 1 week | 1 | Scheduler, full integration |
| Phase 5: Container Agent (Optional) | 2 weeks | 1 | MCP server in Clojure |

**Total**: 4 weeks for full migration (excluding optional Phase 5)

### Comparison: WhatsApp vs Telegram Timeline

| Approach | Estimated Time | Complexity |
|----------|---------------|------------|
| WhatsApp (hybrid nbb) | 6-8 weeks | High (two runtimes, IPC) |
| Telegram (pure Babashka) | **4 weeks** | **Low (single runtime, HTTP)** |

**Time saved**: ~50% reduction by switching to Telegram

---

*End of Migration Plan*
