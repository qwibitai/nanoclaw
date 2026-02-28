# NanoClaw 아키텍처 분석 — 심화 보완편

> 이 문서는 `ARCHITECTURE_ANALYSIS_ko.md` 의 보완편으로, 리뷰어가 지적한 미흡 부분을 상세히 다룹니다.

---

## 보완 1. 컨테이너 실행 상세 (`container-runner.ts`)

### 1.1 볼륨 마운트 구성 (`buildVolumeMounts`)

`runContainerAgent()` 호출 시 그룹 유형에 따라 다음 마운트 목록이 구성됩니다:

#### 메인 그룹 마운트 목록

| #   | 호스트 경로                            | 컨테이너 경로        | R/W          |
| --- | -------------------------------------- | -------------------- | ------------ |
| 1   | `{projectRoot}/`                       | `/workspace/project` | **ReadOnly** |
| 2   | `groups/main/`                         | `/workspace/group`   | **R/W**      |
| 3   | `data/sessions/main/.claude/`          | `/home/node/.claude` | **R/W**      |
| 4   | `data/ipc/main/`                       | `/workspace/ipc`     | **R/W**      |
| 5   | `data/sessions/main/agent-runner-src/` | `/app/src`           | **R/W**      |

#### 비메인 그룹 마운트 목록

| #   | 호스트 경로                                | 컨테이너 경로             | R/W                            |
| --- | ------------------------------------------ | ------------------------- | ------------------------------ |
| 1   | `groups/{folder}/`                         | `/workspace/group`        | **R/W**                        |
| 2   | `groups/global/`                           | `/workspace/global`       | **ReadOnly**                   |
| 3   | `data/sessions/{folder}/.claude/`          | `/home/node/.claude`      | **R/W**                        |
| 4   | `data/ipc/{folder}/`                       | `/workspace/ipc`          | **R/W**                        |
| 5   | `data/sessions/{folder}/agent-runner-src/` | `/app/src`                | **R/W**                        |
| 6+  | `additionalMounts` (설정 시)               | `/workspace/extra/{name}` | 설정값 (비메인: 강제 ReadOnly) |

> **주의**: `groups/global/` 디렉토리는 파일(`CLAUDE.md`)이 아닌 **디렉토리** 단위로만 마운트됩니다.  
> Apple Container(macOS native)는 파일 단위 바인드 마운트를 지원하지 않기 때문입니다.

### 1.2 `agent-runner-src` 개별 복사 (중요 설계 결정)

```typescript
// 컨테이너 실행 전, agent-runner 소스를 그룹별 디렉토리에 복사
const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', group.folder, 'agent-runner-src');

// 최초 1회만 복사 (이후엔 그룹이 자유롭게 수정 가능)
if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
  fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
}
```

**의도**: 각 그룹의 Claude가 `/app/src/` 의 agent-runner 코드를 수정하여 **자신만의 도구나 동작**을 추가할 수 있습니다. 이 변경은 다른 그룹에 영향을 미치지 않습니다. 컨테이너 시작 시 `entrypoint.sh`가 TypeScript를 재빌드합니다.

### 1.3 Docker 명령어 구성 (`buildContainerArgs`)

최종적으로 생성되는 실행 명령어 구조:

```bash
docker run \
  -i \                                    # stdin 대화형 모드 (파이핑용)
  --rm \                                  # 종료 시 컨테이너 자동 삭제
  --name nanoclaw-devteam-1708812345678 \ # 고유 이름 (타임스탬프 포함)
  -e TZ=Asia/Seoul \                      # 호스트 타임존 전달
  --user 1000:1000 \                      # 호스트 UID:GID (파일 소유권 일치)
  -e HOME=/home/node \                    # node 유저로 홈 디렉토리 설정
  --mount "type=bind,source=/abs/groups/devteam,target=/workspace/group,readonly" \
  -v /abs/groups/global:/workspace/global \  # R/W는 -v, RO는 --mount
  -v /abs/data/sessions/devteam/.claude:/home/node/.claude \
  -v /abs/data/ipc/devteam:/workspace/ipc \
  -v /abs/data/sessions/devteam/agent-runner-src:/app/src \
  nanoclaw-agent:latest
```

> **읽기전용 마운트 주의**: `:ro` 접미사 대신 `--mount ...,readonly` 형식을 사용합니다.  
> Apple Container(macOS)에서 `:ro` 구문이 동작하지 않는 버그가 있기 때문입니다.

### 1.4 stdin 시크릿 주입

```typescript
// 시크릿 읽기 (.env 파일에서)
input.secrets = readSecrets();  // { ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN }

// stdin으로 전송 (파일 시스템에 기록 없음)
container.stdin.write(JSON.stringify(input));
container.stdin.end();

// 로그 오염 방지를 위해 메모리에서도 제거
delete input.secrets;
```

### 1.5 스트리밍 출력 파싱

```
stdout 스트림이 들어올 때마다 parseBuffer에 누적 → 마커 쌍 탐색:

parseBuffer: "...다른 텍스트...---NANOCLAW_OUTPUT_START---\n{JSON}\n---NANOCLAW_OUTPUT_END---...다음..."
              ↑ 앞 부분 무시      ↑ startIdx                                  ↑ endIdx

완전한 쌍 발견 시:
  jsonStr 추출 → JSON.parse() → ContainerOutput 객체
  → onOutput(parsed) 비동기 콜백 (outputChain으로 순서 보장)
  → newSessionId가 포함되면 추출하여 보관
  → resetTimeout() 호출 (활동이 있으면 타임아웃 리셋)
```

**중요**: `stderr`(SDK 디버그 로그) → 타임아웃 리셋 안 함. `stdout`의 OUTPUT_MARKER만 활동으로 인정합니다.

### 1.6 타임아웃 관리

```
timeoutMs = max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30초)

기본값: max(30분, 30분+30초) = 30분 30초

타임아웃 발생 시:
  → docker stop {containerName} (graceful, 15초 대기)
  → 실패 시 container.kill('SIGKILL')

결과 분기:
  hadStreamingOutput = true → "idle cleanup" → status: 'success'
  hadStreamingOutput = false → "no output timeout" → status: 'error'
```

---

## 보완 2. 메시지 포맷 (`router.ts`)

### 2.1 `formatMessages()` 출력 예시

사용자 메시지들을 XML 구조로 변환합니다:

```xml
<messages>
<message sender="홍길동" time="2026-02-25T00:45:00.000Z">@Andy 오늘 날씨 어때?</message>
<message sender="이영희" time="2026-02-25T00:45:10.000Z">서울 기준으로 알려줘</message>
</messages>
```

- `sender_name`, `content` 모두 XML 이스케이프 처리 (`&` → `&amp;`, `<` → `&lt;`)
- 봇 메시지(`is_bot_message=1`)는 DB 조회 시 이미 필터링되어 포함되지 않음

### 2.2 `<internal>` 태그 필터링

Claude가 응답하기 전에 내부 추론 단계를 `<internal>` 태그로 감쌀 수 있으며, 이는 사용자에게 전달되기 전 제거됩니다:

```typescript
// Claude 응답 예시:
// "<internal>사용자가 날씨를 묻고 있음. 현재 서울 날씨 도구를 사용해야 함.</internal>서울 현재 기온은 3°C 입니다."

// 처리 후 사용자에게 전달되는 텍스트:
// "서울 현재 기온은 3°C 입니다."
raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim()
```

---

## 보완 3. 채널 추상화 (`src/channels/`)

### 3.1 Channel 인터페이스

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;      // 이 채널이 해당 JID를 담당하는가?
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;  // 선택적
}
```

### 3.2 채널 라우팅 원리

```typescript
// 각 채널이 JID 형식으로 소유권 판별
// WhatsApp: JID = "1234567890@g.us" (그룹), "1234567890@s.whatsapp.net" (개인)
// Telegram:  JID = "tg:123456789"
// Discord:   JID = "dc:987654321"

findChannel(channels, jid)
  → channels.find(c => c.ownsJid(jid))
```

### 3.3 WhatsApp 연결 (`whatsapp-auth.ts`)

baileys 라이브러리를 사용하는 WhatsApp 연결 특이사항:

- QR 코드 인증 시 `store/auth/` 에 세션 저장
- 캐시 무효화 시 재인증 필요
- 그룹 메타데이터(이름)는 별도 `syncGroupMetadata()` 호출로 동기화
- JID 형식: `{전화번호}@g.us` (그룹), `{전화번호}@s.whatsapp.net` (1:1)

---

## 보완 4. 세션 연속성 메커니즘

### 4.1 Claude 세션 ID 추적

```
컨테이너 최초 실행:
  sessionId = undefined → Claude SDK가 새 세션 생성
  → system init 메시지에서 session_id 추출
  → writeOutput({ newSessionId: "abc-123" })

호스트:
  output.newSessionId → sessions["devteam"] = "abc-123"
  setSession("devteam", "abc-123") → DB 저장

다음 실행:
  sessionId = sessions["devteam"] = "abc-123"
  → query({ options: { resume: "abc-123", resumeSessionAt: lastAssistantUuid } })
  → 이전 대화 컨텍스트 이어받기
```

### 4.2 `resumeAt` 의 역할

```typescript
// 같은 컨테이너 내에서 여러 쿼리를 실행할 때:
// 첫 번째 쿼리 완료 후 마지막 assistant 메시지 UUID를 저장
if (message.type === 'assistant' && 'uuid' in message) {
  lastAssistantUuid = message.uuid;
}

// 두 번째 쿼리 시 이 UUID부터 이어받기 (중복 컨텍스트 방지)
query({ options: { resume: sessionId, resumeSessionAt: lastAssistantUuid } })
```

**목적**: 긴 대화에서 컨텍스트 압축(compaction)이 발생했을 때도 정확한 지점부터 이어받을 수 있도록 합니다.

---

## 보완 5. MCP 서버 (`ipc-mcp-stdio.js`)

### 5.1 역할

컨테이너 내 Claude가 IPC 명령을 자연스럽게 실행할 수 있도록 **MCP(Model Context Protocol) 도구**로 노출합니다.

```typescript
// 컨테이너 내부에서 Claude가 사용하는 mcp__nanoclaw__* 도구들:
mcp__nanoclaw__send_message(chatJid, text)         // 그룹에 메시지 전송
mcp__nanoclaw__schedule_task(prompt, schedule, target) // 태스크 예약
mcp__nanoclaw__cancel_task(taskId)                 // 태스크 취소
mcp__nanoclaw__register_group(jid, name, folder)   // 그룹 등록 (메인만)
```

### 5.2 MCP 서버 실행 방식

```typescript
// agent-runner가 query() 호출 시 MCP 서버를 subprocess로 시작
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],  // ipc-mcp-stdio.js
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
}
```

MCP 서버는 IPC 파일을 `/workspace/ipc/messages/` 또는 `/workspace/ipc/tasks/`에 작성하고, 호스트 IPC Watcher가 이를 처리합니다.

---

## 보완 6. 에러 복구 시나리오

### 6.1 정상 흐름 vs 에러 흐름

```
정상 흐름:
  processGroupMessages()
  → lastAgentTimestamp 전진 (낙관적)
  → runAgent() → 'success'
  → 커서 유지 → 완료

에러 흐름 A (응답 전송 전 에러):
  → runAgent() → 'error'
  → outputSentToUser = false
  → lastAgentTimestamp 롤백 (이전 값으로 복원)
  → GroupQueue → scheduleRetry() (지수 백오프)
  → 최대 5회 재시도 후 포기 → 다음 메시지 수신 시 다시 시도

에러 흐름 B (응답 전송 후 에러):
  → runAgent() → 'error'
  → outputSentToUser = true
  → 커서 롤백 안 함 (중복 전송 방지)
  → 로그에 경고 기록
```

### 6.2 시작 시 복구 (`recoverPendingMessages`)

```
시스템 재시작 시:
  → loadState() → lastTimestamp, lastAgentTimestamp DB 복원
  → recoverPendingMessages():
    for each registeredGroup:
      pending = getMessagesSince(lastAgentTimestamp[group])
      if pending.length > 0:
        queue.enqueueMessageCheck(chatJid)  ← 재처리 예약

# 두 커서 간 갭이 발생하는 경우:
# lastTimestamp가 전진했지만, lastAgentTimestamp는 아직 구 값
# → 미처리 메시지 자동 재발견
```

---

## 보완 7. settings.json 자동 생성

컨테이너의 Claude 설정이 자동으로 구성됩니다:

```json
// data/sessions/{groupFolder}/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
```

| 설정                                 | 효과                                                    |
| ------------------------------------ | ------------------------------------------------------- |
| `AGENT_TEAMS=1`                      | Task, TaskOutput, TeamCreate 등 agent swarm 도구 활성화 |
| `ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` | `/workspace/extra/*` 의 CLAUDE.md 자동 로딩             |
| `DISABLE_AUTO_MEMORY=0`              | Claude의 자동 기억 기능 활성화                          |

이 파일은 **최초 1회** 생성되므로, 이후 그룹의 Claude가 직접 수정하여 자신의 컨테이너 동작을 조정할 수 있습니다.

---

## 최종 검토: 문서 커버리지

| 항목                  | 본문 | 보완편 | 완성도 |
| --------------------- | ---- | ------ | ------ |
| 전체 아키텍처         | ✅    | -      | ★★★★★  |
| 메시지 처리 흐름      | ✅    | -      | ★★★★★  |
| 볼륨 마운트 상세      | ⚠️    | ✅      | ★★★★★  |
| Docker 명령어 구성    | ❌    | ✅      | ★★★★☆  |
| stdout 파싱 프로토콜  | ⚠️    | ✅      | ★★★★★  |
| 보안 계층             | ✅    | -      | ★★★★★  |
| IPC 메커니즘          | ✅    | ✅      | ★★★★★  |
| 세션 연속성           | ⚠️    | ✅      | ★★★★★  |
| 에러 복구             | ⚠️    | ✅      | ★★★★★  |
| 스킬 엔진             | ✅    | -      | ★★★★☆  |
| 채널 추상화           | ❌    | ✅      | ★★★★☆  |
| MCP 서버              | ❌    | ✅      | ★★★★☆  |
| DB 스키마             | ✅    | -      | ★★★★★  |
| 타임아웃 관리         | ❌    | ✅      | ★★★★★  |
| agent-runner-src 복사 | ❌    | ✅      | ★★★★★  |
| settings.json 자동    | ❌    | ✅      | ★★★★☆  |

*리뷰어 최종 판정: **승인** — 본문 + 보완편으로 프로젝트를 처음 보는 SW 설계자가 전체 구조와 핵심 구현을 모두 이해할 수 있는 수준의 분석 문서가 완성되었습니다.*

---

*작성일: 2026-02-25*
