# NanoClaw MCP 가이드

NanoClaw의 MCP (Model Context Protocol) 서버 사용 및 관리 방법에 대한 종합 가이드입니다.

---

## 목차

1. [일반적인 MCP vs NanoClaw MCP](#일반적인-mcp-vs-nanoclaw-mcp)
2. [Built-in MCP 도구 목록](#built-in-mcp-도구-목록)
3. [Built-in MCP 확인 방법](#built-in-mcp-확인-방법)
4. [외부 MCP 서버 추가 방법](#외부-mcp-서버-추가-방법)
5. [MCP 동작 원리](#mcp-동작-원리)

---

## 일반적인 MCP vs NanoClaw MCP

### 일반적인 Claude Code MCP

**설정 파일 기반 관리**:
```json
// .claude/mcp.json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN": "ghp_..."
      }
    }
  }
}
```

**특징**:
- ✅ 설정 파일로 간편하게 관리
- ✅ 재시작 없이 MCP 서버 추가/제거 가능
- ❌ 동적 환경변수 주입 어려움
- ❌ 컨텍스트별 다른 설정 불가능

### NanoClaw MCP

**코드 기반 런타임 등록**:
```typescript
// container/agent-runner/src/index.ts
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,      // 동적 주입!
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
}
```

**특징**:
- ✅ 그룹별 다른 컨텍스트 주입 가능
- ✅ 런타임에 동적으로 환경 설정
- ✅ 각 컨테이너가 독립된 MCP 인스턴스 사용
- ❌ 코드 수정 + 재빌드 필요
- ❌ 설정 파일 없음 (코드로만 관리)

### 비교표

| 항목 | 일반 Claude Code | NanoClaw |
|------|------------------|----------|
| **설정 방식** | `.claude/mcp.json` | 코드 내 `mcpServers` 객체 |
| **설정 위치** | 프로젝트 루트 | `container/agent-runner/src/index.ts` |
| **환경변수** | 정적 (설정 파일) | 동적 (런타임 주입) |
| **컨텍스트 격리** | 전역 공유 | 그룹별 독립 |
| **수정 반영** | 즉시 | 재빌드 + 재시작 |
| **관리 용이성** | 높음 | 낮음 (코드 수정 필요) |
| **유연성** | 낮음 | 높음 (동적 설정) |

---

## Built-in MCP 도구 목록

NanoClaw에는 `nanoclaw` MCP 서버가 내장되어 있으며, 다음 도구들을 제공합니다.

### 전체 도구 목록

| 도구 | 설명 | 파일 위치 |
|------|------|----------|
| `send_message` | 즉시 메시지 전송 (진행 상황 업데이트용) | [ipc-mcp-stdio.ts:42](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L42) |
| `schedule_task` | 작업 스케줄링 (1회/반복/cron) | [ipc-mcp-stdio.ts:65](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L65) |
| `list_tasks` | 스케줄된 작업 목록 조회 | [ipc-mcp-stdio.ts:152](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L152) |
| `pause_task` | 작업 일시 정지 | [ipc-mcp-stdio.ts:190](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L190) |
| `resume_task` | 작업 재개 | [ipc-mcp-stdio.ts:209](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L209) |
| `cancel_task` | 작업 취소 및 삭제 | [ipc-mcp-stdio.ts:228](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L228) |
| `register_group` | 새 WhatsApp 그룹 등록 (메인만 가능) | [ipc-mcp-stdio.ts:247](../../../container/agent-runner/src/ipc-mcp-stdio.ts#L247) |

### 에이전트가 보는 도구 이름

에이전트 입장에서는 `mcp__nanoclaw__` 접두사가 붙습니다:

```
mcp__nanoclaw__send_message
mcp__nanoclaw__schedule_task
mcp__nanoclaw__list_tasks
mcp__nanoclaw__pause_task
mcp__nanoclaw__resume_task
mcp__nanoclaw__cancel_task
mcp__nanoclaw__register_group
```

### 주요 도구 상세 설명

#### 1. send_message

**용도**: 에이전트가 실행 중에 즉시 메시지 전송

**파라미터**:
- `text` (string): 전송할 메시지 텍스트
- `sender` (string, optional): 발신자 역할 이름 (Agent Swarm용)

**사용 예시**:
```
사용자: "내일 아침 운동할일을 알려줘"
에이전트: schedule_task 호출 → "알림을 내일 아침 7시로 설정했습니다"
```

#### 2. schedule_task

**용도**: 작업 스케줄링

**파라미터**:
- `prompt` (string): 실행할 작업 내용
- `schedule_type` (enum): `once` | `cron` | `interval`
- `schedule_value` (string): 스케줄 값
  - `once`: `"2026-03-01T07:00:00"` (로컬 시간, Z 접미사 없음)
  - `cron`: `"0 9 * * *"` (매일 오전 9시)
  - `interval`: `"3600000"` (밀리초, 1시간)
- `context_mode` (enum): `group` | `isolated`
  - `group`: 대화 기록 포함 실행
  - `isolated`: 독립 실행 (컨텍스트 없음)
- `target_group_jid` (string, optional): 대상 그룹 JID (메인만 가능)

**사용 예시**:
```javascript
{
  prompt: "운동할 시간이라고 알려주세요",
  schedule_type: "once",
  schedule_value: "2026-03-01T07:00:00",
  context_mode: "isolated"
}
```

#### 3. list_tasks

**용도**: 스케줄된 작업 목록 조회

**권한**:
- 메인 그룹: 모든 작업 조회 가능
- 일반 그룹: 자신의 작업만 조회 가능

---

## Built-in MCP 확인 방법

### 1. 코드에서 직접 확인

가장 확실한 방법:

```bash
# 모든 MCP 도구 정의 찾기
grep -n "^server.tool(" container/agent-runner/src/ipc-mcp-stdio.ts

# 도구 이름만 추출
awk "/^server.tool\(/ {getline; print}" container/agent-runner/src/ipc-mcp-stdio.ts
```

**출력 예시**:
```
'send_message',
'schedule_task',
'list_tasks',
'pause_task',
'resume_task',
'cancel_task',
'register_group',
```

### 2. 에이전트에게 직접 질문

WhatsApp/Telegram에서:

```
"너가 사용할 수 있는 nanoclaw 도구들을 알려줘"
```

에이전트가 `ToolSearch` 기능으로 자동으로 목록을 알려줍니다.

### 3. 허용된 도구 목록 확인

[container/agent-runner/src/index.ts:428-436](../../../container/agent-runner/src/index.ts#L428-L436):

```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'ToolSearch', 'Skill',
  'NotebookEdit',
  'mcp__nanoclaw__*'  // ← 모든 nanoclaw MCP 도구 허용
],
```

---

## 외부 MCP 서버 추가 방법

NanoClaw에서도 외부 MCP 서버를 추가할 수 있지만, 코드 수정이 필요합니다.

### HTTP MCP 서버 추가 예시

[.claude/skills/add-parallel/SKILL.md](../../../.claude/skills/add-parallel/SKILL.md)의 Parallel AI MCP 추가 예시:

**1. 환경변수 추가** (`.env`):
```bash
PARALLEL_API_KEY=your_api_key_here
```

**2. 환경변수를 컨테이너에 전달** (`src/container-runner.ts`):
```typescript
const allowedVars = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'PARALLEL_API_KEY'  // ← 추가
];
```

**3. MCP 서버 등록** (`container/agent-runner/src/index.ts`):
```typescript
const mcpServers: Record<string, any> = {
  nanoclaw: ipcMcp  // 기존 내장 MCP
};

// 외부 HTTP MCP 추가
const parallelApiKey = process.env.PARALLEL_API_KEY;
if (parallelApiKey) {
  mcpServers['parallel-search'] = {
    type: 'http',  // ⚠️ 필수: HTTP MCP는 type 명시
    url: 'https://search-mcp.parallel.ai/mcp',
    headers: {
      'Authorization': `Bearer ${parallelApiKey}`
    }
  };
}
```

**4. 허용 도구 목록에 추가**:
```typescript
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'mcp__nanoclaw__*',
  'mcp__parallel-search__*',  // ← 추가
],
```

**5. 컨테이너 재빌드**:
```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
```

### Stdio MCP 서버 추가 예시

일반적인 `.claude/mcp.json` 형식의 stdio MCP 서버도 추가 가능:

```typescript
// Filesystem MCP 추가
mcpServers['filesystem'] = {
  command: 'npx',
  args: [
    '-y',
    '@modelcontextprotocol/server-filesystem',
    '/workspace/group'
  ]
};

// GitHub MCP 추가
const githubToken = process.env.GITHUB_TOKEN;
if (githubToken) {
  mcpServers['github'] = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_TOKEN: githubToken
    }
  };
}
```

### 추가 시 주의사항

⚠️ **HTTP MCP 서버는 반드시 `type: 'http'` 명시**
- 없으면 컨테이너가 hang되거나 타임아웃 발생

⚠️ **환경변수 전달 경로**
1. `.env` 파일에 추가
2. `src/container-runner.ts`의 `allowedVars`에 추가
3. `container/agent-runner/src/index.ts`에서 `process.env`로 접근

⚠️ **재빌드 필수**
- MCP 서버 설정은 컨테이너 빌드 시점에 결정됨
- 변경 시 `./container/build.sh` 재실행 필요

---

## MCP 동작 원리

### 1. MCP 서버 생성 과정

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 호스트: 메시지 수신 (src/index.ts)                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. 컨테이너 생성 (src/container-runner.ts)                 │
│    - 환경변수 주입 (chatJid, groupFolder, isMain)          │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 에이전트 실행 (container/agent-runner/src/index.ts)     │
│    - MCP 서버 등록 (mcpServers 객체)                       │
│    - 각 MCP에 env 전달                                      │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. MCP 서버 시작 (container/agent-runner/src/              │
│    ipc-mcp-stdio.ts)                                        │
│    - 환경변수에서 컨텍스트 읽기                             │
│    - 도구 등록 (server.tool)                                │
└─────────────────────────────────────────────────────────────┘
```

### 2. MCP 도구 호출 과정

```
┌─────────────────────────────────────────────────────────────┐
│ 1. 에이전트: mcp__nanoclaw__schedule_task 호출             │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. MCP 서버: IPC 파일 작성 (ipc-mcp-stdio.ts)              │
│    - /workspace/ipc/tasks/{timestamp}-{random}.json         │
│    - 컨텍스트 포함 (chatJid, groupFolder)                   │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. 호스트: IPC 파일 감지 (src/ipc.ts)                      │
│    - 파일 읽기 및 삭제                                      │
│    - DB에 작업 저장                                         │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. 스케줄러: 작업 실행 (src/task-scheduler.ts)             │
│    - 스케줄된 시간에 새 컨테이너 생성                       │
│    - 작업 실행 및 결과 전송                                 │
└─────────────────────────────────────────────────────────────┘
```

### 3. 그룹별 MCP 컨텍스트 격리

```
그룹 A 메시지 수신
  ↓
컨테이너 A 생성
  ↓
MCP 서버 A (env: chatJid=A, groupFolder=groupA)
  ↓
IPC: /workspace/ipc/tasks/xxx.json (groupFolder: groupA)
  ↓
호스트: DB에 groupA의 작업으로 저장


그룹 B 메시지 수신 (동시)
  ↓
컨테이너 B 생성 (독립!)
  ↓
MCP 서버 B (env: chatJid=B, groupFolder=groupB)
  ↓
IPC: /workspace/ipc/tasks/yyy.json (groupFolder: groupB)
  ↓
호스트: DB에 groupB의 작업으로 저장
```

**핵심**: 각 컨테이너가 독립된 MCP 서버 인스턴스를 가지므로, 환경변수를 통해 다른 컨텍스트를 주입할 수 있습니다.

---

## 요약

### NanoClaw MCP의 특징

✅ **런타임 동적 등록**: 코드에서 직접 MCP 서버 등록
✅ **컨텍스트 주입**: 그룹별 다른 환경변수 전달 가능
✅ **격리**: 각 컨테이너가 독립된 MCP 인스턴스 사용
❌ **설정 파일 없음**: `.claude/mcp.json` 미사용
❌ **코드 수정 필요**: 외부 MCP 추가 시 재빌드 필수

### 언제 MCP를 추가해야 하나?

- **내장 도구로 부족할 때**: 파일시스템, GitHub, 데이터베이스 등
- **외부 API 연동**: Parallel AI, Slack, Gmail 등
- **커스텀 기능**: 사용자 정의 도구 필요 시

### 참고 자료

- [Built-in MCP 서버 코드](../../../container/agent-runner/src/ipc-mcp-stdio.ts)
- [MCP 서버 등록 코드](../../../container/agent-runner/src/index.ts)
- [Parallel AI MCP 추가 예시](../../../.claude/skills/add-parallel/SKILL.md)
- [NanoClaw 스펙 문서](../../docs/SPEC.md)
