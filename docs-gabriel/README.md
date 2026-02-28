# NanoClaw 문서 가이드

> NanoClaw는 WhatsApp 등 메신저를 인터페이스로 사용하는 Claude AI 에이전트 플랫폼입니다.  
> 이 문서는 시스템 전반을 빠르게 이해하기 위한 진입점입니다.

---

## 빠른 개요

NanoClaw는 **호스트(Host)** 와 **컨테이너(Container)** 두 계층으로 분리됩니다.

```
[메신저 사용자]
     │ 메시지
     ▼
[Host: 오케스트레이터]  ← 항상 실행 중 (데몬)
  - WhatsApp/Telegram 연결 유지
  - 메시지 수신 및 라우팅
  - DB(store/messages.db) 관리
  - 보안 및 권한 제어
     │ 메시지 전달
     ▼
[Container: Claude 에이전트]  ← 대화 시작 시 생성, 30분 유휴 시 자동 종료
  - Claude AI API 호출
  - 도구 실행 (Bash, 파일 읽기/쓰기 등)
  - 허용된 폴더 범위 내에서만 동작
     │ 응답
     ▼
[메신저 사용자]
```

---

## 📁 문서 구조

```
docs-gabriel/
  README.md                   ← 이 파일 (전체 개요 및 진입점)
  OVERVIEW.md                 ← 핵심 개념 한눈에 보기 (여기서 시작하세요)
  
  architecture/               ← 시스템 내부 구조 (개발자용)
    system-architecture.md    ← 전체 아키텍처 (메시지 흐름, DB 구조, IPC)
    container-lifecycle.md    ← 컨테이너 생성/재사용/종료 메커니즘
    security-model.md         ← 보안 계층 구조 및 권한 모델
  
  guides/                     ← 실전 운영 가이드 (관리자용)
    setup-guide.md            ← 초기 설치 및 1년 장기 토큰 설정 방법 ⭐
    host-management.md        ← 호스트 관리: DB, 마운트 설정, 서비스 제어
    container-skills.md       ← 컨테이너 스킬 추가하기
    external-mounts.md        ← 호스트 폴더를 컨테이너에 연결하기
    skills-engine.md          ← 스킬 엔진 (코드 패치 시스템)
  
  reference/                  ← 원본 번역 레퍼런스 (심화 학습용)
    sdk-deep-dive.md          ← Claude Agent SDK 상세
    security-spec.md          ← 보안 스펙 원본
    apple-container.md        ← macOS Apple Container 설정
    debug-checklist.md        ← 디버깅 체크리스트
```

---

## 🗺️ 목적별 읽기 경로

### "NanoClaw가 뭔지 알고 싶다"
→ **[OVERVIEW.md](./OVERVIEW.md)** 먼저 읽기

### "처음 설치하고 싶다 (신규 설치)"
→ **[guides/setup-guide.md](./guides/setup-guide.md)** ← 여기서 시작

### "설치 후 운영하고 싶다"
→ `OVERVIEW.md` → `guides/host-management.md`

### "스킬/기능을 추가하고 싶다 (메신저 사용자용)"
→ `guides/container-skills.md`

### "스킬/기능을 추가하고 싶다 (호스트 코드 수정)"
→ `guides/skills-engine.md`

### "Claude가 내 로컬 폴더를 보게 하고 싶다"
→ `guides/external-mounts.md`

### "내부 구조를 깊이 이해하고 싶다"
→ `architecture/system-architecture.md`

### "보안 구조를 이해하고 싶다"
→ `architecture/security-model.md`

---

## 🔑 핵심 용어

| 용어              | 설명                                                                         |
| :---------------- | :--------------------------------------------------------------------------- |
| **Host**          | 항상 실행 중인 Node.js 오케스트레이터 (`src/index.ts`)                       |
| **Container**     | 대화 요청 시 생성되는 격리된 Claude 실행 환경                                |
| **agent-runner**  | 컨테이너 내부에서 Claude SDK를 호출하는 래퍼                                 |
| **Group**         | 등록된 메신저 대화방 (각자 독립 컨테이너)                                    |
| **Main Group**    | 관리자 권한을 가진 특별 그룹                                                 |
| **IPC**           | 호스트-컨테이너 간 파일 기반 통신                                            |
| **Skills**        | 기능 확장 단위 (호스트용 `.claude/skills/` / 컨테이너용 `container/skills/`) |
| **Skills Engine** | 호스트 코드를 패칭해 기능을 추가하는 3-way merge 시스템                      |

---

*마지막 업데이트: 2026-02-25 (guides/setup-guide.md 추가)*
