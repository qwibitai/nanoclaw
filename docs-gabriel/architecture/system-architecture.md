# NanoClaw 시스템 아키텍처

> 이 문서는 NanoClaw의 내부 구조를 코드 레벨까지 설명합니다.  
> 전체 개요는 먼저 [`../OVERVIEW.md`](../OVERVIEW.md)를 참고하세요.

---

## 1. 전체 메시지 흐름

```
사용자 → "@Andy 날씨 알려줘" (WhatsApp)

① WhatsApp 채널 (baileys):
   메시지 수신 → SQLite(messages 테이블)에 저장

② 메시지 루프 (2초 간격 폴링):
   getNewMessages() → 트리거 패턴 확인
   → 활성 컨테이너 있으면 IPC 파일로 전달
   → 없으면 새 컨테이너 생성 큐에 추가

③ GroupQueue:
   동시 실행 수(기본 5개) 초과 시 대기
   → runForGroup() → processGroupMessages()

④ container-runner.ts:
   docker run --rm ... (볼륨 마운트 포함)
   stdin으로 ContainerInput JSON 전달

⑤ agent-runner (컨테이너 내부):
   Claude SDK query() 호출
   IPC 폴링으로 추가 메시지 대기

⑥ 결과 출력 (stdout):
   ---NANOCLAW_OUTPUT_START---
   {"status":"success","result":"날씨는..."}
   ---NANOCLAW_OUTPUT_END---

⑦ 호스트가 파싱 후 WhatsApp으로 전송
```

---

## 2. 호스트 계층 주요 컴포넌트

| 컴포넌트             | 파일                      | 역할                            |
| :------------------- | :------------------------ | :------------------------------ |
| **오케스트레이터**   | `src/index.ts`            | 전체 시스템 시작 및 메시지 루프 |
| **GroupQueue**       | `src/group-queue.ts`      | 컨테이너 동시 실행 수 제어      |
| **container-runner** | `src/container-runner.ts` | Docker 실행 및 볼륨 마운트 구성 |
| **IPC 워처**         | `src/ipc.ts`              | 컨테이너→호스트 IPC 명령 처리   |
| **DB**               | `src/db.ts`               | SQLite CRUD                     |
| **마운트 보안**      | `src/mount-security.ts`   | 추가 마운트 화이트리스트 검증   |
| **스케줄러**         | `src/task-scheduler.ts`   | 예약 작업 실행 (60초 간격)      |

### 서비스 시작 순서 (`main()`)

```
1. ensureContainerSystemRunning()  → Docker 데몬 확인 + 고아 컨테이너 정리
2. initDatabase()                  → SQLite 스키마 + 마이그레이션
3. loadState()                     → DB에서 세션, 그룹, 커서 복원
4. WhatsAppChannel.connect()       → baileys WebSocket 연결
5. startSchedulerLoop()            → 스케줄 태스크 감시
6. startIpcWatcher()               → 컨테이너 IPC 파일 감시
7. recoverPendingMessages()        → 크래시 복구
8. startMessageLoop()              → 메인 폴링 루프 (무한)
```

---

## 3. 컨테이너 계층

### 볼륨 마운트 구성

**메인 그룹:**

| 호스트 경로                            | 컨테이너 경로        | 권한      |
| :------------------------------------- | :------------------- | :-------- |
| `{projectRoot}/`                       | `/workspace/project` | 읽기전용  |
| `groups/main/`                         | `/workspace/group`   | 읽기+쓰기 |
| `data/sessions/main/.claude/`          | `/home/node/.claude` | 읽기+쓰기 |
| `data/ipc/main/`                       | `/workspace/ipc`     | 읽기+쓰기 |
| `data/sessions/main/agent-runner-src/` | `/app/src`           | 읽기+쓰기 |

**비메인 그룹:**

| 호스트 경로                       | 컨테이너 경로              | 권한          |
| :-------------------------------- | :------------------------- | :------------ |
| `groups/{folder}/`                | `/workspace/group`         | 읽기+쓰기     |
| `groups/global/`                  | `/workspace/global`        | 읽기전용      |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude`       | 읽기+쓰기     |
| `data/ipc/{folder}/`              | `/workspace/ipc`           | 읽기+쓰기     |
| 추가 마운트 (설정 시)             | `/workspace/extra/{name}/` | 강제 읽기전용 |

### Claude SDK 호출 옵션

```typescript
query({
  prompt: messageStream,          // AsyncIterable (세션 연속성 유지)
  options: {
    cwd: '/workspace/group',      // 작업 디렉토리
    resume: sessionId,            // 이전 세션 이어받기
    permissionMode: 'bypassPermissions',
    allowedTools: ['Bash', 'Read', 'Write', 'WebSearch', ...],
    mcpServers: { nanoclaw: { ... } },  // IPC MCP 서버
    hooks: {
      PreToolUse: [sanitizeBashHook],   // API Key env 제거
      PreCompact: [archiveHook],        // 대화 아카이빙
    }
  }
})
```

---

## 4. IPC (프로세스 간 통신)

### 파일 시스템 기반 구조

```
data/ipc/{groupFolder}/
  input/
    {timestamp}-{random}.json    ← 호스트→컨테이너: 팔로업 메시지
    _close                        ← 호스트→컨테이너: 종료 신호
  messages/
    {timestamp}-{random}.json    ← 컨테이너→호스트: 메시지 전송
  tasks/
    {timestamp}-{random}.json    ← 컨테이너→호스트: 태스크 생성/수정/삭제
```

### 컨테이너가 보낼 수 있는 IPC 명령 (tasks/)

```json
{ "type": "schedule_task", "prompt": "...", "schedule_type": "cron", "schedule_value": "0 9 * * *" }
{ "type": "pause_task",  "taskId": "..." }
{ "type": "cancel_task", "taskId": "..." }
{ "type": "register_group", "jid": "...", "name": "..." }  // 메인 그룹만
{ "type": "refresh_groups" }                                // 메인 그룹만
```

---

## 5. 데이터베이스 스키마 (`store/messages.db`)

```sql
chats            -- 채팅방 메타데이터 (jid, name, last_message_time, channel)
messages         -- 메시지 내용 (등록된 그룹만 저장)
registered_groups -- 등록된 그룹 + container_config(마운트 설정)
scheduled_tasks  -- 예약 작업
task_run_logs    -- 태스크 실행 로그
sessions         -- Claude 세션 ID (group_folder → session_id)
router_state     -- 폴링 커서 (last_timestamp, last_agent_timestamp)
```

> DB는 컨테이너에 마운트되지 않습니다.  
> 컨테이너가 읽어야 하는 정보는 `data/env/{groupFolder}/tasks.json` 등 스냅샷 파일로 제공됩니다.

---

## 6. 컨테이너 생명주기 상세

### 생성 조건
- 등록된 그룹에 트리거 메시지(@Andy 등)가 도착했을 때
- 예약 작업(Scheduled Task) 실행 시간이 됐을 때

### 재사용 조건
- 이미 실행 중인 컨테이너가 있을 때: IPC input 파일로 메시지 전달
- 기존 세션 ID 유지 → 이전 대화 문맥 지속

### 종료 조건
- **유휴 타임아웃**: 마지막 응답 후 30분 경과 (환경변수 `IDLE_TIMEOUT`)
- **강제 타임아웃**: 생성 후 30분 경과 (환경변수 `CONTAINER_TIMEOUT`)
- **태스크 컨테이너**: 작업 완료 10초 후 자동 종료

### 재시도 정책
에러 발생 시 지수 백오프 재시도:
- 1회: 5초 후
- 2회: 10초 후  
- 최대 5회 후 포기 (다음 메시지 도착 시 재시도)

---

## 관련 문서

- [`security-model.md`](./security-model.md) — 보안 계층 상세
- [`container-lifecycle.md`](./container-lifecycle.md) — 컨테이너 생명주기 상세
- [`../reference/sdk-deep-dive.md`](../reference/sdk-deep-dive.md) — Claude SDK 심층 분석

*업데이트: 2026-02-25*
