# NanoClaw 핵심 개념 한눈에 보기

> 5분 만에 NanoClaw의 전체 그림을 파악하기 위한 문서입니다.

---

## 1. NanoClaw란?

WhatsApp, Telegram 등 **메신저를 통해 Claude AI와 대화**할 수 있게 해주는 플랫폼입니다.

- 사용자가 메신저에서 `@Andy 오늘 날씨 어때?` 라고 보내면
- NanoClaw가 메시지를 받아 Claude에게 전달하고
- Claude의 응답을 다시 메신저로 전송합니다.

---

## 2. 두 계층 구조

### 호스트(Host) — 관리자 역할

| 항목            | 내용                                                |
| :-------------- | :-------------------------------------------------- |
| **실행 방식**   | 항상 켜져 있는 백그라운드 서비스                    |
| **주요 역할**   | 메신저 연결, 메시지 수신/라우팅, DB 관리, 보안 제어 |
| **데이터 저장** | `store/messages.db` (모든 대화 기록, 설정)          |
| **설정 파일**   | `.env`, `~/.config/nanoclaw/mount-allowlist.json`   |

### 컨테이너(Container) — 실무 역할

| 항목          | 내용                                                     |
| :------------ | :------------------------------------------------------- |
| **실행 방식** | 대화 시작 시 생성, 30분 유휴 후 자동 종료                |
| **주요 역할** | Claude AI 호출, 도구 실행 (파일 읽기/쓰기, 웹 검색 등)   |
| **격리**      | 그룹별 독립 컨테이너 (다른 대화방과 완전 분리)           |
| **세션 유지** | 컨테이너가 꺼졌다 켜져도 이전 대화 기억 (세션 ID로 복원) |

---

## 3. 스킬(Skills) 시스템

NanoClaw에는 두 종류의 스킬이 있습니다.

| 종류              | 위치                | 사용 주체              | 목적                                      |
| :---------------- | :------------------ | :--------------------- | :---------------------------------------- |
| **호스트 스킬**   | `.claude/skills/`   | 호스트 환경 Claude     | 프로젝트 관리 (설치, 업데이트, 채널 추가) |
| **컨테이너 스킬** | `container/skills/` | 메신저 사용자용 Claude | 에이전트 기능 (웹 서핑, 코드 분석 등)     |

> **메신저 사용자에게 새 기능을 추가하려면** → `container/skills/` 폴더에 추가

---

## 4. 보안 구조 요약

컨테이너는 다음 범위 **밖을** 볼 수 없습니다:

- 호스트 DB(`store/messages.db`)에 직접 접근 불가
- 보안 설정 파일(`~/.config/nanoclaw/mount-allowlist.json`) 수정 불가
- 다른 그룹의 컨테이너 데이터 접근 불가
- 마운트로 허용되지 않은 호스트 폴더 접근 불가

> 추가 폴더 마운트는 호스트 Claude 또는 개발자가 직접 설정해야 합니다.

---

## 5. 컨테이너 생명주기

```
메시지 도착
    │
    ▼
활성 컨테이너 존재? ──YES──▶ IPC로 메시지 전달 (기존 컨테이너 재사용)
    │ NO
    ▼
새 컨테이너 생성 (docker run)
    │ 이전 세션 ID 전달
    ▼
Claude가 작업 수행 및 응답
    │
    ▼
응답 완료 후 대기 상태 (Idle)
    │
    ▼ 30분간 메시지 없으면
컨테이너 자동 종료 → 다음 메시지 시 새로 생성
```

---

## 6. 주요 파일/폴더 한눈에 보기

```
nanoclaw/
  src/                    ← 호스트 오케스트레이터 소스 코드
  container/
    agent-runner/         ← 컨테이너 내부 에이전트 소스
    skills/               ← 메신저 사용자용 스킬 (여기에 추가)
    Dockerfile            ← 컨테이너 이미지 정의
  .claude/skills/         ← 호스트 관리용 스킬 (setup, update 등)
  groups/
    global/CLAUDE.md      ← 모든 그룹에 공통 적용되는 Claude 지침
    main/                 ← 메인(관리자) 그룹 폴더
  store/messages.db       ← 모든 데이터의 심장 (SQLite)
  store/auth/             ← WhatsApp 인증 정보
  data/ipc/               ← 호스트-컨테이너 통신 파일
  data/sessions/          ← 그룹별 Claude 세션 데이터
  .env                    ← API 키, 시스템 설정
```

---

## 더 읽을 거리

| 주제                  | 문서                                                                           |
| :-------------------- | :----------------------------------------------------------------------------- |
| 시스템 내부 구조 상세 | [`architecture/system-architecture.md`](./architecture/system-architecture.md) |
| 컨테이너 스킬 추가    | [`guides/container-skills.md`](./guides/container-skills.md)                   |
| 호스트 폴더 연결      | [`guides/external-mounts.md`](./guides/external-mounts.md)                     |
| 보안 구조 상세        | [`architecture/security-model.md`](./architecture/security-model.md)           |

*업데이트: 2026-02-25*
