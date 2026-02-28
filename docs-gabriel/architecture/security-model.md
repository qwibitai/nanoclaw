# NanoClaw 보안 모델

> 보안 구조, 격리 수준, 권한 모델을 설명합니다.

---

## 1. 보안 5계층

```
Layer 1: 컨테이너 격리
  그룹별 독립 컨테이너 → 다른 그룹 접근 불가
  --rm 플래그 → 종료 시 컨테이너 파일시스템 삭제

Layer 2: 볼륨 마운트 제한 (2단계 화이트리스트)
  1단계: ~/.config/nanoclaw/mount-allowlist.json (허용 루트 경로)
  2단계: registered_groups.container_config (그룹별 구체 경로)
  블랙리스트: .ssh, .aws, .env, credentials, private_key 등

Layer 3: IPC 인가
  소스 그룹 폴더 경로 = 신원
  비메인 그룹: 자신의 태스크만 관리 가능
  register_group, refresh_groups: 메인 그룹 전용

Layer 4: 시크릿 격리
  API Key는 stdin JSON으로만 전달 (파일 저장 없음)
  Bash 실행 전 환경변수에서 시크릿 자동 제거 (PreToolUse hook)

Layer 5: 경로 검증
  그룹 폴더명: 영문자/숫자/-만 허용
  경로 traversal (..) 차단
```

---

## 2. 보안 설정 위치

| 설정                  | 위치                                      | 수정 주체                     |
| :-------------------- | :---------------------------------------- | :---------------------------- |
| 외부 마운트 허용 루트 | `~/.config/nanoclaw/mount-allowlist.json` | 호스트 (개발자/호스트 Claude) |
| 그룹별 마운트 설정    | `store/messages.db` → `container_config`  | 호스트 (개발자/호스트 Claude) |
| API 키/토큰           | `.env`                                    | 개발자 직접 수정              |

> **컨테이너 내부의 Claude는 위 설정들을 변경할 수 없습니다.**  
> 외부 폴더 마운트 허용 등의 보안 설정은 반드시 호스트에서 수행해야 합니다.

---

## 3. 메인 그룹 vs 비메인 그룹 권한

| 기능                       |    메인 그룹     |  비메인 그룹  |
| :------------------------- | :--------------: | :-----------: |
| 프로젝트 루트 마운트       |    ✅ 읽기전용    |       ❌       |
| 다른 그룹에 메시지 전송    |        ✅         |       ❌       |
| 그룹 등록 (register_group) |        ✅         |       ❌       |
| 태스크 관리                |      ✅ 전체      |   자신 것만   |
| 그룹 메타데이터 새로고침   |        ✅         |       ❌       |
| 추가 마운트 쓰기 권한      | ✅ (allowlist 내) | 강제 읽기전용 |

---

## 4. 시크릿 전달 흐름

```
호스트:
  .env → readSecrets() → ContainerInput.secrets

컨테이너 실행:
  docker run ... (환경변수로 전달하지 않음)
  container.stdin.write(JSON.stringify(containerInput))

컨테이너 내부:
  readStdin() → secrets 추출
  sdkEnv = { ...process.env, ...secrets }
  /tmp/input.json 즉시 삭제
  query({ options: { env: sdkEnv } })

Bash 도구 실행 시:
  PreToolUse hook → unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
```

---

## 5. 외부 마운트 보안 검증 흐름

```
추가 마운트 요청 → mount-security.ts

1. mount-allowlist.json 로드
   → 없으면 모든 추가 마운트 차단

2. 요청 경로 실제 경로(realpath)로 변환

3. 블랙리스트 패턴 매칭
   → .ssh, credentials 등 포함 시 차단

4. allowedRoots 범위 내 여부 확인
   → 범위 밖이면 차단

5. 읽기/쓰기 권한 결정
   → 비메인 그룹: nonMainReadOnly=true면 강제 읽기전용
   → allowedRoot.allowReadWrite=false면 강제 읽기전용

6. 컨테이너 경로: /workspace/extra/{basename} 로 고정
```

---

## 관련 문서

- [`../guides/external-mounts.md`](../guides/external-mounts.md) — 외부 마운트 설정 방법
- [`../reference/security-spec.md`](../reference/security-spec.md) — 보안 스펙 원본

*업데이트: 2026-02-25*
