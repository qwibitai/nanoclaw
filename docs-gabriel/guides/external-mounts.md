# 호스트 폴더를 컨테이너에 연결하기 (External Mounts)

> 메신저 Claude가 내 PC의 특정 폴더를 볼 수 있게 설정하는 방법입니다.

---

## 개념

기본적으로 컨테이너는 `groups/{folder}/` 범위 밖의 호스트 파일을 볼 수 없습니다.
외부 폴더를 연결하면 Claude가 프로젝트나 문서를 직접 분석하고 작업할 수 있습니다.

연결된 폴더는 컨테이너 내부에서 `/workspace/extra/{폴더명}/` 경로로 보입니다.

```
호스트: ~/projects/my-app/  →  컨테이너: /workspace/extra/my-app/
호스트: ~/Documents/work/   →  컨테이너: /workspace/extra/work/
```

---

## 3단계 설정

보안상 이유로 외부 마운트는 세 단계 설정을 거쳐야 합니다.

### 1단계: 보안 화이트리스트 생성

폴더를 만들고 allowlist 파일을 생성합니다:

```bash
mkdir -p ~/.config/nanoclaw
```

파일 위치: `~/.config/nanoclaw/mount-allowlist.json`

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "개발 프로젝트 폴더"
    },
    {
      "path": "~/Documents/work",
      "allowReadWrite": false,
      "description": "업무 문서 (읽기전용)"
    }
  ],
  "blockedPatterns": [
    "password",
    "secret",
    "token"
  ],
  "nonMainReadOnly": true
}
```

**allowedRoots 필드:**
- `path`: 마운트 가능한 최상위 경로. 이 범위 밖은 요청해도 차단됩니다.
  - `~` 자동 확장됨 (예: `~/projects` → `/home/username/projects`)
  - 심링크는 실제 경로로 해석됨
- `allowReadWrite`: `true` = 읽기+쓰기, `false` = 읽기전용
- `description`: 설정 참고용 설명 (선택사항)

**blockedPatterns:**
- 추가 차단 패턴 (기본 차단 패턴과 병합됨)
- 기본 차단: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`, `credentials`, `.env`, `.netrc`, `.npmrc`, `.pypirc`, `id_rsa`, `id_ed25519`, `private_key`, `.secret`

**nonMainReadOnly:**
- `true`이면 비메인 그룹(WhatsApp 그룹)은 항상 읽기전용으로 강제
- `false`이면 그룹별 설정을 따름

> ⚠️ 이 파일은 프로젝트 폴더 밖(`~/.config/`)에 저장되어, 컨테이너 에이전트가 수정할 수 없습니다.

### 2단계: 그룹별 마운트 설정

특정 대화방(그룹)에 어떤 폴더를 연결할지 데이터베이스에 등록합니다.

```bash
sqlite3 store/messages.db "
UPDATE registered_groups
SET container_config = json('{
  \"additionalMounts\": [
    {
      \"hostPath\": \"~/projects/my-app\",
      \"containerPath\": \"my-app\",
      \"readonly\": false
    },
    {
      \"hostPath\": \"~/Documents/work\",
      \"containerPath\": \"work\",
      \"readonly\": true
    }
  ]
}')
WHERE folder = 'main';
"
```

**additionalMounts 필드:**

| 필드 | 설명 | 예시 |
|------|------|------|
| `hostPath` | 연결할 호스트 경로 (`~` 사용 가능) | `~/projects/my-app` |
| `containerPath` | 컨테이너 내부 이름 (생략 시 폴더명 자동) | `my-app` |
| `readonly` | `false` = 읽기+쓰기, `true` = 읽기전용 | `false` |

**validation 규칙:**
1. `hostPath` 경로가 실제로 존재해야 함
2. `hostPath`는 `allowedRoots` 범위 내에 있어야 함
3. `hostPath`는 `blockedPatterns` 패턴을 포함하면 안 됨
4. `containerPath`는 상대경로만 가능 (`..` 불가, 절대경로 불가)
5. `nonMainReadOnly=true`일 경우 비메인 그룹의 `readonly` 요청은 무시되고 항상 읽기전용

**여러 그룹에 설정하기:**

```bash
# dev-team 그룹
sqlite3 store/messages.db "
UPDATE registered_groups
SET container_config = json('{
  \"additionalMounts\": [
    {
      \"hostPath\": \"~/projects/dev\",
      \"containerPath\": \"dev\",
      \"readonly\": false
    }
  ]
}')
WHERE folder = 'dev-team';
"
```

### 3단계: 서비스 재시작

설정을 적용하려면 NanoClaw를 재시작합니다:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

---

## 컨테이너에서 확인하기

설정이 완료되면 메신저에서 Claude에게 마운트 확인 요청:

```
@Andy /workspace/extra/ 폴더에 뭐가 있어?
```

또는 직접 파일 접근:

```
@Andy ~/projects/my-app 폴더의 README.md 파일 읽어봐
```

---

## 문제 해결

### 마운트가 거부됨 (mount-allowlist.json 없음)

```
Mount allowlist not found - additional mounts will be BLOCKED
```

**해결:**
```bash
mkdir -p ~/.config/nanoclaw
# 위의 mount-allowlist.json 템플릿을 생성
```

### 경로가 차단됨 (allowedRoots 범위 밖)

```
Path is not under any allowed root
```

**해결:** `mount-allowlist.json`의 `allowedRoots`에 상위 경로 추가

```json
{
  "allowedRoots": [
    {
      "path": "~/새로운경로",
      "allowReadWrite": true,
      "description": "설명"
    }
  ]
}
```

### 보안 패턴 차단 (credentials, .env 등)

```
Path matches blocked pattern
```

**해결:** 해당 경로를 제외하거나, 다른 폴더 구조 사용

### 읽기전용 강제됨 (비메인 그룹)

```
Mount forced to read-only for non-main group
```

비메인 그룹(WhatsApp 그룹)은 `nonMainReadOnly: true`일 경우 항상 읽기전용입니다. 이는 보안 정책이므로 수정 불가능합니다.

---

## 보안 참고사항

### 항상 차단되는 경로
- `.ssh`, `.gnupg`, `.aws`, `.azure`, `.gcloud`, `.kube`, `.docker`
- `credentials`, `.env`, `.netrc`, `.npmrc`, `.pypirc`
- `id_rsa`, `id_ed25519`, `private_key`, `.secret`

### 그룹별 권한
- **메인 그룹(main)**: 모든 `allowedRoots` 접근 가능, `allowReadWrite` 설정 존중
- **비메인 그룹**: `nonMainReadOnly: true`이면 항상 읽기전용 강제

### 심링크 처리
- 심링크는 실제 경로로 해석되어 검증됨
- 차단된 경로로의 심링크도 차단됨

### 컨테이너의 권한 제한
- 컨테이너 내의 Claude는 마운트 설정 파일(`mount-allowlist.json`) 접근 불가
- 설정 변경은 반드시 호스트에서 수행 필요

---

## 관련 문서

- [`host-management.md`](./host-management.md) — 호스트 관리 전반
- [`../reference/volume-mounts-detail.md`](../reference/volume-mounts-detail.md) — 전체 마운트 구조
- [`../architecture/security-model.md`](../architecture/security-model.md) — 보안 구조 상세

*업데이트: 2026-02-28*
