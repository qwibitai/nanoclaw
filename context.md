# Custom NanoClaw Framework — Architecture Decisions

> 이 파일은 브레인스토밍 세션의 결정 사항을 누적 백업합니다.
> 새 세션 시작 시 이 파일을 먼저 읽고 이어서 진행하세요.

---

## 환경

- **머신**: Apple Silicon M5 macOS, Kitty 터미널
- **에디터**: Neovim (Code-as-Configuration 원칙)
- **목적**: B2B 프로젝트 개발 전담 다중 에이전트 프레임워크
- **기반**: NanoClaw (순정) 위에 커스텀 모듈 추가

---

## Discord 채널 구조

채널을 3개로 분리. 각 채널의 성격이 완전히 다름.

| 채널 | 운영 방식 | 설명 |
|------|-----------|------|
| `#frontend` | **완전 자동** (Tribunal Loop) | Owner/Reviewer/Arbiter 3-bot이 자율 운영 |
| `#figma` | **사용자 주도** | 사용자가 Figma 작업 지시 → 에이전트가 보조 |
| `#backend` | **사용자 주도** | 사용자가 메인 개발, 에이전트는 보조/질의응답 |

- `#frontend`: 작업 격리는 호스트 오케스트레이터가 session DB로 직접 관리 (Discord 스레드 불필요), 동시 병렬 작업 가능
- `#figma`: Figma MCP 도구 탑재 에이전트가 1:1 대화로 사용자 지시 수행
- `#backend`: Spring OpenAPI 스펙 주입된 에이전트가 사용자와 협업

---

## 확정된 아키텍처 결정

### 런타임
- **전략**: NanoClaw 모듈 확장 (Approach 1)
- **호스트**: Node.js 유지 (NanoClaw 기존 인프라 활용)
- **컨테이너**: Bun (기존 NanoClaw 컨테이너와 동일)
- **신규 모듈 위치**: `src/tribunal/`

### Tribunal Loop (3-Agent) — `#frontend` 전용

- **에이전트**: Owner (코드 작성) → Reviewer (검토) → Arbiter (최종 판정)
- **사용자 개입**: 완전 자동 + Arbiter 승인 시 알림
- **무한루프 방지** (Max Retry + Arbiter 패턴 감지 조합):
  - `round_count >= 3` → 에스컬레이션
  - Reviewer가 동일 키워드 이슈 2회 연속 감지 → 즉시 Arbiter 개입
  - 에스컬레이션 시 스레드에 라운드 요약 + 사용자 @멘션

### Self-Healing Loop — `#frontend` 전용

- **방식**: stderr → Reviewer 분석 → Owner 수정 지시 (Tribunal Loop에 통합)
- 별도 에이전트 없음, 기존 3-에이전트 흐름 안에서 처리

### 스케줄링

- **방식**: NanoClaw `host-sweep.ts` recurrence 인프라에 훅 추가
- Cron 표현식으로 `#frontend` Tribunal 작업을 자동 트리거
- 스케줄 시각에 Discord 스레드 자동 생성 후 Owner-Agent 깨우기
- 설정 위치: `data/v2.db` agent_groups 테이블의 `tribunal_schedules` JSON 컬럼
  ```json
  { "cron": "0 9 * * 1-5", "task": "일일 코드 리뷰" }
  ```

### Context Injection

#### Figma MCP — `#figma` 채널 에이전트에 탑재

- **접근 범위**: 에이전트 그룹별 `figma_project_ids: [...]` 화이트리스트 스코핑
- **기본 주입**: 프로젝트 기본 Figma 파일은 항상 컨텍스트에 포함
- **작업별 추가**: Discord 메시지에 Figma URL 언급 시 해당 파일도 추가 파싱
- **권한**: 완전한 읽기/쓰기 (노드 읽기, 주석, 수정, 생성 전부)
- **차단**: 화이트리스트 외 파일 접근 시 MCP 도구가 에러 반환
- **`#frontend` 에이전트에도 읽기 주입**: 디자인 토큰/컴포넌트 구조를 Owner 컨텍스트에 자동 주입

#### Spring OpenAPI — `#backend` 채널 에이전트에 탑재

- **폴백 체인**: 라이브 엔드포인트(`/v3/api-docs`) 우선 → 로컬 파일(`openapi.yaml` / `openapi.json`) 폴백
- **주입 내용**: 엔드포인트 목록, 요청/응답 스키마(TypeScript 타입 변환), 인증 방식
- **활용**: 사용자가 API 연동 작업 시 에이전트가 스펙을 이미 알고 있어 타입 안전한 코드 제안

### Lightweight Memory (RAG)

- **엔진**: SQLite FTS5 (Vector DB 없음, 추가 의존성 0)
- **저장 위치**: `data/v2.db` 내 `tribunal_memory` 테이블

**저장 대상 및 시점:**

| type | 내용 | 저장 시점 |
|------|------|-----------|
| `code` | Arbiter 승인된 최종 코드 스니펫 + 파일 경로 | Arbiter 승인 직후 |
| `decision` | Tribunal 라운드 요약 (이슈 → 해결 과정) | 승인 또는 에스컬레이션 시 |
| `domain` | 수동 추가 도메인 지식 (API 정책, 비즈니스 룰) | `/memory add <내용>` 명령 |

**검색 및 활용:**
- Owner-Agent 작업 시작 시 작업 설명으로 FTS5 전문 검색
- 관련 과거 코드/결정/도메인 지식 Top-K 추출 → 컨텍스트 앞부분에 자동 주입
- 에이전트 그룹별로 메모리 격리 (`agent_group_id` 기준)

---

## 전체 아키텍처 다이어그램

```
Discord
  ├── #frontend ─────────── Tribunal Loop (완전 자동)
  │     └── 🧵 Thread       Owner → Reviewer → Arbiter
  │                         Self-Healing, 스케줄러, RAG 메모리
  │
  ├── #figma ─────────────── 사용자 ↔ Figma-Agent (1:1)
  │                          Figma MCP 읽기/쓰기 전권
  │
  └── #backend ────────────── 사용자 ↔ Backend-Agent (협업)
                              Spring OpenAPI 스펙 주입

NanoClaw Host (Node.js)
  └── src/tribunal/
        ├── orchestrator.ts      ← #frontend Tribunal 흐름 관리
        ├── loop-guard.ts        ← 무한루프 방지 (Max Retry + 패턴 감지)
        ├── scheduler.ts         ← Cron 기반 자동 트리거
        ├── context-injector.ts  ← Figma(읽기) + OpenAPI 주입
        └── memory/
              ├── store.ts       ← SQLite FTS5 검색
              └── indexer.ts     ← 승인 코드/결정 로그 인덱싱

Agent Containers (Bun)
  ├── frontend: owner-agent, reviewer-agent, arbiter-agent
  ├── figma:    figma-agent (Figma MCP 풀 권한)
  └── backend:  backend-agent (OpenAPI 스펙 주입)
```

---

## 구현 순서 (계획)

| 순서 | 서브시스템 | 상태 | 커밋 |
|------|-----------|------|------|
| 1 | Discord 설치 + 3채널 에이전트 그룹 와이어링 | ✅ 완료 | `a945d3f`, `09cfdae` |
| 2 | Tribunal Orchestrator + Loop Guard (`#frontend`) | ✅ 완료 | `91f6899`, `86e6cff`, `7c35f79` |
| 3 | Self-Healing Loop (Tribunal 통합) | ✅ 완료 | Tribunal 흐름에 통합, 별도 에이전트 없음 |
| 4 | 스케줄러 (host-sweep 훅) | ✅ 완료 | `237c7aa` |
| 5 | Figma MCP 연동 (`#figma` + `#frontend` 읽기 주입) | ✅ 완료 | MCP는 컨테이너 레벨, 호스트 주입은 `ac5e04e` |
| 6 | Spring OpenAPI 주입 (`#backend`) | ✅ 완료 | `context-injector.ts` — live fetch + file fallback |
| 7 | Lightweight RAG Memory | ✅ 완료 | `f4605a4` |

### 세션 진행 노트 (2026-05-01)

- `delivery.ts` 배달 루프에 `handleTribunalRouting` 훅 연결 완료 (`b2e9f8c`)
- `OutboundMessage` 임포트 경로 수정 (`types.js` → `db/session-db.js`)
- `tribunal_schedules` 컬럼 마이그레이션 (migration015)
- `TIMEZONE`-aware cron 스케줄러 구현, host-sweep에 `TRIBUNAL-HOOK` 추가

### 세션 진행 노트 (2026-05-03)

- `nanoclaw.sh` 실행 → setup 완료 (launchd 등록, init-first-agent, Discord 오너 등록)
- `/manage-channels` → 5개 에이전트 그룹 와이어링 완료
  - `#frontend`: Owner(pattern)/Reviewer(mention)/Arbiter(mention), session_mode=shared
  - `#pm`, `#backend`: pattern, session_mode=shared
- 주요 이슈 해결:
  - `engage_mode=mention` 기본값 → Owner/PM/Backend를 `pattern`으로 변경
  - `session_mode=per-thread` → `shared`로 변경 (일반 텍스트 채널에서 per-thread는 thread_id가 채널 ID가 되어 Discord API snowflake 에러 발생)
- 전 에이전트 `CLAUDE.local.md`에 한국어 응답 지시 추가

### 세션 진행 노트 (2026-05-02)

- `/add-discord` 스킬 완료: `src/channels/discord.ts` 복사, barrel import 추가, `@chat-adapter/discord@4.26.0` 설치, 빌드 성공
- upstream remote 추가 (`https://github.com/qwibitai/nanoclaw.git`)
- `.env`에 `DISCORD_BOT_TOKEN` / `DISCORD_APPLICATION_ID` / `DISCORD_PUBLIC_KEY` 추가, `data/env/env` 싱크 완료
- 호스트 기동으로 마이그레이션 14개 완료, Discord 봇(`NanoBot`) Gateway 연결 확인
- 배달 방식: **봇 1개 + Webhook** (에이전트별 username/avatar 구분) — 세션은 에이전트 그룹별 완전 격리
- 채널 타입: `#frontend` / `#figma` / `#backend` 전부 **일반 텍스트 채널** (포럼 X)

**완료된 작업:**
- `#frontend` / `#pm` / `#backend` 채널 Webhook 생성 완료
- `groups/frontend-owner/webhook.json`, `groups/frontend-reviewer/webhook.json`, `groups/frontend-arbiter/webhook.json` 생성
- `groups/pm/webhook.json`, `groups/backend/webhook.json` 생성
- webhook identity 기능 PR #2 머지 완료 (`src/channels/discord-webhook.ts`)

**순서 1번 완료 (2026-05-03)**

---

## 작업 브랜치

- **branch**: `feature/custom-framework`
- **worktree**: `.worktrees/custom-framework`
