# 호스트 관리 가이드

> NanoClaw의 호스트 환경 관리 방법을 설명합니다.  
> 이 작업들은 모두 **호스트(개발자의 PC)에서** 수행해야 합니다.

---

## 1. 핵심 파일 위치

| 파일                    | 위치                                      | 역할                       |
| :---------------------- | :---------------------------------------- | :------------------------- |
| **데이터베이스**        | `store/messages.db`                       | 모든 설정와 대화 기록      |
| **환경변수**            | `.env`                                    | API 키, 서비스 설정        |
| **마운트 화이트리스트** | `~/.config/nanoclaw/mount-allowlist.json` | 외부 폴더 마운트 허용 목록 |
| **그룹 기억**           | `groups/{folder}/CLAUDE.md`               | Claude의 그룹별 영구 기억  |
| **전역 기억**           | `groups/global/CLAUDE.md`                 | 모든 그룹에 공통 적용      |

---

## 2. 서비스 제어

```bash
# macOS (launchctl)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # 재시작
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # 중지
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.plist  # 시작

# Linux (systemd)
systemctl --user restart nanoclaw
systemctl --user stop nanoclaw
systemctl --user start nanoclaw

# 로그 실시간 확인
tail -f logs/nanoclaw.log
```

---

## 3. 데이터베이스 직접 조회

```bash
# SQLite CLI로 접속
sqlite3 store/messages.db

# 등록된 그룹 목록 확인
SELECT jid, name, folder, container_config FROM registered_groups;

# 세션 목록 확인
SELECT * FROM sessions;

# 예약 작업 목록 확인
SELECT id, prompt, schedule_type, schedule_value, status FROM scheduled_tasks;
```

---

## 4. 그룹별 마운트 설정 추가

특정 대화방에서 Claude가 외부 폴더를 볼 수 있게 하려면:

### 4-1. 먼저 화이트리스트에 등록
`~/.config/nanoclaw/mount-allowlist.json` 파일을 편집하거나 생성:

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "개발 프로젝트"
    },
    {
      "path": "~/Documents/work",
      "allowReadWrite": false,
      "description": "업무 문서 (읽기전용)"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

### 4-2. 그룹 DB에 마운트 설정 추가

```bash
sqlite3 store/messages.db "
UPDATE registered_groups
SET container_config = json('{
  \"additionalMounts\": [
    { \"hostPath\": \"~/projects/my-app\", \"readonly\": false },
    { \"hostPath\": \"~/Documents/work\", \"readonly\": true }
  ]
}')
WHERE folder = 'main';
"
```

### 4-3. 서비스 재시작 (변경 적용)

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
systemctl --user restart nanoclaw                  # Linux
```

---

## 5. 환경변수 주요 설정 (`.env`)

| 변수                        | 기본값    | 설명                            |
| :-------------------------- | :-------- | :------------------------------ |
| `ASSISTANT_NAME`            | `Andy`    | 봇 이름 (트리거: @Andy)         |
| `ANTHROPIC_API_KEY`         | -         | Claude API 키                   |
| `CLAUDE_CODE_OAUTH_TOKEN`   | -         | Claude Code OAuth 토큰          |
| `CONTAINER_TIMEOUT`         | `1800000` | 컨테이너 최대 실행 시간 (ms)    |
| `IDLE_TIMEOUT`              | `1800000` | 유휴 후 컨테이너 종료 시간 (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5`       | 최대 동시 컨테이너 수           |

---

## 6. 세션 및 기억 관리

### Claude가 이전 대화를 기억하는 방법
- **세션 ID**: `store/messages.db`의 `sessions` 테이블에 저장
- 컨테이너가 꺼졌다 켜져도 세션 ID로 이전 대화 복원

### 세션 초기화 (대화 리셋)
```bash
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder = 'main';"
```

### Claude가 항상 기억할 내용 추가
```bash
# 특정 그룹에만 적용
echo "\n## 새 규칙\n항상 한국어로 답변할 것" >> groups/main/CLAUDE.md

# 모든 그룹에 적용
echo "\n## 전역 규칙\n답변은 간결하게" >> groups/global/CLAUDE.md
```

---

## 관련 문서

- [`external-mounts.md`](./external-mounts.md) — 외부 마운트 상세 가이드
- [`../architecture/security-model.md`](../architecture/security-model.md) — 보안 구조 이해

*업데이트: 2026-02-25*
