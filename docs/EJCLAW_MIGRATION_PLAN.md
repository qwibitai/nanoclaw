# EJClaw-Style Migration Plan

`nanoclaw`를 Apple Container 중심 구조에서 `EJClaw` 스타일의 host-runner 중심 구조로 전환하기 위한 계획 문서다.

기준 레퍼런스:
- 현재 저장소: `<repo-root>/nanoclaw`
- 참고 구현: `~/path/to/ejclaw`
- 참고 메모: [EJCLAW_GUIDE.md](../EJCLAW_GUIDE.md)

## 목표

- Claude와 Codex를 모두 host process 기반으로 실행한다.
- 컨테이너 런타임 장애가 전체 서비스 가용성을 깨지 않게 만든다.
- Discord 채널 하나에 여러 agent_type을 붙이는 paired room 구조를 유지한다.
- 세션 지속성, 에이전트별 라우팅, 재시작 복구 같은 현재의 운영 기능은 유지하거나 개선한다.
- 점진적으로 전환한다. 한 번에 전체를 갈아엎지 않는다.

## 비목표

- Telegram, WhatsApp, Slack, Gmail 전체 채널 지원을 이번 전환의 1차 범위에 포함하지 않는다.
- 기존 컨테이너 보안 모델을 host 환경에서 그대로 재현하려고 하지 않는다.
- Claude/Codex 외 추가 모델 런타임 재설계는 1차 범위에서 제외한다.
- UI/대시보드 추가는 우선순위가 아니다.

## 왜 전환하는가

현재 `nanoclaw`의 핵심 전제는 Claude 에이전트가 컨테이너 안에서 실행된다는 것이다. 이 구조는 보안 측면에서는 명확하지만, 운영 측면에서는 다음 문제가 있다.

- `container` runtime이 정상 동작하지 않으면 전체 프로세스가 부팅 실패한다.
- host runner 기반인 `codex`도 Claude 컨테이너 초기화 실패에 연쇄로 묶인다.
- launchd/systemd 환경과 container runtime PATH 문제가 서비스 전체 가용성 문제로 번진다.
- `codex`, `gemini`, `copilot`는 host runner인데 Claude만 별도 실행 경로여서 런타임 모델이 이원화돼 있다.

`EJClaw`는 이 문제를 host process 기반으로 단순화한다.

- 컨테이너 없음
- agent_type별 서비스 분리 가능
- Claude와 Codex 모두 host child process로 실행
- 런타임, 세션, 로그, 재시작 흐름이 더 단순함

## 목표 아키텍처

최종적으로는 아래 구조를 목표로 한다.

```text
Discord -> SQLite/WAL -> Group Queue -> Agent Runtime Dispatch
                                      |- Claude host runner
                                      |- Codex host runner
                                      |- optional: Gemini/Copilot host runners

Per-agent service partition:
- SERVICE_AGENT_TYPE=claude-code
- SERVICE_AGENT_TYPE=codex

Shared concepts:
- registered_groups: composite PK (jid, agent_type)
- sessions: composite PK (group_folder, agent_type)
- paired room detection by jid
- outbound routing by agent_type
```

## 전환 원칙

1. 먼저 런타임 추상화를 만든다.
2. 그다음 Claude를 컨테이너 경로 밖으로 옮긴다.
3. 마지막에 서비스 분리와 불필요한 컨테이너 코드를 제거한다.

즉, 순서는 `기능 추가 -> 경로 전환 -> 구조 정리`다.

## 현재 상태 요약

- `registered_groups`와 `sessions`는 이미 `agent_type` 다중 등록 구조를 갖고 있다.
- Discord 채널은 `claude-code`, `gemini`, `copilot`, `codex` 라우팅이 가능하다.
- `codex`는 현재 host runner 경로로 일부 추가되었다.
- Claude는 여전히 [container-runner.ts](../src/container-runner.ts)와 [container-runtime.ts](../src/container-runtime.ts)에 의존한다.
- 서비스 부팅 초기에 컨테이너 런타임 실패 시 전체 앱이 종료된다.

## 단계별 계획

## Phase 0. 문서화와 기준선 고정

목적:
- 현재 동작을 고정하고, 전환 중 회귀를 줄인다.

작업:
- 현재 메시지 처리, paired room, 세션 저장, Discord 라우팅 흐름 문서화
- Claude/Codex 각각의 최소 smoke test 시나리오 정의
- `.env`, launchd, DB 상태를 백업 가능하도록 운영 체크리스트 작성

완료 기준:
- 전환 전/후 비교 가능한 체크리스트가 있다.

## Phase 1. 런타임 추상화 도입

목적:
- `runAgent()`가 container 전용 코드에 직접 묶이지 않게 만든다.

작업:
- `AgentRuntime` 인터페이스 도입
- `ContainerClaudeRuntime` 구현체 분리
- `HostCliRuntime` 또는 `HostAgentRuntime` 공통 구현 도입
- `CodexRuntime`, `GeminiRuntime`, `CopilotRuntime`는 host runtime 계층으로 정리
- [index.ts](../src/index.ts)의 직접 분기를 runtime dispatch로 치환

권장 인터페이스 예시:

```ts
interface AgentRuntime {
  kind: 'container' | 'host';
  supportsSteering: boolean;
  run(group: RegisteredGroup, input: AgentRunInput, onOutput?: OnOutput): Promise<AgentRunResult>;
}
```

핵심 파일:
- `src/index.ts`
- `src/host-runner.ts`
- `src/container-runner.ts`
- 신규: `src/runtimes/*`

완료 기준:
- 런타임 선택이 `agent_type` 또는 `agentCli` 기준으로 공통 dispatch에서 처리된다.
- 기존 Claude 기능은 그대로 동작한다.

## Phase 2. Claude host runner 도입

목적:
- Claude를 컨테이너 없이도 실행할 수 있게 만든다.

작업:
- `EJClaw`의 `~/path/to/ejclaw/src/agent-runner.ts`와 runner 디렉터리 구조를 참고해 `nanoclaw`용 Claude host runner 추가
- 세션 지속성 구현
- streaming output marker 또는 동등한 프로토콜 도입
- 현재 IPC 기반 mid-turn message injection이 필요하면 host runner에 같은 방식으로 연결
- group별 `CLAUDE.md`와 runtime prompt 조합 방식 정리

검토 포인트:
- Claude CLI/SDK 인증 주입 방식
- group folder를 cwd로 둘지, session root를 따로 둘지
- task scheduler와 IPC watcher가 container 가정 없이 동작하는지

핵심 파일:
- 신규: `runners/agent-runner/`
- `src/index.ts`
- `src/ipc.ts`
- `src/db.ts`

완료 기준:
- Claude가 컨테이너 없이 host child process로 정상 응답한다.
- 기존 세션 지속성과 출력 스트리밍이 유지된다.

## Phase 3. 컨테이너 런타임 optional화

목적:
- 컨테이너 부재가 전체 서비스 부팅 실패로 이어지지 않게 만든다.

작업:
- [container-runtime.ts](../src/container-runtime.ts)의 fatal startup 경로 제거 또는 optional화
- Claude가 host runner로 등록된 경우 container check를 건너뛰게 변경
- 서비스 시작 시 “필요한 runtime만 검사”하도록 분리

권장 정책:
- host-only agents만 활성화된 설치에서는 container runtime 검사 생략
- Claude가 container mode일 때만 container runtime 필수

완료 기준:
- `container` 명령이 없거나 Apple Container가 죽어 있어도 Codex 서비스는 정상 부팅 가능
- Claude host runner 사용 시 전체 앱이 컨테이너 없이도 기동 가능

## Phase 4. 서비스 분리

목적:
- `EJClaw`처럼 agent_type별로 독립 서비스 실행 가능하게 만든다.

작업:
- `SERVICE_AGENT_TYPE` 도입
- 필요 시 `SERVICE_ID` 도입
- 시작 시 `getAllRegisteredGroups(SERVICE_AGENT_TYPE)`만 로드하게 변경
- launchd/systemd 템플릿 분리
  - `com.nanoclaw.plist`
  - `com.nanoclaw-codex.plist`
- `DISCORD_BOT_TOKEN`을 서비스별 환경으로 분리

운영 효과:
- Claude 장애가 Codex 프로세스에 영향 주지 않음
- 로그와 재시작 단위가 명확해짐
- paired room은 DB/라우터 레벨에서 유지

완료 기준:
- Claude와 Codex가 같은 코드베이스를 공유하지만 별도 서비스로 독립 운영된다.

## Phase 5. 설정 모델 정리

목적:
- `container_config` 중심 레거시를 `agent_config` 중심 구조로 정리한다.

작업:
- `container_config.agentCli`를 일반적인 `agent_config`로 대체
- Claude/Codex 공통 옵션 정의
  - model
  - timeout
  - reasoning effort
  - work dir
- DB migration 추가
- setup/register 경로도 새 필드 사용

권장 예시:

```ts
type AgentConfig = {
  runtime: 'host';
  provider: 'claude-code' | 'codex' | 'gemini' | 'copilot';
  model?: string;
  effort?: string;
  timeout?: number;
  workDir?: string;
};
```

완료 기준:
- `container_config`가 새 설치 경로에서 더 이상 핵심 설정이 아니다.

## Phase 6. 컨테이너 코드 제거 또는 격리

목적:
- 더 이상 필요 없는 컨테이너 전용 코드를 정리한다.

작업:
- 제거 여부 결정
  - 완전 제거
  - legacy mode로 격리
- 후보 파일:
  - `src/container-runner.ts`
  - `src/container-runtime.ts`
  - `src/mount-security.ts`
  - `src/credential-proxy.ts`
  - `container/`
- README와 setup 문서 업데이트

권장:
- 바로 삭제하지 말고 `legacy-container/` 또는 feature flag 뒤로 한 번 격리한 뒤 제거

완료 기준:
- 코드베이스의 런타임 전제가 host runner 중심으로 정리된다.

## 설계 결정 포인트

## 1. 단일 프로세스 유지 vs 서비스 분리

선호 순서:
- 1차: 단일 프로세스에서도 host runners만으로 부팅 가능
- 2차: `SERVICE_AGENT_TYPE` 기반 서비스 분리

이유:
- 먼저 런타임 의존성을 걷어내야 서비스 분리가 쉬워진다.
- 한 번에 둘 다 바꾸면 디버깅 범위가 너무 커진다.

## 2. Claude 실행 방법

선택지:
- Claude Agent SDK 기반 runner
- Claude CLI 기반 runner

권장:
- `EJClaw`와 같은 Agent SDK 또는 안정적인 stream-capable 방식

이유:
- mid-turn steering과 세션 지속성을 맞추기 쉽다.

## 3. Codex 실행 방법

선택지:
- 현재처럼 `codex exec` 래핑
- `EJClaw`식 `codex-runner` app-server 기반 고도화

권장:
- 최종적으로는 `codex-runner` 유지

이유:
- progress/final 분리
- 세션/스티어링
- 향후 MCP 주입과 설정 overlay가 쉬움

## 4. 채널 범위

1차 범위는 Discord 우선이다.

이유:
- `EJClaw`도 Discord 전용 구조가 기준
- 현재 Codex 실제 사용 경로도 Discord 기준
- 채널 추상화보다 런타임 전환이 더 큰 문제

## 위험 요소

- 컨테이너 보안 모델이 사라지면서 host filesystem 접근 위험이 커진다.
- Claude 인증 주입 방식이 정리되지 않으면 운영 중 세션이 자주 깨질 수 있다.
- 기존 queue/IPC 코드가 container 가정에 묶여 있을 가능성이 있다.
- launchd/systemd 분리 시 `.env` 관리가 더 엄격해져야 한다.
- paired room은 서비스가 둘로 갈라질수록 race condition 가능성이 커진다.

## 대응 전략

- Phase 1~3 동안은 단일 프로세스에서 먼저 안정화
- runner stdout/stderr, structured marker, restart log를 강화
- 테스트 우선순위를 런타임 전환 경로에 집중

## 테스트 계획

필수 테스트:
- agent_type별 group load
- Discord inbound/outbound routing
- session persistence
- paired room ordering
- `/pause`, `/resume`
- restart recovery
- undelivered work item retry

추가 테스트:
- Claude host runner resume
- Codex runner resume
- runtime unavailable 시 graceful degradation
- service split 후 동일 JID paired room 동작

## 운영 마이그레이션 순서

권장 실제 순서:

1. 현재 DB 백업
2. `.env` 백업
3. Phase 1 적용
4. Codex runner 안정화
5. Claude host runner 추가
6. container optional화
7. Discord만 먼저 service split
8. 충분히 안정화된 뒤 legacy container 코드 제거

## 롤백 전략

- 서비스 분리 전까지는 container path를 feature flag 뒤에 남겨둔다.
- Claude host runner가 불안정하면 Claude만 기존 path로 되돌리고 Codex는 host runner 유지
- DB migration은 additive 방식으로 작성한다.
- launchd/systemd 서비스 파일은 `nanoclaw`와 `nanoclaw-codex`를 분리해 롤백 시 하나만 내려도 되게 한다.

## 첫 구현 스프린트 제안

가장 현실적인 1차 스프린트:

1. `AgentRuntime` 추상화 도입
2. `codex-runner` 분리 또는 현재 `host-runner` 정리
3. Claude host runner 초안 추가
4. `ensureContainerRuntimeRunning()` optional화
5. Discord + paired room regression tests 추가

이 스프린트의 성공 기준:
- 컨테이너 없이도 Codex는 서비스 기동 가능
- Claude host runner를 dev 환경에서 수동 호출 가능
- 전체 서비스가 더 이상 container startup failure 때문에 죽지 않음

## 결론

`nanoclaw`를 `EJClaw` 스타일로 전환하는 핵심은 “Codex를 붙이는 것”이 아니라 “Claude까지 포함한 런타임 전제를 host-runner 중심으로 재정렬하는 것”이다.

가장 중요한 순서는 아래 하나다.

1. 런타임 추상화
2. Claude host runner
3. container optional화
4. 서비스 분리
5. 레거시 제거

이 순서를 지키면 운영 리스크를 크게 줄이면서 `EJClaw` 스타일의 구조로 수렴할 수 있다.
