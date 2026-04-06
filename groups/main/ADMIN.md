# NanoClaw Admin Guide

이 문서는 `nanoclaw_admin #main` 채널 운영용이다.  
목적은 두 가지다.

1. NanoClaw 전체 상태를 빠르게 확인한다.
2. 문제가 생겼을 때 어디서 원인을 확인하고 어떻게 복구할지 바로 찾는다.

## Scope

이 문서의 기준 환경:

- `PROJECT_ROOT=/path/to/nanoclaw`
- `MAIN_JID=dc:<main-admin-channel-id>`
- `MAIN_GROUP_FOLDER=discord_main`
- `SERVICE_NAME=com.nanoclaw`

아래 예시는 이 값을 shell 변수로 export 하거나 직접 문자열 치환해서 사용한다.

운영 원칙:

- `#admin` 채널은 `nanoclaw_admin` 전용 채널로 본다.
- 일반 Claude 작업 채널과 관리자 채널의 역할을 섞지 않는다.
- 코드 작업은 브랜치마다 별도 `git worktree`를 만들어 진행한다.
- 설정 변경 후 런타임 반영이 필요하면 빌드 + 서비스 재시작까지 해야 한다.

## First Checks

문제가 생기면 이 순서로 본다.

1. 서비스가 떠 있는지 확인
2. 최근 로그에 에러가 있는지 확인
3. DB 커서와 세션 상태 확인
4. 특정 채널이 pause 상태인지 확인
5. 특정 에이전트만 문제인지, 전체 서비스 문제인지 분리

## Service Health

### launchd 상태

```bash
launchctl print gui/$(id -u)/$SERVICE_NAME
```

중요하게 볼 것:

- `state = running`
- `pid = ...`
- `last exit code = (never exited)` 또는 최근 비정상 종료 코드
- `program = /opt/homebrew/bin/node`
- `arguments = $PROJECT_ROOT/dist/index.js`

### 프로세스 확인

```bash
ps -axo pid,ppid,etime,command | rg "dist/index.js|agent-runner|codex-runner|copilot|gemini|claude"
```

### 로그

```bash
tail -n 120 "$PROJECT_ROOT/logs/nanoclaw.log"
tail -n 120 "$PROJECT_ROOT/logs/nanoclaw.error.log"
```

주요 패턴:

- `Discord bot connected`
- `Processing messages`
- `Agent output`
- `Scheduling retry with backoff`
- `Max retries exceeded`
- `Codex host runner timed out`
- `rate_limit_event`

## Database Checks

DB 파일:

- `$PROJECT_ROOT/store/messages.db`

### 등록된 채널 / 에이전트

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  select jid, name, folder, agent_type, is_main, paused_until
  from registered_groups
  order by jid, agent_type;
"
```

이걸로 알 수 있는 것:

- 어떤 JID가 어떤 에이전트에 매핑됐는지
- paired room인지
- main 채널인지
- pause 상태인지

### 라우터 커서 상태

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  select key, value from router_state;
"
```

핵심 키:

- `last_timestamp`: 전체 메시지 루프가 어디까지 읽었는지
- `last_agent_timestamp`: 채널별 실제 처리 커서

메시지가 저장됐는데 답변이 없으면:

- `messages`에는 들어왔는지
- `last_agent_timestamp`가 너무 앞으로 가버렸는지
- 실패 시 롤백이 됐는지
를 같이 본다.

### 최근 메시지

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  select id, chat_jid, sender_name, content, timestamp, is_bot_message
  from messages
  where chat_jid = '$MAIN_JID'
  order by timestamp desc
  limit 20;
"
```

특정 채널 JID로 바꿔서 확인한다.

### 세션 상태

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  select group_folder, agent_type, session_id
  from sessions
  order by group_folder, agent_type;
"
```

용도:

- 꼬인 세션 확인
- Codex resume thread가 계속 hang 나는지 확인
- 새 세션 강제 시작 전 상태 확인

### work_items 상태

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  select id, group_folder, chat_jid, agent_type, status, delivery_attempts, last_error, created_at, updated_at
  from work_items
  order by id desc
  limit 20;
"
```

이건 paired room 후속 발송, 재전송 실패 추적에 쓴다.

## Known Failure Modes

### 1. Claude rate limit

로그 패턴:

- `rate_limit_event`
- `Claude host runner detected an unavailable state`

영향:

- admin 채널이나 all-hands의 Claude planner가 실패

대응:

- 잠시 기다리거나
- 다른 planner/worker fallback이 있는 채널인지 확인
- 급하면 pause 또는 별도 채널로 우회

### 2. Codex timeout

로그 패턴:

- `Codex host runner timed out`
- `Scheduling retry with backoff`
- `Max retries exceeded`

대응:

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  delete from sessions where agent_type = 'codex';
"
```

그 후 서비스 재시작 또는 다음 메시지로 fresh session 유도.

### 3. Gemini PATH / launchd 환경 문제

증상:

- `env: node: No such file or directory`

의미:

- launchd 환경 PATH가 짧아서 host CLI가 내부 `node`를 못 찾음

현재 코드에서 `/opt/homebrew/bin` 보정이 들어가 있으므로, 빌드 후 재시작이 반영됐는지 먼저 본다.

### 4. launchd plist 템플릿 상태로 남아 있음

증상:

- `{{NODE_PATH}}`, `{{PROJECT_ROOT}}` 같은 placeholder가 launchctl print에 그대로 보임
- `last exit code = 78: EX_CONFIG`

대응:

```bash
cd "$PROJECT_ROOT"
npm run setup -- --step service
launchctl bootout gui/$(id -u)/$SERVICE_NAME || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
```

## Recovery Procedures

### 코드 변경 반영

```bash
cd "$PROJECT_ROOT"
npm run build
npm run build:runners
launchctl bootout gui/$(id -u)/$SERVICE_NAME || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/$SERVICE_NAME.plist"
```

### 미처리 메시지 재복구

특정 채널의 `last_agent_timestamp`를 이전 시점으로 되돌린 뒤 재시작한다.

예시:

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  update router_state
  set value = json_set(value, '$.\"'"$MAIN_JID"'\"', '2026-03-31T09:45:13.161Z')
  where key = 'last_agent_timestamp';
"
```

그 다음 재시작하면 `recoverPendingMessages()`가 다시 집는다.

### Codex 세션 초기화

```bash
sqlite3 "$PROJECT_ROOT/store/messages.db" "
  delete from sessions where agent_type = 'codex';
"
```

### main/admin 채널만 별도 관리하고 싶을 때 확인할 것

현재 목표 상태:

- `discord-admin` 채널 팩토리: `DISCORD_BOT_TOKEN`
- `discord` 채널 팩토리: `DISCORD_CLAUDE_BOT_TOKEN`
- main 채널은 admin bot만 송수신
- non-main Claude 채널은 일반 Claude bot이 담당

확인 포인트:

- `src/channels/discord.ts`
- `src/channels/registry.test.ts`
- `registered_groups.is_main`

### admin 채널 명령

`nanoclaw_admin` 채널에서 바로 쓸 수 있는 핵심 운영 명령:

```text
/status
/model status
/model claude
/model claude sonnet
/model claude opus
/model claude ollama
/model codex
/model codex gpt-5.4 high
/model reset
```

의미:

- `/status` — 현재 admin 채널의 backend, 세션, 큐 상태, cursor 확인
- `/model claude` — `nanoclaw_admin`의 응답 엔진을 Claude로 전환
- `/model claude sonnet|opus|ollama` — Claude provider/model preset 전환
- `/model codex` — `nanoclaw_admin`의 응답 엔진을 Codex로 전환
- `/model ... <model> <effort>` — 런타임 override
- `/model reset` — model/effort override 제거

중요:

- 답변 주체는 항상 `nanoclaw_admin`
- 바뀌는 건 내부 executor뿐
- 대화 맥락은 같은 `messages.db`를 계속 사용

## Files Worth Knowing

- 서비스 로그: `$PROJECT_ROOT/logs/nanoclaw.log`
- 서비스 에러 로그: `$PROJECT_ROOT/logs/nanoclaw.error.log`
- DB: `$PROJECT_ROOT/store/messages.db`
- 메인 그룹 지시문: `$PROJECT_ROOT/groups/main/CLAUDE.md`
- 이 문서: `$PROJECT_ROOT/groups/main/ADMIN.md`
- 관리자 스킬: `$PROJECT_ROOT/container/skills/nanoclaw-admin/SKILL.md`
- 상태 스킬: `$PROJECT_ROOT/container/skills/status/SKILL.md`
- Discord 채널 분기: `$PROJECT_ROOT/src/channels/discord.ts`
- 메시지 루프: `$PROJECT_ROOT/src/index.ts`
- paired room 오케스트레이션: `$PROJECT_ROOT/src/services/paired-room-service.ts`

## Recommended Admin Workflow

관리 채널에서 상태를 볼 때는 보통 이렇게 한다.

1. `launchctl print`로 서비스 확인
2. `tail logs/nanoclaw.log`로 최근 100줄 확인
3. DB에서 `registered_groups`, `router_state`, `sessions` 확인
4. 특정 채널 메시지가 누락됐으면 `messages`와 `last_agent_timestamp` 대조
5. 필요 시 세션 삭제, 커서 롤백, 재시작

## Notes

- `.env` 값 변경은 런타임 재시작이 필요하다.
- host CLI 계열 변경은 `npm run build`만으로 끝나지 않고, 실제 서비스 재시작이 필요하다.
- paired room은 실패 시 커서 롤백이 중요하다. 이 부분이 깨지면 메시지가 “처리된 척” 사라질 수 있다.

## Git Rules

- 기능 작업은 `feat/<summary>` 브랜치에서 진행하고, 끝나면 PR로 올린다.
- 의미 있는 단위마다 바로 커밋한다.
- 로컬 비밀값과 개인 설정은 커밋하지 않는다. 실제 값은 로컬 파일에만 둔다.
- hook이 기본 점검을 자동 수행한다.
  - `pre-commit`: secret/file 검사 + staged 파일 lint
  - `pre-push`: typecheck + test
