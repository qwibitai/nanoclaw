# NanoClaw 실전 사용 가이드: 호스트-컨테이너 연결과 스킬 관리

> **목적**: 처음 NanoClaw를 설치하거나 확장하는 개발자가 실제로 무엇을 어떻게 해야 하는지 단계별로 이해할 수 있도록 작성된 실전 가이드입니다.  
> 아키텍처 설명보다 **"무슨 일이 일어나고 있는가"**와 **"어떻게 바꾸는가"**에 집중합니다.

---

## 목차

1. [전체 연결 구조 한눈에 보기](#1-전체-연결-구조-한눈에-보기)
2. [초기 설치 흐름 단계별 분석](#2-초기-설치-흐름-단계별-분석)
3. [호스트 ↔ 컨테이너 연결 메커니즘 완전 분석](#3-호스트--컨테이너-연결-메커니즘-완전-분석)
4. [그룹 추가와 등록 흐름](#4-그룹-추가와-등록-흐름)
5. [컨테이너에 스킬 추가하기](#5-컨테이너에-스킬-추가하기)
6. [MCP 도구로 Claude가 호스트와 통신하는 방법](#6-mcp-도구로-claude가-호스트와-통신하는-방법)
7. [추가 마운트로 외부 폴더 접근](#7-추가-마운트로-외부-폴더-접근)
8. [스케줄 태스크 실전 사용](#8-스케줄-태스크-실전-사용)
9. [컨테이너별 agent-runner 커스터마이징](#9-컨테이너별-agent-runner-커스터마이징)
10. [디버깅: 연결 문제 추적 방법](#10-디버깅-연결-문제-추적-방법)

---

## 1. 전체 연결 구조 한눈에 보기

```
사용자 (WhatsApp)
     │
     ▼ 메시지 수신
┌─────────────────────────────────────────────────────────────┐
│  HOST PROCESS (src/index.ts)                                │
│                                                             │
│  WhatsApp ──→ SQLite DB ──→ 폴링(2초) ──→ GroupQueue        │
│                                              │               │
│  ◆ 활성 컨테이너 있음 → IPC 파일 직접 전달   │               │
│  ◆ 활성 컨테이너 없음 → 새 컨테이너 시작      │               │
└───────────────────────────────┬─────────────────────────────┘
                                │
              ① stdin: ContainerInput JSON
              ② 볼륨 마운트: 그룹폴더, IPC, 세션, agent-runner
                                │
                                ▼
┌───────────────────────────────────────────────────────────┐
│  CONTAINER (docker run --rm -i nanoclaw-agent:latest)     │
│                                                           │
│  agent-runner ──→ Claude SDK query() ──→ Anthropic API    │
│       │                    │                              │
│       │ IPC 파일 감시        │ 결과 수신                    │
│       ▼                    ▼                              │
│  MCP Server          writeOutput() → stdout               │
│  (ipc-mcp-stdio.js)                                       │
└───────────────────────────────────────────────────────────┘
                                │
              ③ stdout: OUTPUT_MARKER + ContainerOutput JSON
              ④ IPC 파일: messages/, tasks/ 디렉토리
                                │
                                ▼
                     HOST: 응답 수신 → WhatsApp 전송
```

**핵심 원칙**: 호스트와 컨테이너는 **stdin/stdout**(초기 입력/결과 수신)과 **공유 파일시스템**(팔로업 메시지, MCP 명령)으로만 통신합니다.

---

## 2. 초기 설치 흐름 단계별 분석

### 2.1 Claude Code를 통한 `/setup` 흐름

NanoClaw는 Claude Code를 "설치 도구"로 사용합니다. 초기 설치는 다음 단계로 진행됩니다:

```
터미널에서 claude 실행 후 /setup 입력
  │
  ▼
[setup/index.ts] 실행
  ├─ 1. environment  ─ Node 버전, Docker/Apple Container 확인
  ├─ 2. container    ─ Dockerfile 빌드 → nanoclaw-agent:latest 이미지 생성
  ├─ 3. groups       ─ groups/global/, groups/main/ 초기 폴더 생성
  ├─ 4. mounts       ─ ~/.config/nanoclaw/mount-allowlist.json 생성
  ├─ 5. register     ─ 메인 그룹 SQLite 등록 + CLAUDE.md 어시스턴트 이름 적용
  └─ 6. service      ─ 시스템 서비스 설정 (macOS: launchd, Linux: systemd/nohup)
```

### 2.2 컨테이너 이미지 빌드 (setup/container.ts)

```bash
# 내부적으로 실행되는 명령
docker build -t nanoclaw-agent:latest ./container/

# 검증 테스트
echo '{}' | docker run -i --rm --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

### 2.3 서비스 등록 (setup/service.ts)

#### macOS launchd 설정 파일 구조

```xml
<!-- ~/Library/LaunchAgents/com.nanoclaw.plist -->
<dict>
    <key>Label</key>             <string>com.nanoclaw</string>
    <key>ProgramArguments</key>  <!-- node /path/to/dist/index.js -->
    <key>WorkingDirectory</key>  <string>/path/to/nanoclaw</string>
    <key>RunAtLoad</key>         <true/>
    <key>KeepAlive</key>         <true/>   ← 크래시 시 자동 재시작
    <key>StandardOutPath</key>   <string>logs/nanoclaw.log</string>
    <key>StandardErrorPath</key> <string>logs/nanoclaw.error.log</string>
</dict>
```

```bash
# 서비스 관리 명령
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist    # 시작
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # 중지
tail -f logs/nanoclaw.log                                   # 로그 확인
```

#### Linux systemd 설정

```ini
# ~/.config/systemd/user/nanoclaw.service
[Service]
Type=simple
ExecStart=/usr/local/bin/node /path/to/dist/index.js
WorkingDirectory=/path/to/nanoclaw
Restart=always
RestartSec=5

# 명령
systemctl --user start nanoclaw
systemctl --user status nanoclaw
journalctl --user -u nanoclaw -f
```

---

## 3. 호스트 ↔ 컨테이너 연결 메커니즘 완전 분석

### 3.1 컨테이너 시작 시 전체 동작 순서

```
GroupQueue.runForGroup(chatJid, 'messages')
  │
  ├─ 1. processGroupMessages() 호출
  │     └─ 미처리 메시지 조회, XML 포맷 구성
  │
  ├─ 2. runAgent() 호출
  │     ├─ writeTasksSnapshot()  → data/env/{folder}/tasks.json 갱신
  │     └─ writeGroupsSnapshot() → data/env/{folder}/groups.json 갱신
  │
  ├─ 3. runContainerAgent() 호출
  │     ├─ buildVolumeMounts()   → 마운트 목록 구성
  │     ├─ buildContainerArgs()  → Docker 인수 구성
  │     └─ spawn(docker, args)   → 컨테이너 프로세스 시작
  │
  ├─ 4. stdin 주입
  │     ├─ input.secrets = readSecrets()   → .env에서 API 키 읽기
  │     ├─ stdin.write(JSON.stringify(input))
  │     ├─ stdin.end()
  │     └─ delete input.secrets           → 메모리에서 시크릿 제거
  │
  └─ 5. stdout 감시 시작
        └─ OUTPUT_MARKER 기반 스트리밍 파싱 → onOutput 콜백
```

### 3.2 공유되는 파일시스템 디렉토리 전체 맵

```
호스트 파일시스템                    컨테이너 내부 경로
────────────────────────────────────────────────────────
groups/{folder}/           →    /workspace/group/      (R/W)
groups/global/             →    /workspace/global/     (RO, 비메인)
{projectRoot}/             →    /workspace/project/    (RO, 메인만)
data/sessions/{folder}/.claude/ → /home/node/.claude/  (R/W)
data/sessions/{folder}/agent-runner-src/ → /app/src/  (R/W)
data/ipc/{folder}/         →    /workspace/ipc/        (R/W)
  ├─ input/                      (호스트→컨테이너 팔로업 메시지)
  ├─ messages/                   (컨테이너→호스트 메시지 전송)
  └─ tasks/                      (컨테이너→호스트 태스크 명령)
```

### 3.3 두 번째 메시지 처리 (컨테이너 재사용)

첫 번째 응답 후 컨테이너는 종료되지 않고 **IPC 대기 상태**로 남습니다:

```
[컨테이너 내 agent-runner]
  query() 완료 → 결과 writeOutput()
  → writeOutput({ status: 'success', result: null, newSessionId })  ← 세션 업데이트 마커
  → waitForIpcMessage() 진입  ← 500ms 간격으로 /workspace/ipc/input/ 폴링

[호스트]
  사용자가 두 번째 메시지 입력
  → queue.sendMessage(chatJid, text)
  → 활성 컨테이너 확인 → 있음
  → /workspace/ipc/input/{timestamp}-{random}.json 파일 생성
    내용: { "type": "message", "text": "<messages>...</messages>" }

[컨테이너 내 agent-runner]
  poll() → 파일 발견 → fs.readFileSync() → fs.unlinkSync()
  → waitForIpcMessage() 반환 (메시지 텍스트)
  → while 루프 → 새 runQuery() 시작
  → resume: 이전 sessionId, resumeAt: 이전 lastAssistantUuid
  → 대화 컨텍스트 이어받기
```

### 3.4 컨테이너 종료 신호 (_close sentinel)

```
[호스트가 컨테이너를 종료할 때]
  IDLE_TIMEOUT(30분) 후 GroupQueue.closeStdin(chatJid) 호출
  → /workspace/ipc/input/_close 파일 생성

[컨테이너 내 agent-runner]
  shouldClose() → fs.existsSync('_close') → true
  → fs.unlinkSync('_close')  ← 파일 삭제
  → null 반환 → 루프 break → 프로세스 정상 종료
  → docker --rm 플래그로 컨테이너 자동 삭제
```

---

## 4. 그룹 추가와 등록 흐름

### 4.1 신규 그룹을 추가하는 두 가지 방법

#### 방법 A: 메인 그룹의 Claude가 등록 (런타임 중)

메인 그룹에서 Claude에게 "새 그룹 추가해줘"라고 요청하면:

```
Claude (메인 컨테이너 내)
  → mcp__nanoclaw__register_group({
      jid: "120363336345536173@g.us",
      name: "개발팀",
      folder: "dev-team",
      trigger: "@Andy"
    })
  → MCP 서버(ipc-mcp-stdio.ts)가 파일 생성:
    /workspace/ipc/tasks/{timestamp}-{random}.json
    내용: { "type": "register_group", "jid": ..., "name": ..., ... }

호스트 IPC Watcher
  → 파일 감지 (1초 간격)
  → isMain 검증 (소스가 메인 그룹 폴더인지 확인)
  → setRegisteredGroup(jid, { name, folder, trigger, ... }) → SQLite 저장
  → groups/dev-team/logs/ 폴더 생성
  → registeredGroups 메모리 갱신
  → 즉시 메시지 수신 시작 가능
```

#### 방법 B: setup/register.ts 직접 실행 (CLI)

```bash
node dist/setup/index.js register \
  --jid "120363336345536173@g.us" \
  --name "개발팀" \
  --folder "dev-team" \
  --trigger "@Andy"
```

내부 동작:
1. `isValidGroupFolder("dev-team")` 검증 (알파벳/숫자/하이픈만 허용, `..` 차단)
2. `INSERT OR REPLACE` → SQLite `registered_groups` 테이블
3. `groups/dev-team/logs/` 폴더 자동 생성
4. 어시스턴트 이름이 Andy가 아니면 `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md` 자동 업데이트

### 4.2 그룹 폴더 유효성 검사 규칙

```typescript
// src/group-folder.ts
export function isValidGroupFolder(folder: string): boolean {
  // 영문자, 숫자, 하이픈만 허용
  // 최소 1자, 최대 64자
  // 경로 순회(../) 차단
  return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(folder);
}
```

유효한 폴더 이름 예시: `main`, `dev-team`, `family2`, `project-alpha`  
무효한 이름 예시: `../etc`, `my group`, `.hidden`, `a`.repeat(65)

### 4.3 그룹 등록 후 자동으로 생성되는 구조

```
groups/
  dev-team/                    ← 새 그룹 폴더
    logs/                      ← 컨테이너 실행 로그
    CLAUDE.md                  ← (선택) 그룹별 기억/지침 (claude가 자동 생성 가능)
    conversations/             ← 대화 아카이브 (컨텍스트 압축 시)

data/
  sessions/
    dev-team/
      .claude/                 ← Claude 세션 데이터 (그룹 격리)
        settings.json          ← 자동 생성 (Agent Teams, 추가 디렉토리 등 활성화)
        skills/                ← container/skills/ 에서 복사
      agent-runner-src/        ← agent-runner 소스 그룹별 복사본
  ipc/
    dev-team/
      input/                   ← 호스트 → 컨테이너 메시지
      messages/                ← 컨테이너 → 호스트 메시지 전송
      tasks/                   ← 컨테이너 → 호스트 태스크 명령
```

---

## 5. 컨테이너에 스킬 추가하기

스킬은 **Claude Code 스킬** 형태로 컨테이너 내 Claude에게 제공됩니다. 컨테이너에서 Claude가 `Skill` 도구를 호출하면 스킬 SKILL.md를 읽어 해당 도구 사용법을 학습합니다.

### 5.1 스킬 구조

```
container/skills/
  {skill-name}/
    SKILL.md          ← 스킬 정의 (필수)
      ┌─ frontmatter: name, description, allowed-tools
      └─ body: 사용법 설명, 명령어 레퍼런스, 예제
```

### 5.2 기본 제공 스킬: agent-browser

```
container/skills/agent-browser/SKILL.md
```

```yaml
---
name: agent-browser
description: Browse the web for any task — research topics, read articles, interact with web apps...
allowed-tools: Bash(agent-browser:*)
---
# Browser Automation with agent-browser
# Quick start
agent-browser open <url>       # 페이지 열기
agent-browser snapshot -i      # 인터랙티브 요소 스냅샷 (refs 포함)
agent-browser click @e1        # ref로 클릭
agent-browser fill @e2 "text"  # 입력 채우기
```

이 스킬 파일은 컨테이너 이미지에 이미 설치된 `agent-browser` CLI 도구의 사용법을 Claude에게 가르칩니다.

### 5.3 스킬이 컨테이너에 전달되는 경로

```
container/skills/{skill-name}/SKILL.md (소스)
           │
           ▼ container-runner.ts buildVolumeMounts() 에서 복사
data/sessions/{folder}/.claude/skills/{skill-name}/SKILL.md (그룹별 복사)
           │
           ▼ 컨테이너 실행 시 마운트
/home/node/.claude/skills/{skill-name}/SKILL.md (컨테이너 내부)
```

#### 복사 로직 (`buildVolumeMounts` 내부):

```typescript
const skillsSrc = path.join(process.cwd(), 'container', 'skills');
const skillsDst = path.join(groupSessionsDir, 'skills');  // .claude/skills/

if (fs.existsSync(skillsSrc)) {
  for (const skillDir of fs.readdirSync(skillsSrc)) {
    const srcDir = path.join(skillsSrc, skillDir);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    const dstDir = path.join(skillsDst, skillDir);
    fs.cpSync(srcDir, dstDir, { recursive: true });  // 매번 덮어씀
  }
}
```

**주의**: 스킬은 컨테이너 시작 시마다 `container/skills/`에서 복사됩니다. 즉, 컨테이너 내부에서 수정해도 다음 재시작 시 원래대로 되돌아갑니다. 영구 변경은 `container/skills/`를 수정해야 합니다.

### 5.4 새 스킬 추가하는 방법

#### 방법 A: 직접 스킬 파일 생성

```bash
# 1. 스킬 디렉토리 생성
mkdir container/skills/my-tool

# 2. SKILL.md 작성
cat > container/skills/my-tool/SKILL.md << 'EOF'
---
name: my-tool
description: 나만의 커스텀 도구 - JSON 파일을 파싱하고 분석합니다
allowed-tools: Bash(my-tool:*)
---

# my-tool 사용법

## 설치 확인
```bash
my-tool --version
```

## 기본 사용
```bash
my-tool parse input.json         # JSON 파싱
my-tool analyze input.json --verbose  # 상세 분석
```
EOF

# 3. 컨테이너 이미지 재빌드 (도구가 이미지에 없다면)
docker build -t nanoclaw-agent:latest ./container/
```

#### 방법 B: Claude Code 스킬 시스템 활용

`skills-engine/`의 apply 시스템을 사용하면 코드 파일도 함께 패칭할 수 있습니다 (복잡한 기능 추가 시).

### 5.5 그룹별로 다른 스킬 적용 (고급)

각 그룹은 자신만의 `agent-runner-src/` 사본을 가집니다. 특정 그룹에만 다른 도구를 추가하려면:

```
data/sessions/dev-team/agent-runner-src/index.ts  ← 이 파일 직접 수정
                                                    (개발팀 컨테이너에만 적용)

data/sessions/family/agent-runner-src/index.ts    ← 원본 유지
                                                   (가족 그룹은 기본 동작)
```

단, 이 파일은 컨테이너의 `entrypoint.sh`가 시작 시 `npm run build`로 재컴파일하므로, TypeScript 문법이 올바라야 합니다.

---

## 6. MCP 도구로 Claude가 호스트와 통신하는 방법

### 6.1 MCP 서버(`ipc-mcp-stdio.ts`) 란?

컨테이너 내 Claude가 호스트에 명령을 내릴 수 있는 **Model Context Protocol 도구 모음**입니다. `agent-runner`가 `query()` 실행 시 이 서버를 subprocess로 시작합니다.

```typescript
// agent-runner/src/index.ts 의 query() 옵션에서
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: ['/app/dist/ipc-mcp-stdio.js'],  // MCP 서버 실행
    env: {                                  // 컨텍스트 전달
      NANOCLAW_CHAT_JID: "120363...@g.us",
      NANOCLAW_GROUP_FOLDER: "dev-team",
      NANOCLAW_IS_MAIN: "0",
    },
  },
}
```

### 6.2 사용 가능한 MCP 도구 전체 목록

Claude가 대화 중 실제로 호출할 수 있는 도구들:

| 도구                            | 설명                                           | 권한                          |
| ------------------------------- | ---------------------------------------------- | ----------------------------- |
| `mcp__nanoclaw__send_message`   | 사용자에게 메시지 즉시 전송 (중간 결과물 보고) | 모든 그룹                     |
| `mcp__nanoclaw__schedule_task`  | 반복/일회성 태스크 예약                        | 모든 그룹 (자신에게만)        |
| `mcp__nanoclaw__list_tasks`     | 예약된 태스크 조회                             | 메인: 전체, 비메인: 자기 것만 |
| `mcp__nanoclaw__pause_task`     | 태스크 일시정지                                | 자신의 태스크만               |
| `mcp__nanoclaw__resume_task`    | 태스크 재개                                    | 자신의 태스크만               |
| `mcp__nanoclaw__cancel_task`    | 태스크 삭제                                    | 자신의 태스크만               |
| `mcp__nanoclaw__register_group` | 새 그룹 등록                                   | **메인 그룹만**               |

### 6.3 `send_message` 동작 상세

```
Claude: mcp__nanoclaw__send_message({ text: "중간 처리 완료: 50%" })

MCP 서버(ipc-mcp-stdio.ts):
  → writeIpcFile(MESSAGES_DIR, {
      type: "message",
      chatJid: "120363...@g.us",
      text: "중간 처리 완료: 50%",
      groupFolder: "dev-team",
      timestamp: "2026-02-25T02:00:00.000Z"
    })
  → /workspace/ipc/messages/{timestamp}-{random}.json 원자 쓰기

호스트 IPC Watcher(src/ipc.ts):
  → 파일 감지 → 읽기 → 삭제
  → processMessageIpc(data)
  → channel.sendMessage(chatJid, text) → WhatsApp 전송
```

**활용 시나리오**: 장시간 작업(웹 스크래핑, 코드 실행 등)에서 진행 상황을 사용자에게 실시간으로 보고할 때 유용합니다. 최종 응답이 나오기를 30분 기다리지 않아도 됩니다.

### 6.4 `schedule_task` 동작 상세

```
Claude: mcp__nanoclaw__schedule_task({
  prompt: "매일 아침 9시에 날씨를 알려줘",
  schedule_type: "cron",
  schedule_value: "0 9 * * *",
  context_mode: "isolated"  // 독립 세션 (매번 새로운 컨텍스트)
})

MCP 서버:
  → cron 유효성 검사 ("0 9 * * *" ← 유효)
  → writeIpcFile(TASKS_DIR, {
      type: "schedule_task",
      prompt: "매일 아침 9시에 날씨를 알려줘",
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      context_mode: "isolated",
      targetJid: "120363...@g.us",
      createdBy: "dev-team",
      timestamp: ...
    })

호스트 IPC Watcher:
  → processTaskIpc()
  → createTask({
      id: uuid(),
      group_folder: resolveGroupForJid(targetJid),
      chat_jid: targetJid,
      prompt: ...,
      schedule_type: "cron",
      schedule_value: "0 9 * * *",
      context_mode: "isolated",
      next_run: cron.next().toISOString(),
      status: "active",
      created_at: ...
    }) → SQLite 저장

Scheduler Loop (60초 간격):
  → getDueTasks(): SELECT * WHERE status='active' AND next_run <= now
  → queue.enqueueTask() → 새 컨테이너 시작 → Claude 실행
```

---

## 7. 추가 마운트로 외부 폴더 접근

### 7.1 allowlist 파일 생성

추가 마운트를 사용하기 위해 먼저 화이트리스트 파일을 생성합니다:

```bash
mkdir -p ~/.config/nanoclaw
cat > ~/.config/nanoclaw/mount-allowlist.json << 'EOF'
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "개발 프로젝트 디렉토리"
    },
    {
      "path": "~/Documents/work",
      "allowReadWrite": false,
      "description": "업무 문서 (읽기 전용)"
    }
  ],
  "blockedPatterns": [
    "password",
    "secret",
    "token"
  ],
  "nonMainReadOnly": true
}
EOF
```

**중요**: 이 파일은 `~/.config/nanoclaw/`에 저장됩니다. 컨테이너가 마운트할 수 없는 경로이므로, 컨테이너 내에서 화이트리스트 자체를 수정할 수 없습니다.

### 7.2 그룹에 추가 마운트 설정

메인 그룹 Claude에게 요청하거나 DB를 직접 수정합니다:

```javascript
// DB에서 registered_groups의 container_config 컬럼 업데이트
// container_config는 JSON 문자열로 저장됨
{
  "additionalMounts": [
    {
      "hostPath": "~/projects/my-app",
      "containerPath": "my-app",     // /workspace/extra/my-app/ 으로 마운트
      "readonly": false              // 비메인 그룹은 allowlist.nonMainReadOnly=true면 강제 RO
    }
  ],
  "timeout": 3600000  // 이 그룹의 컨테이너 최대 실행 시간 (선택)
}
```

### 7.3 마운트 검증 6단계 프로세스

```
AdditionalMount 요청 처리 시:
  
  1. loadMountAllowlist()
     → ~/.config/nanoclaw/mount-allowlist.json 읽기 (없으면 전체 차단)

  2. isValidContainerPath(containerPath)
     → ".." 포함 시 거부
     → "/" 로 시작 시 거부 ("/workspace/extra/" prefix 보장)

  3. expandPath(hostPath) → 절대 경로로 변환 ("~/" 확장)

  4. getRealPath(expanded) → 심볼링크 해석
     → 경로가 없으면 거부

  5. matchesBlockedPattern(realPath, blockedPatterns)
     → ".ssh", ".aws", "credentials", "private_key" 등 차단 패턴 확인
     → 경로 컴포넌트별 및 전체 경로 확인

  6. findAllowedRoot(realPath, allowedRoots)
     → path.relative()로 allowedRoot 하위 경로인지 확인
     → 해당 없으면 거부

  최종: 비메인 그룹 + nonMainReadOnly=true → 강제 읽기전용
```

### 7.4 컨테이너 내에서 추가 마운트 접근

```bash
# 컨테이너 내 Claude가 Bash 도구로 접근하는 경로
ls /workspace/extra/my-app/    # 추가 마운트된 디렉토리
cat /workspace/extra/my-app/README.md
```

추가 디렉토리에 `CLAUDE.md`가 있으면 자동으로 시스템 컨텍스트에 포함됩니다 (`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` 설정 덕분).

---

## 8. 스케줄 태스크 실전 사용

### 8.1 태스크 유형별 사용 시나리오

#### cron 타입 (정기 반복)

```
사용자: "@Andy 매일 오전 9시에 오늘의 날씨와 주요 뉴스를 요약해줘"

Claude 내부 처리:
  schedule_type: "cron"
  schedule_value: "0 9 * * *"    # 매일 9시 (로컬 타임존)
  context_mode: "isolated"        # 독립 세션 (매번 새로 시작)
  prompt: "사용자에게 오늘의 날씨(서울 기준)와 주요 뉴스를 요약해서 한국어로 전달하세요"
```

#### interval 타입 (N분마다)

```
사용자: "@Andy 30분마다 내 서버 상태 체크해줘"

schedule_type: "interval"
schedule_value: "1800000"   # 30분 = 30 * 60 * 1000ms
```

#### once 타입 (한 번만)

```
사용자: "@Andy 오후 3시에 회의 알림 보내줘"

schedule_type: "once"
schedule_value: "2026-02-25T15:00:00"   # Z 접미사 없이 로컬 시간!
```

### 8.2 context_mode 선택 가이드

| 상황                                           | 추천 mode  | 이유                                  |
| ---------------------------------------------- | ---------- | ------------------------------------- |
| "어제 우리가 논의한 내용 기반으로 리포트 작성" | `group`    | 대화 기록 필요                        |
| "매일 전국 날씨 요약"                          | `isolated` | 독립적 정보, 컨텍스트 불필요          |
| "내가 요청한 작업 진행 상황 업데이트"          | `group`    | '내가 요청한 작업'을 알려면 기록 필요 |
| "매시간 CPU 사용률 체크 후 85% 초과 시 알림"   | `isolated` | prompt에 모든 정보 포함 가능          |

### 8.3 태스크 실행 중 컨테이너 동작

```
Scheduler Loop → getDueTasks() → task 발견
  → queue.enqueueTask(chatJid, taskId, () => runTask(task))
  → isTaskContainer = true 로 컨테이너 시작 (sendMessage 차단)
  → ContainerInput.isScheduledTask = true
  → agent-runner에서 prompt에 prefix 자동 추가:
    "[SCHEDULED TASK - The following message was sent automatically...]"

태스크 완료 시:
  → TASK_CLOSE_DELAY_MS (10초) 후 _close sentinel 전송
  → 일반 채팅 컨테이너처럼 30분 대기 없이 즉시 정리
  → updateTaskAfterRun() → next_run 재계산 → DB 저장
```

---

## 9. 컨테이너별 agent-runner 커스터마이징

### 9.1 agent-runner 복사 타이밍

최초 컨테이너 실행 전, `buildVolumeMounts()`에서 한 번만 복사:

```typescript
const agentRunnerSrc = 'container/agent-runner/src';
const groupRunnerDir = 'data/sessions/{folder}/agent-runner-src';

if (!fs.existsSync(groupRunnerDir)) {  // ← 최초 1회만
  fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
}
```

이후 `groupRunnerDir`가 존재하면 복사하지 않으므로, 그룹별로 수정된 파일이 유지됩니다.

### 9.2 agent-runner에 커스텀 도구 추가하기

```typescript
// data/sessions/dev-team/agent-runner-src/index.ts 수정 예시

// 기존 허용 도구 목록에 커스텀 도구 추가:
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  // ... 기존 도구들 ...
  'mcp__nanoclaw__*',
  'mcp__my_custom_tool__*',  // ← 추가
],

// 커스텀 MCP 서버 추가:
mcpServers: {
  nanoclaw: { /* 기존 */ },
  my_custom_tool: {           // ← 추가
    command: 'node',
    args: ['/app/dist/my-mcp-server.js'],
    env: { MY_CONFIG: 'value' },
  },
},
```

그 후 컨테이너가 시작될 때 `entrypoint.sh`가 `npm run build`로 TypeScript를 재컴파일합니다.

### 9.3 entrypoint.sh의 재빌드 흐름

```bash
# container/entrypoint.sh (개략적 내용)
#!/bin/sh
# /app/src는 호스트에서 마운트된 그룹별 agent-runner 소스
# 변경이 있으면 빌드 필요

cd /app
if [ -d /app/src ]; then
  # 소스가 마운트된 경우 재빌드
  npm run build 2>&1 | tail -5
fi

# agent-runner 실행
exec node /app/dist/index.js
```

---

## 10. 디버깅: 연결 문제 추적 방법

### 10.1 로그 위치

```
logs/nanoclaw.log          ← 호스트 프로세스 로그 (pino JSON 형식)
logs/nanoclaw.error.log    ← 에러 로그

groups/{folder}/logs/      ← 컨테이너 실행별 로그 파일
  container-2026-02-25T12-00-00-000Z.log
  container-{timestamp}-TIMEOUT.log  ← 타임아웃 발생 시

data/ipc/{folder}/input/  ← 팔로업 메시지 디렉토리 (처리 후 삭제됨)
data/ipc/{folder}/tasks/  ← 태스크 IPC 파일 (처리 후 삭제됨)
data/ipc/errors/          ← 처리 실패한 IPC 파일 격리 보관
```

### 10.2 컨테이너 연결 문제 체크리스트

```bash
# 1. Docker 데몬 확인
docker info

# 2. 컨테이너 이미지 존재 확인
docker images nanoclaw-agent:latest

# 3. 현재 실행 중인 컨테이너 확인
docker ps --filter "name=nanoclaw-"

# 4. 고아 컨테이너 정리 (호스트 재시작 없이)
docker ps -q --filter "name=nanoclaw-" | xargs docker stop

# 5. IPC 디렉토리 확인
ls -la data/ipc/main/input/    # 팔로업 메시지 잔존 파일 확인
ls -la data/ipc/errors/        # 실패한 IPC 파일 확인
```

### 10.3 실시간 컨테이너 출력 보기

```bash
# 특정 그룹 컨테이너의 stderr 실시간 확인 (agent-runner 로그)
docker logs -f $(docker ps -q --filter "name=nanoclaw-dev-team-")

# 출력 예시:
# [agent-runner] Received input for group: dev-team
# [agent-runner] [msg #1] type=system/init
# [agent-runner] Session initialized: abc-123
# [agent-runner] [msg #5] type=assistant
# [agent-runner] Result #1: subtype=success text=안녕하세요!...
```

### 10.4 스킬이 적용되지 않을 때

```bash
# 스킬 복사 확인
ls data/sessions/{folder}/.claude/skills/

# 스킬 내용 확인 (컨테이너 밖에서)
cat data/sessions/dev-team/.claude/skills/agent-browser/SKILL.md

# 컨테이너가 이미 실행 중이라면 다음 재시작 시 갱신됨
# 강제 갱신 방법: 스킬 디렉토리 직접 복사
cp -r container/skills/agent-browser/ \
       data/sessions/dev-team/.claude/skills/agent-browser/
```

### 10.5 세션이 이어지지 않을 때

```bash
# 현재 저장된 세션 ID 확인 (SQLite)
sqlite3 store/messages.db "SELECT group_folder, session_id FROM sessions;"

# 세션 초기화 (다음 실행 시 새 세션 시작)
sqlite3 store/messages.db "DELETE FROM sessions WHERE group_folder='dev-team';"

# Claude 세션 파일 확인
ls data/sessions/dev-team/.claude/projects/
```

---

## 실제 사용 흐름 요약: 처음부터 대화까지

```
1. 설치 (최초 1회)
   claude /setup
   → 컨테이너 이미지 빌드 + 서비스 등록

2. WhatsApp 연결
   → QR 코드 인증 → store/auth/ 에 세션 저장

3. 그룹 등록 (메인 그룹에서)
   "@Andy 개발팀 그룹 추가해줘 JID는 1234@g.us"
   → register_group IPC → SQLite 저장

4. 첫 메시지
   개발팀 그룹: "@Andy 안녕?"
   → DB 저장 → 폴링 감지 → 컨테이너 시작
   → stdin에 ContainerInput JSON 주입
   → Claude API 호출 → 응답 생성
   → stdout OUTPUT_MARKER → WhatsApp 전송

5. 팔로업 메시지
   개발팀 그룹: "@Andy 더 자세히 설명해줘"
   → 기존 컨테이너에 IPC 파일 전달
   → 대화 컨텍스트 이어받기 → 응답

6. 스킬 활용
   "@Andy 구글 뉴스 스크래핑해줘"
   → Claude가 Skill("agent-browser") 호출
   → SKILL.md 읽기 → agent-browser 명령 실행

7. 스케줄 등록
   "@Andy 매일 9시에 날씨 알려줘"
   → schedule_task IPC → DB 저장
   → 다음 날 9시에 새 컨테이너 자동 시작
```

---

*최종 업데이트: 2026-02-25*  
*관련 문서: ARCHITECTURE_ANALYSIS_ko.md, ARCHITECTURE_ANALYSIS_SUPPLEMENT_ko.md*
