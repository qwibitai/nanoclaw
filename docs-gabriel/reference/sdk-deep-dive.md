# Claude 에이전트 SDK 심층 분석 (Deep Dive)

이 문서는 에이전트 팀(`agent teams`)의 하위 에이전트(subagents)들이 중간에 의문사(killed)하는 문제를 해결하기 위해, `@anthropic-ai/claude-agent-sdk` v0.2.29–0.2.34 버전을 리버스 엔지니어링하여 `query()`가 어떻게 작동하는지 분석한 결과와 공식 SDK 참조 문서를 보충하여 정리한 내용입니다.

## 아키텍처 구조

```
Agent Runner (우리가 작성한 코드)
  └── query() 호출 → SDK (sdk.mjs 로 진입)
        └── 무언가 작업용 CLI 하위 프로세스를 생성함 (cli.js 실행)
              └── 이를 통해 Claude API 호출 및 도구들(tools) 실행
              └── Task 도구 호출 시 → 또 다른 하위 에이전트 프로세스 생성
```

SDK는 터미널 옵션(`--output-format stream-json --input-format stream-json --print --verbose`)을 붙여 자식 프로세스 형태로 `cli.js`를 구동합니다. 이 둘은 표준 입출력(stdin/stdout)을 통한 JSON-lines 형식으로 통신합니다.

`query()`는 비동기 리턴 제너레이터인 `AsyncGenerator<SDKMessage, void>`를 상속받는 `Query` 객체를 반환합니다. 동작 과정은 이렇습니다:

- SDK가 자식 프로세스로 CLI를 생성하고 JSON으로 통신.
- SDK의 `readMessages()` 함수가 CLI 출력(stdout)을 읽고 내부 스트림으로 줄세우기(enqueue)함.
- `readSdkMessages()` 비동기 제너레이터가 이 스트림에서 데이터를 내보냄(yield).
- `[Symbol.asyncIterator]` 호출 시 `readSdkMessages()`를 반환함.
- CLI 프로세스가 stdout을 닫아야만 이터레이터가 `done: true`를 반환하며 종료됨.

V1(`query()`)이나 V2(`createSession`/`send`/`stream`) 구조 모두 동일한 3계층 아키텍처를 사용합니다:

```
SDK 영역 (sdk.mjs)      CLI 프로세스 영역 (cli.js)
--------------          --------------------
XX Transport  ------>   stdin 리더(reader) 프로세스 (bd1)
  (cli.js 생성)            |
$X Query      <------   stdout 작성기(writer) 프로세스
  (JSON-lines 방식)        |
                        EZ() 재귀 반복함수(recursive generator)
                           |
                        Anthropic API 호출 (메시징 통신)
```

## 에이전트의 핵심 작업 루프 (EZ)

CLI 내부의 기본적인 에이전트 작동 루프는 단순한 while 반복문이 아니라, **`EZ()`라고 불리는 재귀형 비동기 제너레이터 함수**입니다:

```
EZ({ messages, systemPrompt, canUseTool, maxTurns, turnCount=1, ... })
```

이 루프가 한 번 호출되는 것은 곧 Claude로 한 번 API 통신(한번의 "차례(turn)")을 날리는 것을 의미합니다.

### 턴(Turn)별 작동 흐름:

1. **메시지 준비** — 기존 대화 문맥(Context)을 자르거나(trim), 원할 시 압축(compaction)합니다.
2. **Anthropic API 호출** — (`mW1` 이라는 스트리밍용 내부 함수를 통해 실행)
3. **추출** — API 응답값 속에서 도구 사용(`tool_use` 블록들)을 뽑아냅니다.
4. **분기(Branch) 처리:**
   - **`tool_use` 블록이 없다면** → 정지 (종료 훅(hook) 실행, 끝).
   - **`tool_use` 블록이 있다면** → 해당 툴들을 실행, 턴(turnCount) 수치 증가, 다시 EZ 자기 자신을 재귀 호출함.

이처럼 가장 복잡한 두뇌 로직(에이전트 루프, 툴 작동, 백그라운드 태스크, 팀메이트들과의 협동)은 전부 CLI의 하위 프로세스단에서 수행되며, 우리가 다루는 `query()`는 그저 얇은 입출력 포장지(단순 껍데기 전송용 wrapper)에 불과합니다.

## query() 옵션들

공식 문서에 명시된 주요 `Options` 타입 전체 정보입니다:

| 속성명                            | 타입                                                                   | 기본값                  | 설명                                                                                                                |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `abortController`                 | `AbortController`                                                      | `new AbortController()` | 작업 취소를 위한 컨트롤러                                                                                           |
| `additionalDirectories`           | `string[]`                                                             | `[]`                    | Claude가 접근할 추가 폴더 경로들                                                                                    |
| `agents`                          | `Record<string, AgentDefinition>`                                      | `undefined`             | 자체 정의할 하위 에이전트들 (협동팀 아님 — 일반 조율만 함)                                                          |
| `allowDangerouslySkipPermissions` | `boolean`                                                              | `false`                 | 권한 체크를 무시할 때 필요 (`permissionMode: 'bypassPermissions'`)                                                  |
| `allowedTools`                    | `string[]`                                                             | 전체 툴                 | 허가된 사용 가능 도구 리스트                                                                                        |
| `betas`                           | `SdkBeta[]`                                                            | `[]`                    | 베타 기능 적용 값 (예: 1M 토큰 컨텍스트용 `['context-1m-2025-08-07']`)                                              |
| `canUseTool`                      | `CanUseTool`                                                           | `undefined`             | 툴 사용 여부를 판단하는 커스텀 권한 체크 함수                                                                       |
| `continue`                        | `boolean`                                                              | `false`                 | 가장 마지막의 대화를 이어서 계속함 진행 여부                                                                        |
| `cwd`                             | `string`                                                               | `process.cwd()`         | 현재 실행 중인 기준 디렉토리 경로                                                                                   |
| `disallowedTools`                 | `string[]`                                                             | `[]`                    | 사용이 금지된 도구들 목록                                                                                           |
| `enableFileCheckpointing`         | `boolean`                                                              | `false`                 | 타임머신 역할(되감기용 파일 수정 추적) 활성화 여부                                                                  |
| `env`                             | `Dict<string>`                                                         | `process.env`           | 적용할 시스템 환경 변수들                                                                                           |
| `executable`                      | `'bun' \| 'deno' \| 'node'`                                            | 자동 감지               | 실행할 Javascript 런타임 유형 환경                                                                                  |
| `fallbackModel`                   | `string`                                                               | `undefined`             | 메인 모델 뻗었을 때 백업으로 호출할 예비 AI 모델 설정                                                               |
| `forkSession`                     | `boolean`                                                              | `false`                 | 재개 시켰을 경우 기존 건 놔두고 새로운 세션으로 파생되어 복제 분기(fork) 할지 여부                                  |
| `hooks`                           | `Partial<Record<HookEvent, HookCallbackMatcher[]>>`                    | `{}`                    | 훅 이벤트 발생 시 가로챌 콜백 함수 작동 설정                                                                        |
| `includePartialMessages`          | `boolean`                                                              | `false`                 | 스트리밍 같은 불완전 이벤트 메시지도 전부 포함 받을 건지 체크                                                       |
| `maxBudgetUsd`                    | `number`                                                               | `undefined`             | 이 쿼리에 소진할 수 있는 최대 비용 범위 (USD)                                                                       |
| `maxThinkingTokens`               | `number`                                                               | `undefined`             | 클로드가 답 생각하는 과정에 쓸 수 있는 최대 토큰 할당값                                                             |
| `maxTurns`                        | `number`                                                               | `undefined`             | 루프를 돌 최대 대화 횟수(turns) 한계치                                                                              |
| `mcpServers`                      | `Record<string, McpServerConfig>`                                      | `{}`                    | 연결할 MCP 서버 설정값들                                                                                            |
| `model`                           | `string`                                                               | CLI 기본값              | 사용할 Claude 모델 종류 지정                                                                                        |
| `outputFormat`                    | `{ type: 'json_schema', schema: JSONSchema }`                          | `undefined`             | 대답 받을 구조(Structured output) 포맷 형식 강제                                                                    |
| `pathToClaudeCodeExecutable`      | `string`                                                               | 내장된 경로             | 사용할 특별한 Claude Code 실행 파알 경로                                                                            |
| `permissionMode`                  | `PermissionMode`                                                       | `'default'`             | 명령 수행(퍼미션) 권한 수준 모드                                                                                    |
| `plugins`                         | `SdkPluginConfig[]`                                                    | `[]`                    | 로컬 경로에서 불러올 커스텀 플러그인 리스트                                                                         |
| `resume`                          | `string`                                                               | `undefined`             | 다시 불러와 재개 할 세션 ID 값                                                                                      |
| `resumeSessionAt`                 | `string`                                                               | `undefined`             | 재개 할 시점을 특정 메시지 아이디(UUID) 기준으로 정할 때 사용                                                       |
| `sandbox`                         | `SandboxSettings`                                                      | `undefined`             | 샌드박스의 구체적인 보안 행동 구성 세팅                                                                             |
| `settingSources`                  | `SettingSource[]`                                                      | `[]` (아무것도 안함)    | 어떤 파일 시스템 설정들(전역, 로컬)을 읽을 지 명시. 그룹 내 `CLAUDE.md`를 읽으려면 무조건 `'project'`를 지정해야 함 |
| `stderr`                          | `(data: string) => void`                                               | `undefined`             | 기본 표준오류(stderr) 출력을 잡을 콜백 지정                                                                         |
| `systemPrompt`                    | `string \| { type: 'preset'; preset: 'claude_code'; append?: string }` | `undefined`             | 시스템 프롬프트 부여. preset 사용 시 Claude Code의 내장 프롬프트를 깔고 그 뒤에 append 내용을 이어 붙임             |
| `tools`                           | `string[] \| { type: 'preset'; preset: 'claude_code' }`                | `undefined`             | 적용할 사용자 도구 설정                                                                                             |

### PermissionMode

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
```

### SettingSource

```typescript
type SettingSource = 'user' | 'project' | 'local';
// 'user'    → ~/.claude/settings.json
// 'project' → .claude/settings.json (현재 저장소의 파일)
// 'local'   → .claude/settings.local.json (깃에 안올라가는 로컬용 파일)
```

만약 이 옵션 항목이 비어있다면, SDK는 어떠한 파일 시스템 설정 정보도 읽지 않습니다 (기본적으로 완벽히 격리된 샌드박스 상태임을 의미).
적용되는 강도 우선순위(Precedence)는: local > project > user 순입니다. 스크립트 코드상 프로그래밍된 옵션 값들은 이 파일 설정값들보다 무조건 우선으로 덮어씁니다.

### AgentDefinition

일반적인 하위 서브 에이전트(프로그래밍적으로 설정한, 단순 개별 객체지 팀 협력용이 아님):

```typescript
type AgentDefinition = {
  description: string;  // 언제 이 에이전트를 써야 하는 지 설명
  tools?: string[];     // 허용된 도구 리스트 (비어있으면 전체 허용됨)
  prompt: string;       // 서브 에이전트에게 내릴 시스템 프롬프트(성격/지시)
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
}
```

### McpServerConfig

```typescript
type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sdk'; name: string; instance: McpServer }  // in-process 용 내부 통신
```

### SdkBeta

```typescript
type SdkBeta = 'context-1m-2025-08-07';
// 이 항목 지정 시 Opus 4.6, Sonnet 4.5, Sonnet 4에서 1M 개의 토큰 문맥 제한 허용됨
```

### CanUseTool

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[] }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```

## SDKMessage 분석 (이벤트 타입 종류)

`query()`는 16가지 타입의 메시지를 쏟아냅니다. 공식 SDK 문서엔 7가지만 심플하게 나오는데 뜯어본 내장 `sdk.d.ts` 파일에는 전체 종류가 다 적혀있습니다:

| Type(유형)         | Subtype (하위유형)    | 목적 (기능)                                                              |
| ------------------ | --------------------- | ------------------------------------------------------------------------ |
| `system`           | `init`                | 세션 시작 초기화. 포함되는 정보: 세션아이디, 연동 툴들 종류, 구동 모델명 |
| `system`           | `task_notification`   | 백그라운드 태스크 완수됨/실패/중지됨 알림                                |
| `system`           | `compact_boundary`    | 1단락의 대화압축이 들어갔음을 알림                                       |
| `system`           | `status`              | 압축 중 등 상태값 변경 발생                                              |
| `system`           | `hook_started`        | 특정 갈고리(훅) 이벤트가 감지되어 로직 실행 시작됨                       |
| `system`           | `hook_progress`       | 훅 처리 진행 현황                                                        |
| `system`           | `hook_response`       | 훅 갈고리 처리 무사 완료                                                 |
| `system`           | `files_persisted`     | 수정/생성 파일들 저장 완료됨                                             |
| `assistant`        | —                     | Claude쪽 대답 알림 (일반 텍스트 대답 + 툴 콜 백)                         |
| `user`             | —                     | 내가 친 유저 메시지 (내부용)                                             |
| `user` (replay)    | —                     | 정지된 세션 재개 시 이전에 쳤던 메시지 리플레이 정보                     |
| `result`           | `success` / `error_*` | 한 번의 턴이 최종적으로 끝났을 때 결과 정보                              |
| `stream_event`     | —                     | 스트림 진행 도중 정보들 (includePartialMessages 활성화 시 도출됨)        |
| `tool_progress`    | —                     | 실행이 오래걸리는 툴 작업의 현재 프로그래스 바/진행률 안내               |
| `auth_status`      | —                     | 인증 여부 권한 등 상태 변화                                              |
| `tool_use_summary` | —                     | 구동한 툴 들의 전반적 요약 리포트                                        |

### SDKTaskNotificationMessage (sdk.d.ts 확인: 줄번호 1507)

```typescript
type SDKTaskNotificationMessage = {
  type: 'system';
  subtype: 'task_notification';
  task_id: string;
  status: 'completed' | 'failed' | 'stopped';
  output_file: string;
  summary: string;
  uuid: UUID;
  session_id: string;
};
```

### SDKResultMessage (sdk.d.ts 확인: 줄번호 1375)

이 타입은 공유필드가 하나고 분기처리를 나눕니다:

```typescript
// Shared fields on both variants:
// uuid, session_id, duration_ms, duration_api_ms, is_error, num_turns,
// total_cost_usd, usage: NonNullableUsage, modelUsage, permission_denials

// 성공일 때:
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  result: string;
  structured_output?: unknown;
  // ...shared fields
};

// 모종의 에러 발생일 때:
type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // ...shared fields
};
```

아주 유용하게 뽑아 쓸 수 있는 분석 툴 용 필드들: `total_cost_usd`, `duration_ms`, `num_turns`, `modelUsage` (이 안에 모델별 `costUSD`, `inputTokens`, `outputTokens`, `contextWindow` 세부 파이프가 다 들어있음).

### SDKAssistantMessage

```typescript
type SDKAssistantMessage = {
  type: 'assistant';
  uuid: UUID;
  session_id: string;
  message: APIAssistantMessage; // Anthropic SDK 통신 원본 데이터
  parent_tool_use_id: string | null; // 서브 에이전트로부터 전달 된 경우 아이디가 널값이 아님 
};
```

### SDKSystemMessage (init)

```typescript
type SDKSystemMessage = {
  type: 'system';
  subtype: 'init';
  uuid: UUID;
  session_id: string;
  apiKeySource: ApiKeySource;
  cwd: string;
  tools: string[];
  mcp_servers: { name: string; status: string }[];
  model: string;
  permissionMode: PermissionMode;
  slash_commands: string[];
  output_style: string;
};
```

## 에이전트 턴(Turn) 동작: 정지 시 vs 계속 진행 시

### 1) 에이전트가 완벽히 정지할 때 (더 이상 API 백엔드 콜이 일어나지 않음)

**1. 응답에 `tool_use` (도구 사용) 블록이 전혀 없을 때 (가장 보편적인 주 원인)**

클로드가 순수 텍스트로만 대답을 반환한 상황입니다 — 즉시 본인에게 요청된 모든 업무가 임무 완수되었다고 판단하고 멈춘 상태입니다. 이 때 들어오는 API상 명시된 정지 사유 속성명 (`stop_reason`)은 `"end_turn"`값을 지닙니다. 이건 SDK가 임의로 멈추는 게 아니라 모델 자신이 아웃풋을 통해 제어하는 행위입니다.

**2. 지정된 최대 턴수 한도를 넘었을 때** — `SDKResultError` 상태로 전환되며 `subtype: "error_max_turns"` 이벤트가 발생합니다.

**3. 도중에 내가 취소 신호를 줬을 때 (abort signal)** — `abortController` 로 중단시킴.

**4. 돈이 초과되었을 때** — `totalCost >= maxBudgetUsd` 설정 때문에 `"error_max_budget_usd"` 에러 뿜음.

**5. 훅에 걸려서 진행이 멈췄을 때** — 강제 지정한 중단 훅(Stop hook)이 성립되어 `{preventContinuation: true}` 반환값이 떴을 때.

### 2) 에이전트가 쉬지 않고 다시 계속 진행할 때 (재차 백엔드 API 콜 발사 시)

**1. 대답값에 `tool_use` 가 명시되어 있을 때 (이게 핵심)** — 도구(툴)들을 백그라운드 실행함 → 회차(turnCount) 수치 하나 올림 → 다시 자기 자신의 두뇌로 재귀(recurse into EZ) 호출.

**2. 산출물 토큰(`max_output_tokens`)한도에 걸렸을때의 자가 복구 조치** — "원하는 결과물이 너무 길어요. 잘게 쪼개서 작업해보시는게 어때요? 라는 문구를 담아 최대 3번까지 자가 리트라이(Retry) 연장을 보냅니다.

**3. 정지 훅이 오류를 뿜을 때** — 도중에 훅 가로채기 오류가 나면 멈추지 않고, 이걸 문맥상 피드백으로 감지해서 루프 진행을 이어갑니다.

**4. 모델 뻗음 (Fallback)** — 작동하던 AI 모델이 뻗거나 오류 뿜어대면, 대체 예비 모델 쪽으로 재연장 호출합니다 (단 1회 한정).

### 조견표 데코레이션 

| 현재 발생 상황 조건                                      | 프로그램 조치 동작                                                         | 출력되는 결과 타인(Result Type) |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------- |
| 응답 내에 `tool_use` 블록 존재 여부                      | 해당 도구 실행 모드로 전환 및, 그 결과를 품고 자기 자신 반복(`EZ`)         | **계속됨 (continues)**          |
| 응답 내에 `tool_use` 블록 전무 함                        | 할일 끝남. 중단 훅 동작, 결과 도출 반환                                    | 최종 결과 도출됨 (`success`)    |
| `turnCount > maxTurns` 초과 조건                         | 루프 한도에 도달 메시지 반환 후 끝                                         | `error_max_turns` 발생          |
| `totalCost >= maxBudgetUsd` 초과 상황                    | 예산 캡오바 메시지 반환                                                    | `error_max_budget_usd` 발생     |
| `abortController.signal.aborted` 신호                    | 사용자 강제 취소 메시지 발생                                               | 현재 문맥 상황에 따라 다름      |
| 아웃풋이 `stop_reason === "max_tokens"` 이유로 끊겼을 때 | 쪼개기 시스템 문구 발동, 최대 3회 재귀 연장 전송 시도                      | 계속 살림 (continues)           |
| 시스템적으로 중단 훅 작동됨 `preventContinuation`        | 더 볼것 없이 바로 그 자리서 대기 후 반환                                   | 결과 도출 (`success`)           |
| 중지 훅 프로세스 오류 발생                               | 해당 에러 자체를 새로운 프롬프트 삼아 다시 지 알아서 연장 복구 루프 재가동 | 계속 해봄 (continues)           |
| 기본 모델 접속 장애                                      | 예비 모델 설정해둔 게 있다면 1회선 교체 리트라이 호출 시도                 | 계속 해봄 (continues)           |

## 태스크 서브 에이전트들의 실행 모드 (Subagent Execution Modes)

### 첫째 상황: 일반적인 완전 동기식 서브 에이전트 운영 시 (`run_in_background: false` 설정) — 완전히 블록됨 (BLOCKS)

메인 엄마 에이전트가 Task 구동 툴 수행을 명령함 → 자식 프로세스 `VR()`이 서브용으로 구동될 `EZ()` 루프 실행 → 메인 엄마는 그 자식이 결과줄 때까지 멍하니 대기(블록됨) → 도구 결과가 리턴되어 옴 → 엄마 다시 실행기 진행.

이 때 서브 에이전트 역시 거대한 완전 자기 재귀 루프 덩어리(recursive EZ loop)를 구동합니다. 엄마 본체가 툴(도구) 처리를 기다리는 과정에서 `await`라는 정지 스킬로 대기에 빠집니다. 흥미롭게도 시스템상 중간 승급 구조 메커니즘이 하나 있는데, 이 일반 동기화 방식으로 돌고 있는 서브 에이전트를 `Promise.race()` 경쟁 호출을 통해서 신호를 줘서 비동기 백그라운드용으로 모드 전환(강제 프로모션)시킬 수도 있긴 합니다 (`backgroundSignal`).

### 둘째 상황: 대기 없는 백그라운드 전용 일꾼 생성 발싸! (`run_in_background: true` 설정) — 전혀 대기 안 함

- **Bash 사용 시:** 명령어를 OS에서 스폰합니다, 스폰 후 빈 껍데기 결과를 바로 리턴하며 해당 아이디값(`backgroundTaskId`) 하나 던져주고 그 뒤는 나몰라라.
- **Task/Agent 도구:** 신규 서브 에이전트를 쏜 뒤 뒤도 안 돌아보는 감싸기(`fire-and-forget`) 형태로 던져집니다(`g01()`). 도출 값은 즉시 실행 보고 형태로 `status: "async_launched"`와 함께 결과값이 담길 로그 파일 위치(`outputFile`)를 알려주고 알아서 병렬 구동함.

즉, 이 백그라운드 녀석들은 기다리는 과정 싹 무시하고 최종 `type: "result"` 값을 곧장 반환합니다. 나중에 그 백그라운드 놈이 임무를 완수했을 때 조용히 `SDKTaskNotificationMessage` 알림 이벤트 메시지만 따로 떨어뜨려 주어 모을 수 있게 해줍니다.

### 셋째 상황: 대망의 에이전트 '팀 단위 구성' 상황 시 (TeammateTool / SendMessage) — RESULT 뱉어주고 나중에 수거 (POLLING)

팀 캡틴 에이전트는 자신만의 고유한 EZ 루프를 돕니다. 그 루프 과정에서 다른 에이전트 팀 동료들을 탄생시킵니다(spawning). 캡틴 본체의 EZ 한 사이클 턴이 끝나면 일단 `type: "result"` 라고 외칩니다. 그리고 그 캡틴 녀석은 다음과 같은 사후 결과를 줍줍하기 위한 굴레(polling loop)에 접어듭니다:

```javascript
while (true) {
    // 만약 살아있는 팀원(활성화된 놈)도 하나 없고 돌아가는 작업들도 없으면? → 구동 끝(break).
    // 만약 팀원들이 읽은 메시지(안 읽음 표시)가 있다면? → 이 결과를 새로운 프롬프트로 강제 조립해서 → 즉시 캡틴 본인 EZ 루프에 밀어넣고 재가동시켜버림
    // 팀원들은 전부 살아 활동 중인데 내(통로 stdin)가 문이 닫혔다? → 곧바로 "님들 다 시스템 셧다운(종료) 하셈" 프롬프트를 팀원들에게 날려버림
    // 매 0.5초(500ms) 마다 수시로 이 상황 감시 확인 중...
}
```

이걸 사용하는 SDK 사용자 관점에서 다시 생각해 봅시다: 첫 턴 띄어쓰기에 이미 `type: "result"` 메시지가 뽑혀 나옵니다. 그런데 끝난 게 아닙니다. 비동기 제너레이터(AsyncGenerator) 성격상, 캡틴 리더 녀석이 팀원들이 내뱉는 응답들을 끊임없이 계속 읽어 들이면서 지속해서 더 많은 이벤트 문구들을 쏟아낼 수도 있다는 뜻입니다. 그리고 최종적으로 이 비동기 제너레이터가 "나 진짜 끝났다" 하는 진짜 상태는 남은 동료팀원들이 다 뒤졌을 때(shut down), 그때서야 조용해집니다 (finish).

## 이 짓거리의 근본 원인: The "isSingleUserTurn" 문제

그럼 SDK 소스(`sdk.mjs`) 안을 들여다봅니다:

```javascript
QK = typeof X === "string"  // 프롬프트가 단일 테스트형 'string' 일 때 시스템은 강제로 isSingleUserTurn = true 로 판단해 처리함.
```

만약 이게 1회용 단답형(`isSingleUserTurn: true`) 이면서 이제 첫 턴 결과(`result` 메시지)가 나왔다고 칩시다:

```javascript
if (this.isSingleUserTurn) {
  this.transport.endInput();  // SDK가 알아서 CLI 로 들어가는 stdin 대문 셔터를 내려 닫아버림 !!
}
```

이거 단 한 줄 짜리 코드가 끔찍한 연쇄 작용(chain reaction)을 낳습니다:

1. SDK가 CLI 대문(stdin)을 닫아버림
2. CLI 하위 루프가 "어라? 셔터문 닫혔다" 라고 감지
3. 앞서 말한 사후 결과 폴링 굴레 상태에서 `D = true` (stdin closed) 상태 인지 + 근데 구르는 활성 팀원 살아있데?
4. 그래서 캡틴 리더는 자길 기다리는 놈들에게 셧다운 요청(`shutdown_request`) 무전을 쏴버림
5. **결과적으로 아직 막 10분, 20분 짜리 연구를 해줄 열일 중이던 불쌍한 팀원들이 강제로 팀 리더에 의해 사망 처리 당함(Teammates get killed mid-research)**

캡틴 리더 녀석이 셔터 닫혔다고 팀원들에게 보낸 강제 해직(협박용) 프롬프트 원문은 이렇습니다 (minified 파일에서 변수 `BGq` 검색됨):

```
당신(팀 리더)은 현재 비적절 상호작용(non-interactive) 모드로 돌아가고 있습니다. 그래서 당신 팀 전체 시스템을 곧바로 종료조치 취하지 않는 이상, 사용자에게 돌아올 답변 처리를 더는 할 수 없습니다.

최종 답변을 도출하기 전에 당신은 무슨 수를 써서라도 당장 팀 전체를 다 셧다운 정지시켜 닫아야 합니다:
1. 각각의 팀 멤버 그룹들에게 은은하고 부드럽게 작업 멈춰 달라고(shutdown gracefully) 'requestShutdown' 날리세요
2. 그리고 걔들이 수긍해 주길 기다리세요 (shutdown approvals)
3. 걔네들 치우고, 팀 완전 정리하는(cleanup) 수순 절차 밟으세요.
4. 모든 게 싹 정리된 후에야 유저자슥한테 응답(final response) 토해 내세요
```

### 이 문제의 실제 현실적 파멸 단계

V1 방식 `query()` 호출 + 그냥 글줄(`string prompt` = `isSingleUserTurn : true` 판정) + 다수 팀 에이전트 결성 시:

1. 캡틴 엄마 에이전트가 팀원들 생성. 애들이 각자 임무를 맞고 뛰어 나감(`research`)
2. 엄마 캡틴 프로세스 일단 쉬어! 엄마 첫 할일은 완료("나 일거리 다 배분했져. 걔들 나갔어").
3. 이 시그널로 첫 결과 도출! (첫 번째 `type: "result"` 발생)
4. 그 순간 외부 껍데기 SDK가 "단일 스트링 프롬프트네? `isSingleUserTurn = true` !! 야, 다 끝났어 대문(stdin) 창문 다 내려!!"
5. 내부에 지켜보다가 폴링 중이던 녀석이 "어, 대문 닫혔다! 근데 팀원들 살아서 굴러다니네?" → 엄마한테 빨리 셧다운 시키라고 협박 프롬프트 쏴붙임.
6. 엄마 캡틴이 쫄아서 애들에게 `shutdown_request` 명령어를 남발함.
7. **이제 막 임무 투입해서 10초 만에 맹렬히 구르기 시작하던 팀원들은 강제로 시스템 작업 정지 (뒤짐)**.

## 나노 클로우스러운 근본 해결책: 스트리밍 인풋 입력 방식 (Streaming Input Mode)

이제 왜 문제인지 알았습니다. 강제로 문 닫히지 못하게 꼼수를 쓰면 됩니다. 단일 프롬프트 스트링값을 줘서 `isSingleUserTurn = true`로 간주되게 냅두지 말고, 입력값을 `AsyncIterable<SDKUserMessage>` 연속 묶음 타입으로 바꿔서 건네줍니다:

```typescript
// 이전 망해버리는 코드 (Agent team들 강제 셧다운 됨):
query({ prompt: "나를 위해 어쩌고 저쩌고 작업을 해 줘" })

// 고친 뒤 생존 코드 (CLI 문을 무한정 연 채로 방치해버리기 !!):
query({ prompt: asyncIterableOfMessages })  // 이거 스트링 아님, 객체 덩어리 구조임!!
```

이래 버리면:
- 문자열이 아니니까 `isSingleUserTurn = false` 로 판독됨.
- SDK는 "아, 이거 아직 입력 덜 된, 계속 뭔가 더 들어올 스트림 형식 객체구나?" 판단해서 첫 결과가 뜬 순간에도 대문(stdin)을 안내림.
- 오 대문이 계속 열려있음! → CLI 안 죽음! 열심히 내부 동작.
- 파견 나간 백그라운드 에이전트 놈들도 계속 살아서 연구/작업 진행함!
- 일 다 되면 `task_notification` 완료 알림 메시지들도 안 막혀서 펑펑 잘 배달옴.
- 나중에 우리가 직접 "종료" 라고 버튼식으로 반복문을 깨고(end the iterable) 제어 가능.

### 추가 이득 개꿀 기능: 들어오는 신규 메시지 강제 주입

이 무한 반복 스트림 비동기(async iterable) 방식을 차용했기 때문에 생긴 꼼수가 하나 더 있습니다. 에이전트가 무슨 연구를 하며 도는 와중에 외부 플랫폼 WhatsApp에서 띠링 띠링 사용자의 신규 문자들이 더 들어왔을 때, 이전 같았으면 에이전트가 죽고 새 컨테이너 만들어서 큐잉 짬 때릴 동안 기다렸습니다. 
**하지만 이제 지금 한창 구동 중인 세션 공간에 비동기로 저 메시지 값들 스트림을 타고 다이렉트로 던져 강제 주입해버리면 바로 작동합니다.**

### 나노 클로우스러운 Agent Team 의 이상적인 전개 방식 목표

`async iterable` 꼼수로 `isSingleUserTurn=false`를 만든 덕에, CLI에선 팀 관리 강제 멈춤이나 앞선 병맛 셧다운 명령 프롬프트를 뱉을 일 없이 순조로운 대기 시간을 즐깁니다:

```
1. system/init          → 세션이 안정적으로 구축되었음.
2. assistant/user       → Claude가 스스로 추론하고(reasoning), 툴을 직접 써보며 결과 값을 얻는 과정 기록 (여러 번).
3. ...                  → 계속해서 여러 에이전트끼리 회의, 턴 전개 (서브 에이전트 스폰 시키는 등).
4. 결과치 #1 통보 도달   → 메인 캡틴 리더의 첫 반응 아웃풋(일단 이건 먼저 캡처해서 따놈).
5. task_notification 모음→ 파견된 백그라운드 일꾼 애들 죽고 실패하고 끝나고 로그들이 속속 모음통보 됨.
6. assistant/user       → 메인 캡틴 리더가 그 수집 결과를 받아 들고 이어서 자기 임무 계속 속개함.
7. 결과치 #2 최종 보고   → 리더의 모든 업무가 끝난 찐최종 산출물 (캡처완료).
8. [iterator 종료 선언]  → 드루와 드루와~ CLI 가 스스로 지쳐서 이제 아웃풋 줄 것도 없네 하고 본인이 stdout 차단, 전체 상황 종료.
```

모든 결과 산출물이 가치있는 데이터 입니다. 예전처럼 첫 답변 뱉었다고 바로 시스템 끄지 않고 마지막 국물 하나까지 철저하게 전부 모아 포획하는 데 성공합니다.

## V1 방식 API 와 V2 방식 API 간격 분석 비교

### V1 형태: `query()` 활용 — 원샷 기반의 비동기 제너레이터

```typescript
const q = query({ prompt: "...", options: {...} });
for await (const msg of q) { /* 이벤트 값 처리 */ }
```

- 만약에 이 `prompt` 에 일반 문장단위 글귀(스트링)를 준다면: `isSingleUserTurn = true` 판정. 첫 번째 `result` 결과 도달 이후 곧장 지 스스로 stdin 죽임
- 안 죽이고 멀티 연장 턴으로 만들고 싶다면: 구조체인 `AsyncIterable<SDKUserMessage>` 덩어리를 패스한 뒤, 개발자가 스스로 머리 써가며 내부 순서와 죽을 타이밍을 관리해야 함.

### V2 형태: `createSession()` 생성 구형화 + `send()` / `stream()` 조합형 — 지가 알아서 킵 영구적 세션 상태

```typescript
await using session = unstable_v2_createSession({ model: "..." });
await session.send("이거 저거 해봐바 임마!");
for await (const msg of session.stream()) { /* 이벤트 처리 돌리기 */ }
await session.send("수고했어 그럼 이것도 좀 따라 붙어서 처리 요망.");   // ← 이런 연속 후속 지시가 가능
for await (const msg of session.stream()) { /* 이벤트 다시 가져오기 */ }
```

- 이 녀석은 그냥 원래부터 영원히 `isSingleUserTurn = false` 유지 강제 처리됨 → 그래서 문(stdin)이 항상 활짝 열려 살아있음.
- 명령 전달인 `send()` 던지면 자동으로 내부 큐버퍼망(`QX`)에 줄세워서 집어넣어 줌.
- 호출하는 `stream()` 녀석도 어쩌피 위 1세대 V1때 도는 원천 반복 제너레이터 소스를 똑같이 쉐어해서 공유해서 뽑아씀 (대신 이벤트타입 `result` 뜰때마다 잠까 일시 중지될 뿐).
- 이 방식에선 연속 회선인 티키타카(멀티턴 multi-turn) 아주 자연스러움. — 그냥 `send()` 번갈아서 계속 던지고, `stream()` 으로 값 얻고 하면 끝.
- 주의: V2라고 해서 내부에 V1의 `query()`함수를 감싸서 호출하는 구조가 아님. 그냥 두 녀석 모두 따로 포장지만 다르게 해서 원천 Transport 랑 원거리 Query 파이프라인 각각 복제해 부르는 형태임.

### 비교 조견표

| 분류 방식                   | V1 구조                                                   | V2 구조                                                                                    |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 판별 `isSingleUserTurn`     | 일반 문구(스트링프롬프트)에선 `true` 반응                 | 무조건 아묻따 `false` 반응                                                                 |
| 멀티 연장턴 통신 시 지원    | `AsyncIterable` 직접 뚫고 조작해가면서 해야 함            | 심플, 걍 `send()`와 `stream()` 함수로 돌려 막기 가능                                       |
| 대문 (stdin) 생리 구조      | 첫 `result` 결과 이벤트 도달 즉시 셔터 자동으로 꺼짐      | 사용자나 시스템이 수동으로 `close()` 안 때리면 죽을때까지 창문 열고 살아있음               |
| 에이전트 내구 반복루프 구조 | 원천코드로 된 `EZ()` 무한 재귀함수로 일치                 | 원천 코드로 된 `EZ()`로 완전 기능 복제판                                                   |
| 스탑(중지) 상태 조건들      | 상이점 없이 똑같음                                        | 완전 복제라 똑같음                                                                         |
| 세션 재차 접속 영구성 시    | 새 쿼리 쏠때 반드시 기록된 `resume` 속성 들고 찾아가야 됨 | 뻔히 session 객체 덩어리로 안고 살아있으므로 쉽게 재개됨                                   |
| 프로그램 내구 안정성        | 확실한 완전체 정식 배포                                   | (언스테이블이라 뜸) 사실상 아직 한창 개발중인 프리뷰 모드 (`unstable_v2_*` prefix 따고 옴) |

**가장 중요한 결론: 두 녀석 모두 결국 CLI를 통해 내부적으로 똑같은 "턴(Turn)" 을 어떻게 씹냐의 행태 차이는 완벽히 없음.** 똑같이 CLI 복제로 프로세스로 뽑고, 똑같은 내구 재귀함수 `EZ()` 돌려 먹고, 멈추는 분기 판단 과정마저 소스코드 단에서 완벽하게 완전히 같은 기능을 공유합니다.

## 이 훅 이벤트 시스템의 종류 (Hook Events)

```typescript
type HookEvent =
  | 'PreToolUse'         // 도구(tool) 동작을 딱 실행하기 직전
  | 'PostToolUse'        // 도가가 완벽히 실행 무사 끝마친 뒤 나옴
  | 'PostToolUseFailure' // 도가 뻗거나 런타임 삑사리(실패)가 난 뒤 나옴
  | 'Notification'       // 걍 일반 푸시 알림 따위들
  | 'UserPromptSubmit'   // 사용자(우리)가 내린 명령어/글이 날아갔을 때
  | 'SessionStart'       // 새로운 세선 돌리기가 활성화(시작,복구시,기반정리시 등) 스타트 했을 때
  | 'SessionEnd'         // 해당 세션 구가 결국 다 닫혀 끝남!
  | 'Stop'               // 그 시점에서 대상을 잡아 세우는 중(정지 중)
  | 'SubagentStart'      // 우리의 하위(서브) 에이전트 꼬붕이가 생성되었을 때 알림
  | 'SubagentStop'       // 해당 서브 꼬붕이 임무 마치고 박살나(Stop) 정리될 때
  | 'PreCompact'         // 글 문맥이 너무 길어 압축모드(Compact)가 구동되기 바로 직전 알림
  | 'PermissionRequest'; // "이거 해보려면 니 허락(권한)이 필요한데?" 알림 시도 시
```

### 훅 세팅 구조(Hook Configuration)

```typescript
interface HookCallbackMatcher {
  matcher?: string;      // (선택사항) 특정 툴의 이름명칭 매칭 거르기 용
  hooks: HookCallback[];
}

type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal }
) => Promise<HookJSONOutput>;
```

### 훅 작동 시 뽑혀오는 응답 결과 유형들 (Hook Return Values)

```typescript
type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput;

type AsyncHookJSONOutput = { async: true; asyncTimeout?: number };

type SyncHookJSONOutput = {
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: 'approve' | 'block';
  systemMessage?: string;
  reason?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown> }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
    | { hookEventName: 'SessionStart'; additionalContext?: string }
    | { hookEventName: 'PostToolUse'; additionalContext?: string };
};
```

### 꼬붕(서브)에이전트 들의 전용 훅 리스트 (해체 분석 파일 `sdk.d.ts` 참고)

```typescript
type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
};

// 기본 전제 BaseHookInput = { session_id, transcript_path, cwd, permission_mode? } 값이 딸려옴
```

## 쿼리 내 주요 인터페이스 메소드들 (Query Interface Methods)

`Query` 객체 (`sdk.d.ts`의 줄번호 931 위치). 공식문서에서 공개적으로 알리고 있는 함수(메소드) 들:

```typescript
interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<void>;                     // 현재 실행 상태 일지 중지 인터럽트 갈김 (스트리밍 연결 상태에서만 됨)
  rewindFiles(userMessageUuid: string): Promise<void>; // 명시한 UUID상태 시점으로 파일 변경상태 되감기 (타임머신). `enableFileCheckpointing` 기능 켜져야 가능
  setPermissionMode(mode: PermissionMode): Promise<void>; // 실행 권한 변경(모드 변경)을 즉시 적용 (스트리밍 연결 상태에서만 됨)
  setModel(model?: string): Promise<void>;        // AI 사용 모델 모델 변경 지원 (스트리밍 연결 상태에서만 됨)
  setMaxThinkingTokens(max: number | null): Promise<void>; // 생각 회전의 최대 투입 토큰 지정 갱신 (스트리밍 연결 상태에서만 됨)
  supportedCommands(): Promise<SlashCommand[]>;   // 사용할 수 있는 전용 슬래쉬 / 명령어 모음 조회 반환.
  supportedModels(): Promise<ModelInfo[]>;         // 지원가능 모델들 모아서 도출
  mcpServerStatus(): Promise<McpServerStatus[]>;  // 구동되고 있는 MCP 환경 서버들 접속 가능 여부 체크 상태 파악
  accountInfo(): Promise<AccountInfo>;             // 로그인 인증된 사용자의 계정 현황 정보
}
```

(주의!) 공식 문서엔 나오지도 않는데 막상 `sdk.d.ts` 을 뜯어보니 내부 구동(internal) 용으로 존재하는 걸 본 메소드 기능들:
- `streamInput(stream)` — 추가적인 다른 메시지 요청들을 스트림 구조로 이어 꽂아서 날릴 때 사용함.
- `close()` — 동작 중인 이 망할 쿼리 자식을 물리력으로 찍어내려 꺼버릴 때 씀 (강제종료).
- `setMcpServers(servers)` — 동적으로 필요할 때 런타임 중간에도 이 함수 호출용으로 MCP 서버 설정을 박아넣었다가 죽이거나 없앨 때 씀.

## 샌드박스의 세부 설정 모드 옵션들 (Sandbox Configuration)

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: {
    allowLocalBinding?: boolean;
    allowUnixSockets?: string[];
    allowAllUnixSockets?: boolean;
    httpProxyPort?: number;
    socksProxyPort?: number;
  };
  ignoreViolations?: {
    file?: string[];
    network?: string[];
  };
};
```

만약에 `allowUnsandboxedCommands`가 true 세팅이 되어있으면? 모델 녀석은 알아서 본인이 날리는 Bash 도구 인풋 값에다 대고 `dangerouslyDisableSandbox: true` 란 치명적인 설정을 자가적으로 조작해서 써버릴 수가 있습니다, 결국 샌드박스 밖 권한 탈옥이 안되게 `canUseTool` 핸들러단에서 이런 권한 부여 제어를 최종 가로막는 형태의 폴백(falls back) 2차 방어막 형태입니다.

## MCP 통신용 보조 도구(리퍼) 기능 (MCP Server Helpers)

### tool()

MCP 도구들의 정의 형태를 Zod 타입 스키마라는 안전한 보안 구조체 형태를 이용합 타입 세이프(Type-safe)로 치환해냅니다:

```typescript
function tool<Schema extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: z.infer<ZodObject<Schema>>, extra: unknown) => Promise<CallToolResult>
): SdkMcpToolDefinition<Schema>
```

### createSdkMcpServer()

오직 자식 프로세스 구동 전용 시스템 메모리 내부 통신을 위한 로컬 MCP 서버(in-process MCP server)를 개방 생성합니다 (우리 NanoClaw 에선 서브 에이전트들의 정보 상속 통신을 위해 이것 보단 더 간단한 stdio 표준 출력을 오히려 더 추천해서 쓰는 편입니다):

```typescript
function createSdkMcpServer(options: {
  name: string;
  version?: string;
  tools?: Array<SdkMcpToolDefinition<any>>;
}): McpSdkServerConfigWithInstance
```

## 시스템 핵심 구성의 명칭 해체 조회표 (Internals Reference)

### 난독화된 SDK 구동 핵심 식별자들의 본연의 의미 (`sdk.mjs` 영역 분석)

| 난독화 명칭 | 원래 뜻하는 기능/목적                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| `s_`        | V1 `query()` 추출 도우미                                                                         |
| `e_`        | `unstable_v2_createSession` 새로운 세션 객체 만듦                                                |
| `Xx`        | `unstable_v2_resumeSession` 세션 복원시킴                                                        |
| `Qx`        | `unstable_v2_prompt` 프롬프트 연결 통신기                                                        |
| `U9`        | V2용 클래스, 이른바 묶음 통(`send`/`stream`/`close` 담당)                                        |
| `XX`        | ProcessTransport 클래스 (`cli.js`를 탄생 시전시킴)                                               |
| `$X`        | 그 유명한 Query 기능 클래스 부모님본당 그자체 (JSON-line 라우팅 관리, 비동기 이터러블 반복 돌림) |
| `QX`        | AsyncQueue (이 입력값 스트림 들어오기를 멍때리고 담는 버퍼 그릇 역할)                            |

### 난독화된 CLI 구동 핵심 식별자들의 본연의 의미 (`cli.js` 하부 파고듬 영역 분석)

| 난독화 명칭 | 원래 뜻하는 기능/목적                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| `EZ`        | 코어 시스템을 돌리는 그 무한 반복 에이전트 루프 (`EZ` 가 그냥 핵심 두뇌 재귀 제너레이터) |
| `_t4`       | 멈춰주는 스탑 이벤트 훅 핸들러(만약 툴 블럭 응답이 돌아오지 않을 때를 대비한 기능)       |
| `PU1`       | 스트리밍 툴 전용 실행기(API 응답 돌아볼 때 병렬 구동 시전 시 투입 활약함)                |
| `TP6`       | 메인 기본 핵심 스탠다드 툴 운영기 (API 응답 결과 수렴 후 동작 투입 처리)                 |
| `GU1`       | 이 훌륭한 개별 툴 실행의 실체 단위가 작동됨                                              |
| `lTq`       | SDK 구동 세션 전체를 잡아끄는 러너 (runner). (`EZ`라는 애를 다이렉트로 불러 구동시킴)    |
| `bd1`       | 문입구 표준 인풋 리더 `stdin` 수신소 (`transport`로 들어오는 JSON 라인 해석 구동)        |
| `mW1`       | Anthropic 본사 API 스트리밍 서버 통신 장치 (스트리밍 전송 호출러 담당)                   |

## 우리가 필히 뜯어볼 주요 핵심 파일 원본들 내비게이션 좌표

- `sdk.d.ts` — 전체 뼈대 구조체 및 온갖 타입 정리본 파일 영역 (무려 1777 라인).
- `sdk-tools.d.ts` — 사용할 툴 안의 인풋에 어떤 값들이 어떤 포맷으로 들어가야 되는 지 설계 도면도 (스키마 집합).
- `sdk.mjs` — 우리가 쓰는 이 구동 SDK 자체 런타임 코드 원본 몸체 덩어리 본체 파일(난독화 상태, 크기 대략 376KB).
- `cli.js` — 무한루프용 꼬리 터미널용 런타임 구동 코어(마찬가지로 난독화, 하위 자식의 백그라운드 형태로 열일함).
