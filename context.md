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

## 확정된 아키텍처 결정

### 런타임 (Task 1 완료)
- **전략**: NanoClaw 모듈 확장 (Approach 1)
- **호스트**: Node.js 유지 (NanoClaw 기존 인프라 활용)
- **컨테이너**: Bun (기존 NanoClaw 컨테이너와 동일)
- **신규 모듈 위치**: `src/tribunal/`

### Discord 채널 구조
- **방식**: 단일 채널 + 스레드 (`#tribunal-channel`)
- 작업 1개 = 스레드 1개로 격리
- 동시에 여러 작업 병렬 진행 가능

### Tribunal Loop (3-Agent)
- **에이전트**: Owner (코드 작성) → Reviewer (검토) → Arbiter (최종 판정)
- **사용자 개입**: 완전 자동 + Arbiter 승인 시 알림 (옵션 c)
- **무한루프 방지** (옵션 3 — 조합):
  - `round_count >= 3` → 에스컬레이션
  - Reviewer가 동일 키워드 이슈 2회 연속 감지 → 즉시 Arbiter 개입
  - 에스컬레이션 시 스레드에 라운드 요약 + 사용자 @멘션

### Self-Healing Loop
- **방식**: stderr → Reviewer 분석 → Owner 수정 지시 (Tribunal Loop에 통합)
- 별도 에이전트 없음, 기존 3-에이전트 흐름 안에서 처리

### Context Injection

#### Figma MCP
- **접근 범위**: 에이전트 그룹별 `figma_project_ids: [...]` 화이트리스트로 스코핑
- **기본 주입**: 프로젝트 기본 Figma 파일은 항상 컨텍스트에 포함
- **작업별 추가**: Discord 스레드에서 특정 Figma URL 언급 시 해당 파일도 추가 주입
- **권한**: 완전한 읽기/쓰기 (노드 읽기, 주석, 수정, 생성 전부)

#### Spring OpenAPI
- **우선순위**: 라이브 엔드포인트(`/v3/api-docs`) 우선, 없으면 로컬 파일 폴백
- **로컬 파일**: `openapi.yaml` / `openapi.json`

### Lightweight Memory (RAG)
- **엔진**: SQLite FTS5 (Vector DB 없음)
- **저장 대상**:
  1. Arbiter 승인된 최종 코드 스니펫 + 파일 경로
  2. Tribunal Loop 결정 로그 요약
  3. 수동 추가 도메인 지식 (API 설명, 비즈니스 룰 등)

### 스케줄링
- **방식**: NanoClaw `host-sweep.ts` recurrence 인프라에 훅
- Cron 표현식으로 Tribunal 작업을 자동 트리거
- 스케줄 시각에 Discord 스레드 자동 생성 후 Owner-Agent 깨우기

---

## 전체 아키텍처 다이어그램

```
Discord
  └── #tribunal-channel
        └── 🧵 Thread (작업 단위 / 스케줄 트리거)
              │
              ▼
        NanoClaw Host (Node.js)
              │
        src/tribunal/
          ├── orchestrator.ts      ← Tribunal 흐름 관리
          ├── loop-guard.ts        ← 무한루프 방지
          ├── scheduler.ts         ← Cron 기반 자동 트리거
          ├── context-injector.ts  ← Figma + OpenAPI 주입
          └── memory/
                ├── store.ts       ← SQLite FTS5 RAG
                └── indexer.ts     ← 승인 코드/결정 로그 인덱싱
              │
        Agent Containers (Bun)
          ├── owner-agent     ← 코드 작성/수정
          ├── reviewer-agent  ← 검토 + Self-Healing 지시
          └── arbiter-agent   ← 최종 판정 + 에스컬레이션
```

---

## 구현 순서 (계획)

| 순서 | 서브시스템 | 상태 |
|------|-----------|------|
| 1 | Discord 채널 설치 + 3-Agent 그룹 와이어링 | 대기 |
| 2 | Tribunal Orchestrator + Loop Guard | 대기 |
| 3 | Self-Healing Loop (Tribunal 통합) | 대기 |
| 4 | 스케줄러 (host-sweep 훅) | 대기 |
| 5 | Context Injection (Figma MCP + OpenAPI) | 대기 |
| 6 | Lightweight RAG Memory | 대기 |

---

## 작업 브랜치

- **branch**: `feature/custom-framework`
- **worktree**: `.worktrees/custom-framework`
