# EJClaw 가이드라인

NanoClaw 커스터마이징 시 [phj1081/EJClaw](https://github.com/phj1081/EJClaw) 를 참고 가이드라인으로 활용한다.
로컬 클론: `~/path/to/ejclaw`

---

## 아키텍처 개요

EJClaw는 NanoClaw 기반의 Discord 전용 멀티 에이전트 시스템이다.

- **채널**: Discord 전용 (`dc:` JID prefix)
- **에이전트**: Claude Code + OpenAI Codex (두 봇이 독립적으로 동작)
- **프로세스 구조**: 동일 코드베이스를 `SERVICE_AGENT_TYPE` env로 분리하여 두 개의 서비스 인스턴스로 실행
  - `com.ejclaw.plist` → `SERVICE_AGENT_TYPE=claude-code`, trigger `@claude`
  - `com.ejclaw-codex.plist` → `SERVICE_AGENT_TYPE=codex`, trigger `@codex`
- **컨테이너 없음**: 에이전트는 host child process로 직접 실행 (`runners/agent-runner/`, `runners/codex-runner/`)

---

## DB 스키마 — `registered_groups`

```sql
CREATE TABLE registered_groups (
  jid              TEXT NOT NULL,
  name             TEXT NOT NULL,
  folder           TEXT NOT NULL,
  trigger_pattern  TEXT NOT NULL,
  added_at         TEXT NOT NULL,
  agent_config     TEXT,                  -- JSON: AgentConfig (model, timeout, effort...)
  requires_trigger INTEGER DEFAULT 1,
  is_main          INTEGER DEFAULT 0,
  agent_type       TEXT NOT NULL DEFAULT 'claude-code',  -- 'claude-code' | 'codex'
  work_dir         TEXT,

  PRIMARY KEY (jid, agent_type),          -- 동일 채널을 두 에이전트에 등록 가능
  UNIQUE (folder, agent_type)
);
```

핵심: composite PK `(jid, agent_type)` 로 같은 Discord 채널에 여러 에이전트를 등록.
각 서비스는 시작 시 `getAllRegisteredGroups(SERVICE_AGENT_TYPE)` 로 자기 rows만 로드.

---

## Paired Room (All-Agents 채널)

같은 Discord 채널에 두 봇이 모두 등록된 상태 = paired room.

- `isPairedRoomJid(chatJid)` 로 감지
- Paired room에서는 상대 봇의 메시지를 inbound로 전달 (에이전트끼리 대화 가능)
- 각 에이전트에 별도 paired room 프롬프트 적용:
  - `prompts/claude-paired-room.md` — Claude 관점의 리뷰 프로토콜
  - `prompts/codex-paired-room.md` — Codex 관점의 리뷰 프로토콜
- 상태 코드: `DONE` / `DONE_WITH_CONCERNS` / `BLOCKED` / `NEEDS_CONTEXT`
- 교착 상태(stagnation) 감지 시 사용자 개입 요청

---

## 인증 및 Fallback

- **Claude**: `CLAUDE_CODE_OAUTH_TOKEN` (1년 유효 토큰)
  - 429 발생 시 다음 토큰으로 자동 rotation (`CLAUDE_CODE_OAUTH_TOKEN_2`, `_3`, ...)
  - provider fallback: `FALLBACK_BASE_URL` + `FALLBACK_AUTH_TOKEN` (예: Kimi)
- **Codex**: `OPENAI_API_KEY`
- **음성 전사**: Groq Whisper (primary) → OpenAI Whisper (fallback), 공유 캐시로 중복 방지

---

## 참고할 핵심 파일

| 파일 | 참고 포인트 |
|------|------------|
| `src/index.ts` | 메시지 루프, paired room 처리 흐름 |
| `src/db.ts` | composite PK 마이그레이션, agent_type 필터링 |
| `src/channels/discord.ts` | agentTypeFilter, isPairedRoomJid, ownsJid |
| `src/router.ts` | outbound 라우팅, findChannelForAgent |
| `runners/agent-runner/src/index.ts` | Claude Agent SDK query() 호출 방식 |
| `runners/codex-runner/src/index.ts` | OpenAI Codex SDK 호출 방식 |
| `prompts/claude-paired-room.md` | Paired room 에이전트 행동 규칙 |
| `src/config.ts` | 전체 env 변수 목록 |

---

## NanoClaw와의 주요 차이

| | NanoClaw (현재) | EJClaw (가이드라인) |
|---|---|---|
| 에이전트 실행 | Apple Container | Host child process |
| 봇 수 | 3개 (Claude/Gemini/Copilot) | 2개 (Claude/Codex) |
| 서비스 인스턴스 | 1개 (단일 프로세스) | 2개 (agent_type별 분리) |
| 음성 지원 | 없음 | Groq/OpenAI Whisper |
| 토큰 rotation | Gemini만 지원 | Claude도 rotation 지원 |

---

## 새 기능 추가 시 참고 순서

1. EJClaw 해당 기능 구현체 먼저 확인 (`~/path/to/ejclaw/src/`)
2. NanoClaw 구조에 맞게 적용 (컨테이너 → host runner, Codex → Gemini/Copilot)
3. DB 변경 시 EJClaw의 마이그레이션 패턴 참고 (`src/db.ts`)
