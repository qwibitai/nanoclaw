# NanoClaw 프로젝트 아키텍처 상세 분석

> **문서 목적**: 프로젝트를 처음 접하는 SW 개발자/설계자가 전체 구조와 핵심 세부 구현을 모두 파악할 수 있도록 작성된 아키텍처 분석 문서입니다.  
> **분석 기준 버전**: 2026년 2월 기준 최신 소스 (`src/`, `container/agent-runner/`, `skills-engine/`)

---

## 목차

1. [프로젝트 개요 및 설계 철학](#1-프로젝트-개요-및-설계-철학)
2. [전체 시스템 아키텍처](#2-전체-시스템-아키텍처)
3. [호스트 계층 상세 분석](#3-호스트-계층-상세-분석)
4. [컨테이너 계층 상세 분석](#4-컨테이너-계층-상세-분석)
5. [IPC(프로세스간 통신) 메커니즘](#5-ipc프로세스간-통신-메커니즘)
6. [데이터베이스 스키마 및 영속성](#6-데이터베이스-스키마-및-영속성)
7. [보안 아키텍처](#7-보안-아키텍처)
8. [스킬 엔진(Skills Engine)](#8-스킬-엔진skills-engine)
9. [핵심 데이터 흐름 시나리오](#9-핵심-데이터-흐름-시나리오)
10. [환경 설정 및 운영](#10-환경-설정-및-운영)
11. [테스트 전략](#11-테스트-전략)
12. [설계 결정의 트레이드오프](#12-설계-결정의-트레이드오프)

---

## 1. 프로젝트 개요 및 설계 철학

### 1.1 NanoClaw란?

NanoClaw는 **WhatsApp 메신저를 인터페이스로 사용하는 Claude AI 에이전트 플랫폼**입니다. 사용자가 WhatsApp 그룹 채팅에서 `@Andy` (또는 설정된 이름)를 멘션하면, 해당 메시지가 안전하게 격리된 Docker 컨테이너 안의 Claude AI로 전달되어 처리됩니다.

기존 [OpenClaw](https://github.com/openclaw)의 경량 대안으로 설계되었으며, 핵심 목표는 다음과 같습니다:

- **"Small enough to understand"**: 1인 개발자가 전체 코드를 하루 만에 읽을 수 있는 규모
- **Security by design**: 코드 변경 없이 실행 시 위험하지 않도록 컨테이너 격리 우선
- **Skills over features**: 기능을 빌트인으로 추가하지 않고, 코드 변형(패칭) 방식으로 확장

### 1.2 핵심 설계 원칙

| 원칙        | 구현 방식                                                    |
| ----------- | ------------------------------------------------------------ |
| 최소 복잡도 | 마이크로서비스 없이 단일 Node.js 프로세스                    |
| 보안 격리   | 그룹별 독립 Docker 컨테이너 + 파일시스템 마운트 제한         |
| AI 네이티브 | Claude Code를 설정 도구로 직접 사용 (`/setup`, `/customize`) |
| 확장성      | 플러그인이 아닌 코드 패칭 방식 (Skills Engine)               |
| 운영 친화성 | macOS launchd 서비스로 백그라운드 실행                       |

---

## 2. 전체 시스템 아키텍처

### 2.1 이원화된 실행 구조

NanoClaw는 **호스트(Host)** 와 **컨테이너(Container)** 두 계층으로 명확히 분리됩니다.

```
┌──────────────────────────────────────────────────────────────┐
│  HOST (macOS / Linux)                                        │
│                                                              │
│  ┌─────────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
│  │  WhatsApp   │  │   DB     │  │   IPC    │  │Scheduler│  │
│  │  (baileys)  │  │ (SQLite) │  │ Watcher  │  │  Loop   │  │
│  └──────┬──────┘  └──────────┘  └──────────┘  └─────────┘  │
│         │              ↑              ↑              ↓        │
│         ↓              │              │              │        │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Orchestrator (src/index.ts)                │ │
│  │  - Message Loop (polling)                               │ │
│  │  - GroupQueue (concurrency control)                     │ │
│  │  - State management                                     │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                             │  stdin/stdout + volume mounts   │
└─────────────────────────────┼────────────────────────────────┘
                              │
          ┌───────────────────▼───────────────────┐
          │  CONTAINER (Docker / Apple Container) │
          │                                       │
          │  ┌────────────────────────────────┐   │
          │  │  agent-runner (Node.js)         │   │
          │  │  - reads ContainerInput (stdin) │   │
          │  │  - runs Claude SDK query()      │   │
          │  │  - polls IPC input dir          │   │
          │  │  - writes ContainerOutput(stdout│   │
          │  └───────────────┬────────────────┘   │
          │                  │ @anthropic-ai SDK   │
          │  ┌───────────────▼────────────────┐   │
          │  │  Claude AI (Anthropic API)      │   │
          │  └────────────────────────────────┘   │
          └───────────────────────────────────────┘
```

### 2.2 두 계층의 역할 분담

| 구분       | 호스트                           | 컨테이너                      |
| ---------- | -------------------------------- | ----------------------------- |
| 역할       | 오케스트레이션, 상태관리, 메시징 | AI 추론, 파일 조작, 도구 실행 |
| 실행 수명  | 상시 실행 (데몬)                 | 요청별 일회성 (`--rm`)        |
| DB 접근    | 직접 읽기/쓰기                   | 불가 (스냅샷 JSON만 읽기)     |
| 네트워크   | WhatsApp 연결 유지               | Anthropic API 호출            |
| 파일시스템 | 전체 접근                        | 마운트된 범위만               |

---

## 3. 호스트 계층 상세 분석

### 3.1 진입점: `src/index.ts`

**`main()` 함수** 실행 순서:
```
1. ensureContainerSystemRunning()  → Docker 데몬 확인 + 고아 컨테이너 정리
2. initDatabase()                  → SQLite 스키마 생성 + JSON 마이그레이션
3. loadState()                     → DB에서 세션, 그룹, 타임스탬프 복원
4. WhatsAppChannel.connect()       → baileys WebSocket 연결
5. startSchedulerLoop()            → 스케줄 태스크 감시 (60초 간격)
6. startIpcWatcher()               → 컨테이너 IPC 파일 감시 (1초 간격)
7. recoverPendingMessages()        → 크래시 복구: 미처리 메시지 재처리
8. startMessageLoop()              → 메인 폴링 루프 (2초 간격) - 무한 실행
```

**중요한 상태 변수들** (모듈 레벨, 프로세스 재시작 시 DB에서 복원):
```typescript
let lastTimestamp = '';           // 전체 메시지 폴링 커서
let lastAgentTimestamp = {};      // 그룹별 에이전트 처리 커서
let sessions = {};                // 그룹폴더 → Claude SessionID 매핑
let registeredGroups = {};        // JID → RegisteredGroup 매핑
```

### 3.2 메시지 루프: `startMessageLoop()`

```
while (true) {
  ① getNewMessages(jids, lastTimestamp)   ← DB 폴링 (2초 간격)
  ② 그룹별로 메시지 묶기 (Map<chatJid, messages[]>)
  ③ 각 그룹에 대해:
     - 트리거(@Andy) 포함 여부 확인 (비메인 그룹만)
     - getMessagesSince(lastAgentTimestamp) 로 전체 미처리 컨텍스트 가져오기
     - queue.sendMessage()  → 활성 컨테이너가 있으면 IPC로 직접 파이핑
     - queue.enqueueMessageCheck() → 활성 컨테이너 없으면 새 컨테이너 큐에 추가
  ④ await sleep(POLL_INTERVAL)  ← 2000ms
}
```

**두 커서(Cursor) 의 차이**:
- `lastTimestamp`: "어디까지 새 메시지를 봤는가" (메시지 루프용)
- `lastAgentTimestamp[chatJid]`: "어디까지 에이전트에게 보냈는가" (에이전트용)

메시지 루프가 `lastTimestamp`를 먼저 전진시키고, 에이전트가 처리 완료되어야 `lastAgentTimestamp`가 전진합니다. 에러 시 `lastAgentTimestamp`를 롤백하여 재처리가 가능합니다.

### 3.3 GroupQueue: 동시성 제어

`src/group-queue.ts`의 `GroupQueue` 클래스가 컨테이너 동시 실행을 관리합니다.

**핵심 상태 (`GroupState`)**:
```typescript
interface GroupState {
  active: boolean;          // 현재 컨테이너 실행 중인가
  idleWaiting: boolean;     // 작업 완료 후 다음 IPC 대기 중인가
  isTaskContainer: boolean; // 스케줄 태스크용 컨테이너인가
  pendingMessages: boolean; // 연결 대기 중인 메시지 있는가
  pendingTasks: QueuedTask[]; // 연결 대기 중인 태스크들
  process: ChildProcess | null; // 현재 컨테이너 프로세스
  containerName: string | null;
  retryCount: number;       // 실패 재시도 횟수
}
```

**Our Concurrency Model**:
```
MAX_CONCURRENT_CONTAINERS (기본: 5)를 초과하면 waitingGroups[] 대기열에 추가
컨테이너 종료 → drainGroup() → drainWaiting() 순으로 처리

우선순위: 태스크(Tasks) > 메시지(Messages)

에러 시 지수 백오프 재시도:
  retryCount=1: 5초 후 재시도
  retryCount=2: 10초 후 재시도
  retryCount=5: 80초 → MAX_RETRIES 초과 시 포기
```

**IPC를 통한 메시지 파이핑** (`sendMessage()`):
```typescript
// 활성 컨테이너가 있으면 DB 쿼리 없이 직접 파일로 전달
const filename = `${Date.now()}-${random}.json`;
fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
fs.renameSync(tempPath, filepath); // atomic write
```

---

## 4. 컨테이너 계층 상세 분석

### 4.1 컨테이너 빌드: `container/Dockerfile`

```dockerfile
FROM node:22-slim
# Chromium (브라우저 자동화), Python (일부 패키지), git 설치
RUN apt-get install -y chromium python3 git ...

# 글로벌 Claude 도구 설치
RUN npm install -g agent-browser @anthropic-ai/claude-code

# agent-runner 빌드 (TypeScript → JavaScript)
COPY agent-runner/ /app/agent-runner/
WORKDIR /app/agent-runner
RUN npm ci && npm run build

ENTRYPOINT ["/app/entrypoint.sh"]
```

### 4.2 Agent Runner 진입점: `container/agent-runner/src/index.ts`

**시작 절차**:
```
1. readStdin()              → ContainerInput JSON 전체 읽기 (EOF까지)
2. /tmp/input.json 삭제     → 엔트리포인트가 임시 저장한 파일 보안 삭제
3. secrets → sdkEnv 빌드   → process.env에는 노출하지 않고 SDK 전용 env 구성
4. IPC_INPUT_DIR 생성       → /workspace/ipc/input/ 디렉토리 초기화
5. _close sentinel 정리     → 이전 컨테이너의 잔존 파일 삭제
6. 쿼리 루프 시작            → runQuery() → waitForIpcMessage() 반복
```

**MessageStream 클래스** (핵심 설계):
```typescript
// AsyncIterable로 구현된 push-based 메시지 스트림
// SDK에 문자열 대신 AsyncIterable을 전달하면
// isSingleUserTurn=false가 되어 agent teams가 완전히 실행됨
class MessageStream {
  push(text: string): void { ... }  // 새 메시지 추가
  end(): void { ... }               // 스트림 종료 신호
  async *[Symbol.asyncIterator]() { ... } // SDK가 소비
}
```

**쿼리 루프 구조**:
```
while (true) {
  ① runQuery(prompt, sessionId, ...)
     - MessageStream에 prompt push
     - IPC 폴링 타이머 시작 (500ms 간격)
     - for await (msg of query({ prompt: stream, ... })) { 결과 writeOutput() }

  ② closedDuringQuery? → 즉시 break

  ③ writeOutput({ status: 'success', result: null })  ← 세션 업데이트 마커

  ④ waitForIpcMessage()  → _close 또는 다음 메시지 대기
     - poll() 500ms 간격으로 IPC 디렉토리 스캔
     - _close sentinel → null 반환 → break
     - .json 파일 발견 → 메시지 텍스트 반환 → 새 쿼리

  ⑤ prompt = nextMessage → ①로 반복
}
```

### 4.3 Claude SDK query() 옵션 분석

```typescript
query({
  prompt: stream,           // AsyncIterable (isSingleUserTurn 방지)
  options: {
    cwd: '/workspace/group',              // Claude 작업 디렉토리
    additionalDirectories: extraDirs,     // /workspace/extra/* 추가 마운트
    resume: sessionId,                    // 이전 세션 이어받기
    systemPrompt: {                       // 비메인 그룹: 전역 CLAUDE.md 주입
      type: 'preset', preset: 'claude_code',
      append: globalClaudeMd
    },
    allowedTools: [                       // 허용된 도구 목록
      'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
      'WebSearch', 'WebFetch',
      'Task', 'TaskOutput', 'TaskStop',    // agent teams
      'TeamCreate', 'TeamDelete', 'SendMessage',
      'TodoWrite', 'ToolSearch', 'Skill',
      'mcp__nanoclaw__*'                   // NanoClaw MCP 도구
    ],
    permissionMode: 'bypassPermissions',  // 권한 프롬프트 없이 실행
    mcpServers: { nanoclaw: { ... } },    // NanoClaw IPC MCP 서버
    hooks: {
      PreCompact: [archiveHook],           // 컴팩션 전 대화 아카이빙
      PreToolUse: [sanitizeBashHook],      // Bash 실행 전 시크릿 환경변수 제거
    }
  }
})
```

### 4.4 보안 훅 상세

**`createSanitizeBashHook()`**: Bash 도구 실행 전, API 키 등을 환경에서 제거
```bash
# Claude가 Bash를 사용할 때 자동으로 앞에 삽입됨
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; <실제 명령>
```

**`createPreCompactHook()`**: 컨텍스트 컴팩션(압축) 직전, 전체 대화록을 Markdown으로 아카이빙
```
/workspace/group/conversations/2026-02-25-session-summary.md
```

---

## 5. IPC(프로세스간 통신) 메커니즘

### 5.1 두 가지 IPC 채널

NanoClaw는 **호스트 ↔ 컨테이너** 통신에 두 채널을 사용합니다:

| 채널           | 방향                                         | 용도                             |
| -------------- | -------------------------------------------- | -------------------------------- |
| `stdin/stdout` | 호스트 → 컨테이너 (초기) / 컨테이너 → 호스트 | 최초 입력 전달, 결과 수신        |
| 파일시스템 IPC | 호스트 ↔ 컨테이너 (양방향)                   | 팔로업 메시지, 태스크, 그룹 등록 |

### 5.2 파일시스템 IPC 구조

```
data/ipc/
  {groupFolder}/
    input/                  ← 호스트가 쓰고, 컨테이너가 읽음
      {timestamp}-{random}.json    (팔로업 메시지)
      _close                        (종료 센티넬)
    messages/               ← 컨테이너가 쓰고, 호스트가 읽음
      {timestamp}-{random}.json    (다른 그룹에게 메시지 전송)
    tasks/                  ← 컨테이너가 쓰고, 호스트가 읽음
      {timestamp}-{random}.json    (태스크 생성/수정/삭제)
  errors/
    {groupFolder}-{file}    ← 처리 실패한 IPC 파일 격리
```

### 5.3 IPC 메시지 타입 (tasks/)

```typescript
// 컨테이너 내 Claude가 MCP 도구를 통해 보낼 수 있는 IPC 명령들
{ type: 'schedule_task', prompt, schedule_type, schedule_value, targetJid, context_mode }
{ type: 'pause_task',   taskId }
{ type: 'resume_task',  taskId }
{ type: 'cancel_task',  taskId }
{ type: 'refresh_groups' }                  // 메인 그룹만 가능
{ type: 'register_group', jid, name, ... }  // 메인 그룹만 가능
```

### 5.4 IPC 인가 (Authorization)

`src/ipc.ts`의 `processTaskIpc()`에서 **소스 그룹 폴더 기반**으로 인가:

```typescript
// 비메인 그룹은 자신의 태스크만 관리 가능
if (!isMain && targetFolder !== sourceGroup) {
  logger.warn('Unauthorized schedule_task attempt blocked');
  break;
}
// 그룹 등록, 새로고침은 메인만 가능
if (!isMain) { logger.warn('Unauthorized register_group attempt blocked'); break; }
```

**신뢰 모델**: 소스 그룹 폴더 경로가 곧 신원. 컨테이너는 자신의 `groupFolder`에만 쓸 수 있으며, 호스트 `IPC Watcher`가 이 디렉토리를 소스 신원으로 사용합니다.

---

## 6. 데이터베이스 스키마 및 영속성

### 6.1 SQLite 스키마 (`store/messages.db`)

```sql
-- 채팅 메타데이터 (전체 채팅: 등록 여부 무관)
chats (jid PK, name, last_message_time, channel, is_group)

-- 메시지 내용 (등록된 그룹만 저장)
messages (id, chat_jid FK, sender, sender_name, content,
          timestamp, is_from_me, is_bot_message)
  INDEX: timestamp, (id, chat_jid) PK

-- 예약 태스크
scheduled_tasks (id PK, group_folder, chat_jid, prompt,
                 schedule_type, schedule_value, context_mode,
                 next_run INDEX, last_run, last_result, status INDEX, created_at)

-- 태스크 실행 로그
task_run_logs (id AutoInc, task_id FK, run_at, duration_ms,
               status, result, error)

-- 라우터 상태 (커서 저장)
router_state (key PK, value)
  → 'last_timestamp', 'last_agent_timestamp' (JSON)

-- Claude 세션 ID
sessions (group_folder PK, session_id)

-- 등록된 그룹
registered_groups (jid PK, name, folder UNIQUE, trigger_pattern,
                   added_at, container_config JSON, requires_trigger)
```

### 6.2 데이터 흐름별 영속성

| 이벤트      | 저장 위치           | 비고                   |
| ----------- | ------------------- | ---------------------- |
| 메시지 수신 | `messages` 테이블   | 등록 그룹만            |
| 그룹 등록   | `registered_groups` | IPC → DB               |
| 세션 아이디 | `sessions`          | 컨테이너 응답에서 추출 |
| 폴링 커서   | `router_state`      | 2초마다 저장           |
| 태스크 생성 | `scheduled_tasks`   | IPC → DB               |
| 태스크 로그 | `task_run_logs`     | 매 실행 후 저장        |

### 6.3 스냅샷 파일 (컨테이너용 읽기전용 데이터)

DB는 컨테이너에 마운트되지 않습니다. 대신 컨테이너가 읽을 수 있는 JSON 스냅샷을 파일로 제공합니다:

```
data/env/{groupFolder}/tasks.json   ← 태스크 목록 스냅샷
data/env/{groupFolder}/groups.json  ← 그룹 목록 스냅샷 (단, 메인 그룹만 전체 그룹 조회 가능)
```

---

## 7. 보안 아키텍처

### 7.1 보안 계층 구조

```
Layer 1: 컨테이너 격리
  - 그룹별 독립 컨테이너 → 컨테이너 탈출 없이는 다른 그룹 접근 불가
  - --rm 플래그 → 컨테이너 종료 시 파일시스템 완전 삭제

Layer 2: 볼륨 마운트 제한
  - 블랙리스트: .ssh, .aws, credentials, private_key 등
  - 화이트리스트: ~/.config/nanoclaw/mount-allowlist.json (컨테이너 밖 저장)
  - 비메인 그룹: 추가 마운트 강제 읽기전용

Layer 3: IPC 인가
  - 소스 폴더 기반 신원 검증
  - 비메인 그룹은 자신의 태스크만 관리
  - register_group, refresh_groups는 메인 그룹 전용

Layer 4: 시크릿 격리
  - API Key는 stdin JSON으로 전달 → 파일 저장 없음
  - Bash 실행 전 env에서 시크릿 제거 (PreToolUse 훅)
  - 시크릿은 sdkEnv에만 존재 → process.env와 별도

Layer 5: 경로 검증
  - group-folder.ts: 알파벳/숫자/-만 허용, .. 차단
  - DB 저장 시 isValidGroupFolder() 검증
```

### 7.2 시크릿 전달 흐름

```
호스트:
  .env 파일 → readSecrets() → ContainerInput.secrets

컨테이너 실행:
  docker run ... (환경변수로 전달 안 함)
  container.stdin.write(JSON.stringify(containerInput))
  → stdin을 통해 JSON 전달

컨테이너 내부:
  readStdin() → JSON.parse() → containerInput.secrets
  sdkEnv = { ...process.env, ...secrets }  ← SDK 전용
  /tmp/input.json 즉시 삭제
  query({ options: { env: sdkEnv } })  ← API 호출에만 사용

Bash 도구 실행 시:
  PreToolUse hook → unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
```

### 7.3 권한 비교: 메인 vs 비메인 그룹

| 기능                     | 메인 그룹        | 비메인 그룹     |
| ------------------------ | ---------------- | --------------- |
| 프로젝트 루트 마운트     | ✅ 읽기전용       | ❌               |
| 다른 그룹에 메시지 전송  | ✅                | ❌ (자신에게만)  |
| 그룹 등록                | ✅                | ❌               |
| 태스크 전체 관리         | ✅                | ⚠️ 자신의 것만   |
| 그룹 메타데이터 새로고침 | ✅                | ❌               |
| 추가 마운트 R/W          | ✅ (allowlist 내) | ⚠️ 읽기전용 강제 |

---

## 8. 스킬 엔진(Skills Engine)

### 8.1 개요

`skills-engine/` 디렉토리는 NanoClaw의 기능 확장 메커니즘입니다. 플러그인 시스템이 아닌 **Git 3-way merge 기반 코드 패칭** 방식으로 동작합니다.

### 8.2 핵심 파일들

| 파일            | 역할                                                          |
| --------------- | ------------------------------------------------------------- |
| `apply.ts`      | 스킬 적용: 파일 ops → 새 파일 복사 → 3-way merge → 구조적 ops |
| `uninstall.ts`  | 스킬 제거: 기반에서 재플레이 (나머지 스킬만 적용)             |
| `update.ts`     | 코어 업데이트: 3-way merge + 마이그레이션 스킬 적용           |
| `replay.ts`     | state.yaml 기반 재현성 있는 재플레이                          |
| `rebase.ts`     | 누적 패치 평탄화 (새 기반점으로 재설정)                       |
| `state.ts`      | `.nanoclaw/state.yaml` 읽기/쓰기                              |
| `merge.ts`      | `git merge-file` 래퍼                                         |
| `backup.ts`     | 작업 전 백업 + 실패 시 복원                                   |
| `lock.ts`       | 동시 작업 방지 (파일 잠금)                                    |
| `structured.ts` | npm deps, env vars, docker-compose 병합                       |
| `path-remap.ts` | 코어 업데이트 시 경로 재매핑                                  |
| `migrate.ts`    | 마이그레이션 스킬 적용                                        |

### 8.3 스킬 적용 흐름

```
① Pre-flight 검사
   - 코어 버전 호환성, 의존성 충족, 충돌 스킬 없음
   - 변경 감지 (hash 비교로 untracked changes 탐지)

② 백업 (.nanoclaw/backup/ 에 복사)

③ 파일 작업 (renames, deletes, moves)

④ 새 파일 복사 (skills/{name}/add/ → src/)

⑤ 코드 파일 3-way merge
   git merge-file current.ts .nanoclaw/base/current.ts skill/modify/current.ts
   
   충돌 발생 시:
   캐시 확인(.nanoclaw/resolutions/) → git rerere → Claude Code → 사용자

⑥ 구조적 작업 (package.json, .env.example, docker-compose.yml 병합)

⑦ npm install (구조적 작업에 npm_dependencies 있을 경우 한 번만)

⑧ state.yaml 업데이트 (파일 해시, 적용 기록)

⑨ 테스트 실행 (필수 - 클린 머지여도 실행)
   실패 시 → Claude Code 시맨틱 충돌 진단

⑩ 성공 시 백업 삭제 / 실패 시 복원
```

---

## 9. 핵심 데이터 흐름 시나리오

### 9.1 시나리오 A: 기본 메시지 처리 흐름

```
사용자 → WhatsApp: "@Andy 오늘 날씨 어때?"

① WhatsApp Channel (baileys):
   onMessage() → storeMessage(msg) → SQLite messages 테이블

② Message Loop (2초 후):
   getNewMessages([groupJid], lastTimestamp)
   → "@Andy" 트리거 패턴 확인 → 통과
   → getMessagesSince(lastAgentTimestamp) → 컨텍스트 조회
   → queue.sendMessage() 시도 → 활성 컨테이너 없음
   → queue.enqueueMessageCheck(chatJid)

③ GroupQueue:
   activeCount < MAX_CONCURRENT_CONTAINERS → 즉시 실행
   runForGroup(chatJid, 'messages')
   → processGroupMessages(chatJid) 호출

④ processGroupMessages():
   formatted = formatMessages(missedMessages) → XML 형식
   lastAgentTimestamp 전진 + saveState()
   → runAgent(group, prompt, chatJid, onOutput)

⑤ runAgent():
   writeTasksSnapshot() + writeGroupsSnapshot()  ← 스냅샷 갱신
   runContainerAgent(group, containerInput, onProcess, onOutput)

⑥ container-runner.ts:
   docker run --rm -i ... -v groups/devteam:/workspace/group ...
   stdin.write(JSON.stringify({ prompt, sessionId, secrets, ... }))

⑦ agent-runner (컨테이너 내):
   readStdin() → query({ prompt: stream, ... })
   Claude API 호출 → 결과 생성

⑧ writeOutput() → stdout:
   "---NANOCLAW_OUTPUT_START---\n{status,result,...}\n---NANOCLAW_OUTPUT_END---"

⑨ container-runner.ts:
   stdout 파싱 → onOutput(result) 콜백 호출

⑩ processGroupMessages() 내 onOutput 콜백:
   raw.replace(/<internal>[\s\S]*?<\/internal>/g, '')  ← 내부 추론 제거
   channel.sendMessage(chatJid, text) → WhatsApp으로 전송

사용자 ← WhatsApp: "서울 현재 기온은 3°C입니다..."
```

### 9.2 시나리오 B: 컨테이너 재사용 (팔로업 메시지)

```
사용자: "@Andy 좀 더 자세히 설명해줘"

① 기존 컨테이너가 idle waiting 상태 (query 완료, IPC 대기 중)

② Message Loop:
   queue.sendMessage(chatJid, formatted) → 성공 (true 반환)
   IPC 파일 작성: data/ipc/devteam/input/{ts}-{random}.json

③ agent-runner 내 waitForIpcMessage():
   poll() → 파일 발견 → 텍스트 반환
   → while 루프 → 새 runQuery() 실행
   → 이전 sessionId + resumeAt으로 이어받기 (대화 연속성)

④ 결과 → onOutput → WhatsApp 전송
```

### 9.3 시나리오 C: 스케줄 태스크 실행

```
① startSchedulerLoop() (60초 간격):
   getDueTasks() → next_run <= now인 active 태스크 조회
   → queue.enqueueTask(chatJid, taskId, () => runTask(task, deps))

② GroupQueue:
   isTaskContainer = true 로 컨테이너 시작
   태스크용 컨테이너는 sendMessage() 불가 (isTaskContainer 체크)

③ runTask():
   context_mode='group' → 기존 sessionId 사용 (대화 컨텍스트 이어받기)
   context_mode='isolated' → sessionId 없이 새 세션
   isScheduledTask: true → "[SCHEDULED TASK]" 프리픽스 자동 추가

④ 결과 수신 후 TASK_CLOSE_DELAY_MS(10초) 후 자동 종료
   updateTaskAfterRun() → 다음 실행 시간 계산 (cron/interval)
```

---

## 10. 환경 설정 및 운영

### 10.1 환경변수 목록

| 변수                        | 기본값                  | 설명                                   |
| --------------------------- | ----------------------- | -------------------------------------- |
| `ASSISTANT_NAME`            | `Andy`                  | 봇 이름 (트리거 패턴 `@Andy`)          |
| `ANTHROPIC_API_KEY`         | -                       | Claude API 키 (또는 OAuth 토큰)        |
| `CLAUDE_CODE_OAUTH_TOKEN`   | -                       | Claude Code 인증 토큰                  |
| `CONTAINER_IMAGE`           | `nanoclaw-agent:latest` | 컨테이너 이미지 이름                   |
| `CONTAINER_TIMEOUT`         | `1800000`               | 컨테이너 최대 실행 시간 (ms, 30분)     |
| `IDLE_TIMEOUT`              | `1800000`               | 마지막 결과 후 컨테이너 유지 시간 (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5`                     | 동시 실행 가능한 최대 컨테이너 수      |
| `POLL_INTERVAL`             | `2000` (코드값)         | 메시지 폴링 간격 (ms)                  |
| `TZ`                        | 시스템 타임존           | 스케줄 태스크 시간대                   |

### 10.2 디렉토리 구조

```
nanoclaw/
  src/                  ← 호스트 오케스트레이터 소스
  container/
    agent-runner/       ← 컨테이너 내 에이전트 소스
    Dockerfile          ← 컨테이너 이미지 정의
  skills-engine/        ← 스킬(기능 확장) 엔진
  groups/
    CLAUDE.md           ← 전역 공통 기억 (모든 그룹에 주입)
    main/               ← 메인 관리자 그룹 폴더
    {group}/            ← 각 그룹별 폴더 (컨테이너에 마운트)
      CLAUDE.md         ← 그룹별 기억
      conversations/    ← 대화 아카이브
      logs/             ← 로그
  store/
    messages.db         ← SQLite 데이터베이스
    auth/               ← WhatsApp 인증 정보 (baileys)
  data/
    ipc/                ← 프로세스간 통신 파일들
    env/                ← 컨테이너용 스냅샷 JSON
    sessions/           ← Claude 세션 데이터 (컨테이너에 마운트)
  launchd/              ← macOS 서비스 설정
  setup/                ← 설치 스크립트들
  .nanoclaw/
    base/               ← 스킬 엔진: 클린 코어 기반
    state.yaml          ← 적용된 스킬 목록 및 해시
    resolutions/        ← 검증된 머지 충돌 해결 캐시
```

### 10.3 메모리 시스템 구조

Claude는 CLAUDE.md 파일을 통해 계층별 기억을 가집니다:

```
/workspace/global/CLAUDE.md      ← 전역 지침 (모든 그룹 공통)
/workspace/group/CLAUDE.md       ← 그룹별 지침/기억
/workspace/group/*.md            ← 도구별 특화 기억 (선택적)
/workspace/extra/{name}/CLAUDE.md ← 추가 마운트 디렉토리 설명
```

---

## 11. 테스트 전략

### 11.1 테스트 파일 구성

| 파일                       | 테스트 대상         | 특이사항                       |
| -------------------------- | ------------------- | ------------------------------ |
| `db.test.ts`               | DB CRUD 전체        | `:memory:` SQLite 활용         |
| `container-runner.test.ts` | 컨테이너 실행 로직  | mock ChildProcess              |
| `group-queue.test.ts`      | 동시성 제어, 재시도 | 시뮬레이션된 실패/성공         |
| `ipc-auth.test.ts`         | IPC 인가 로직       | 각 IPC 타입 + 권한 조합        |
| `formatting.test.ts`       | 메시지 포맷팅       | XML 이스케이프, 긴 메시지 처리 |
| `routing.test.ts`          | 채널 라우팅         | JID별 채널 매칭                |
| `mount-security.ts`        | 마운트 보안 검증    | 블랙리스트/화이트리스트        |
| `skills-engine/__tests__/` | 스킬 엔진 전체      | 20개 테스트 파일               |

### 11.2 실행 방법

```bash
npx vitest run          # 전체 단위 테스트
npx vitest run --config vitest.skills.config.ts  # 스킬 엔진 테스트만
```

---

## 12. 설계 결정의 트레이드오프

### 12.1 단일 프로세스 오케스트레이터

| 장점                    | 단점                              |
| ----------------------- | --------------------------------- |
| 설정 복잡도 극소화      | 오케스트레이터 크래시 = 전체 중단 |
| 코드 가독성 높음        | 수평 확장 불가                    |
| 상태 공유 용이 (메모리) | 메모리 누수 시 영향 범위 큼       |

### 12.2 폴링 기반 메시지 처리

| 장점             | 단점                     |
| ---------------- | ------------------------ |
| 구현 단순        | 최대 2초 지연            |
| 크래시 복구 용이 | DB I/O 지속 발생         |
| DB가 버퍼 역할   | 고부하 시 DB lock 가능성 |

### 12.3 컨테이너 재사용 (IPC 파이핑)

| 장점                        | 단점                       |
| --------------------------- | -------------------------- |
| 세션 연속성 유지            | IPC 파일 시스템 관리 필요  |
| 컨테이너 시작 오버헤드 감소 | IPC 파일 손상 시 세션 손실 |
| 대화 컨텍스트 이어받기      | 복잡한 상태 관리 필요      |

### 12.4 Git 3-way Merge 스킬 시스템

| 장점                     | 단점                              |
| ------------------------ | --------------------------------- |
| 사용자 커스터마이즈 보존 | Git 필요 (zip 다운로드 불가)      |
| 충돌 해결 재사용 가능    | rerere 어댑터 필요 (index 설정)   |
| 감사 가능 (diff로 확인)  | 스킬 저자가 전체 파일 포함해야 함 |

---

## 부록: 주요 인터페이스 정의

### ContainerInput (호스트 → 컨테이너)
```typescript
interface ContainerInput {
  prompt: string;           // 사용자 메시지 (XML 포맷)
  sessionId?: string;       // Claude 세션 ID (연속 대화용)
  groupFolder: string;      // 그룹 폴더 이름
  chatJid: string;          // WhatsApp JID
  isMain: boolean;          // 메인(관리자) 그룹 여부
  isScheduledTask?: boolean; // 스케줄 태스크 여부
  assistantName?: string;   // 봇 이름
  secrets?: Record<string, string>; // API 키 등
}
```

### ContainerOutput (컨테이너 → 호스트)
```typescript
interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;    // Claude 최종 응답 텍스트
  newSessionId?: string;    // (신규) 생성된 세션 ID
  error?: string;           // 에러 메시지
}
```

### RegisteredGroup (등록된 그룹 정보)
```typescript
interface RegisteredGroup {
  name: string;             // 그룹 이름
  folder: string;           // 그룹 폴더 (alphanumeric + -)
  trigger: string;          // 트리거 패턴
  added_at: string;         // 등록 시각 (ISO 8601)
  containerConfig?: {
    additionalMounts?: AdditionalMount[];
    timeout?: number;
  };
  requiresTrigger?: boolean; // false = 모든 메시지에 반응
}
```

---

*이 문서는 `src/`, `container/agent-runner/`, `skills-engine/` 소스 코드 직접 분석을 기반으로 작성되었습니다.*  
*마지막 업데이트: 2026-02-25*
