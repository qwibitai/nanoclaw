# NanoClaw 디버그 체크리스트

## 알려진 문제들 (2026-02-08 기준)

### 1. [해결됨] 오래된 트리 위치에서 분기(Branch) 재개 문제
에이전트 팀이 하위 에이전트 CLI 프로세스를 생성(spawn)할 때, 같은 세션 JSONL 파일에 기록합니다. 이후 `query()`로 재개할 때, CLI가 JSONL을 읽지만 최신 내용이 아닌 (하위 에이전트 활동 이전의) 오래된 분기 지점을 선택할 수 있습니다. 이로 인해 호스트가 `result`를 받지 못한 다른 분기선 상에 에이전트의 응답이 기록되는 문제가 발생합니다. **해결책**: 각 재개를 명시적으로 고정하기 위해 마지막 어시스턴트 메시지 UUID를 `resumeSessionAt`으로 전달합니다.

### 2. IDLE_TIMEOUT == CONTAINER_TIMEOUT (둘 다 30분)
두 타이머가 동시에 만료되므로 컨테이너가 항상 정상적인 `_close` 종료 마커 대신 하드 SIGKILL(코드 137)로 강제 종료됩니다. 유휴 시간 초과(IDLE_TIMEOUT)는 더 짧게(예: 5분) 설정하여 메시지 사이에 컨테이너가 정리될 수 있도록 하고, 컨테이너 종료 시간(CONTAINER_TIMEOUT)은 고착된 에이전트를 위한 안전망으로 30분을 유지해야 합니다.

### 3. 에이전트 성공 전 커서 전진 현상
`processGroupMessages`는 에이전트가 실행되기도 전에 `lastAgentTimestamp`를 앞으로 이동시킵니다. 만약 컨테이너가 시간 초과(timeout)되면, 재시도 시점에 커서가 이미 메시지들을 지나쳐버려 큐(queue)에서 더 이상 찾지 못합니다. 이 경우 시간 초과로 인해 메시지들이 영구적으로 유실됩니다.

## 빠른 상태 확인

```bash
# 1. 서비스가 실행 중인가요?
launchctl list | grep nanoclaw
# 예상 값: PID  0  com.nanoclaw (PID = 실행 중, "-" = 실행 안됨, 0이 아닌 종료 코드 = 충돌)

# 2. 실행 중인 컨테이너가 있나요?
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 3. 멈춰있거나 고립된(orphaned) 컨테이너가 있나요?
container ls -a --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 4. 서비스 로그에 최근 에러가 있나요?
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20

# 5. WhatsApp이 연결되어 있나요? (마지막 연결 이벤트 확인)
grep -E 'Connected to WhatsApp|Connection closed|connection.*close' logs/nanoclaw.log | tail -5

# 6. 그룹 정보들이 로드되었나요?
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## 세션 기록 분기(Branching) 상태 확인

```bash
# 세션 디버그 로그에 동시다발적 CLI 프로세스가 있는지 확인
ls -la data/sessions/<group>/.claude/debug/

# 메시지를 처리한 고유 SDK 프로세스 수 세기
# 각각의 .txt 파일 = 하나의 CLI 하위 프로세스. 파일이 여러 개 = 동시다발적 쿼리 발생을 의미.

# 기록(transcript) 내 parentUuid 분기 확인 스크립트
python3 -c "
import json, sys
lines = open('data/sessions/<group>/.claude/projects/-workspace-group/<session>.jsonl').read().strip().split('\n')
for i, line in enumerate(lines):
  try:
    d = json.loads(line)
    if d.get('type') == 'user' and d.get('message'):
      parent = d.get('parentUuid', 'ROOT')[:8]
      content = str(d['message'].get('content', ''))[:60]
      print(f'L{i+1} parent={parent} {content}')
  except: pass
"
```

## 컨테이너 시간 초과(Timeout) 조사

```bash
# 최근 시간 초과 기록 확인
grep -E 'Container timeout|timed out' logs/nanoclaw.log | tail -10

# 시간 초과된 컨테이너의 로그 파일 확인
ls -lt groups/*/logs/container-*.log | head -10

# 가장 최신의 컨테이너 로그 내용 보기 (경로 치환 필요)
cat groups/<group>/logs/container-<timestamp>.log

# 재시도 예약 여부 및 진행 상황 확인
grep -E 'Scheduling retry|retry|Max retries' logs/nanoclaw.log | tail -10
```

## 에이전트 무응답 시 확인

```bash
# WhatsApp에서 메시지를 정상적으로 수신 중인지 확인
grep 'New messages' logs/nanoclaw.log | tail -10

# 메시지가 처리 중인지 확인 (컨테이너 생성 여부)
grep -E 'Processing messages|Spawning container' logs/nanoclaw.log | tail -10

# 동작 중인 컨테이너로 파이프(pipe) 메시지가 전달 중인지 확인
grep -E 'Piped messages|sendMessage' logs/nanoclaw.log | tail -10

# 큐 상태 확인 — 진행 중인 활성 컨테이너가 있는지?
grep -E 'Starting container|Container active|concurrency limit' logs/nanoclaw.log | tail -10

# 현재까지 수신한 최신 메시지의 타임스탬프와 lastAgentTimestamp 비교
sqlite3 store/messages.db "SELECT chat_jid, MAX(timestamp) as latest FROM messages GROUP BY chat_jid ORDER BY latest DESC LIMIT 5;"
```

## 컨테이너 마운트(Mount) 문제 확인

```bash
# 마운트 검증 로그 확인 (컨테이너 생성 시 표시됨)
grep -E 'Mount validated|Mount.*REJECTED|mount' logs/nanoclaw.log | tail -10

# 마운트 화이트리스트(.allowlist) 읽기 권한 확인
cat ~/.config/nanoclaw/mount-allowlist.json

# DB 내의 해당 그룹 container_config 정보 확인
sqlite3 store/messages.db "SELECT name, container_config FROM registered_groups;"

# 컨테이너에 마운트된 볼륨 확인을 위한 테스트 실행 (dry run)
# <group-folder>를 실제 그룹 폴더 이름으로 교체할 것
container run -i --rm --entrypoint ls nanoclaw-agent:latest /workspace/extra/
```

## WhatsApp 인증 문제 확인

```bash
# QR 코드가 요청되었는지 확인 (인증 정보가 만료되었음을 의미)
grep 'QR\|authentication required\|qr' logs/nanoclaw.log | tail -5

# 인증 세션 파일들이 존재하는지 확인
ls -la store/auth/

# 필요하다면 재인증 수행
npm run auth
```

## 데몬 서비스 관리 방법 (macOS 기준)

```bash
# 서비스 재시작
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 실시간 로그 확인
tail -f logs/nanoclaw.log

# 서비스 중지 (주의: 이미 실행 중인 컨테이너들은 자동으로 죽지 않고 분리되어 백그라운드에 남음)
launchctl bootout gui/$(id -u)/com.nanoclaw

# 서비스 시작 (부트스트랩)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 코드 변경 후 빌드 & 데몬 킥스타트
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```
