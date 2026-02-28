# NanoClaw 스킬 엔진(Skills Engine) 실전 가이드

> **대상**: NanoClaw 코어를 확장하거나 커스터마이징하려는 개발자  
> **핵심 개념**: 스킬 엔진은 플러그인 시스템이 아니라 **Git 3-way merge 기반 코드 패칭** 시스템입니다.

---

## 목차

1. [스킬 엔진이란 무엇인가](#1-스킬-엔진이란-무엇인가)
2. [디렉토리 구조와 역할](#2-디렉토리-구조와-역할)
3. [스킬 패키지 구조 상세](#3-스킬-패키지-구조-상세)
4. [스킬 초기화 (initSkillsSystem)](#4-스킬-초기화-initskillssystem)
5. [스킬 적용 완전 분석 (applySkill)](#5-스킬-적용-완전-분석-applyskill)
6. [상태 관리: .nanoclaw/state.yaml](#6-상태-관리-nanoclaw-stateyaml)
7. [커스터마이즈 세션: 사용자 수정 보존](#7-커스터마이즈-세션-사용자-수정-보존)
8. [스킬 제거 (uninstallSkill)](#8-스킬-제거-uninstallskill)
9. [코어 업데이트 (applyUpdate)](#9-코어-업데이트-applyupdate)
10. [실전: 새 스킬 작성하기](#10-실전-새-스킬-작성하기)
11. [흔한 에러와 해결법](#11-흔한-에러와-해결법)

---

## 1. 스킬 엔진이란 무엇인가

### 1.1 기본 개념

NanoClaw는 "코어(core)"라는 기본 코드베이스 위에 "스킬(skill)"이라는 코드 패치를 쌓는 방식으로 기능을 확장합니다.

```
코어(core)        = 기본 NanoClaw 코드 (src/, container/, 설정 파일들)
스킬(skill)       = 코어를 특정 방향으로 변형하는 패치 패키지
베이스(base)      = 스킬이 처음 적용될 때의 코어 스냅샷 (3-way merge의 공통 조상)
커스터마이즈      = 사용자가 직접 가한 수정 (스킬과 분리하여 추적)
```

### 1.2 왜 플러그인 시스템이 아닌가?

| 플러그인 시스템               | 스킬 엔진 (3-way merge)         |
| ----------------------------- | ------------------------------- |
| API 경계 필요                 | 임의의 파일 어디든 수정 가능    |
| 코어 변경 시 플러그인이 깨짐  | 3-way merge로 자동 조정         |
| 런타임 격리                   | 컴파일타임 통합                 |
| 코어를 "작게" 유지하기 어려움 | 코어는 최소, 기능은 스킬로 추가 |

### 1.3 전체 상태 구조 예시

```yaml
# .nanoclaw/state.yaml
skills_system_version: "1.0.0"
core_version: "0.3.1"
applied_skills:
  - name: telegram-channel
    version: "1.2.0"
    applied_at: "2026-02-20T10:00:00Z"
    file_hashes:
      src/channels/telegram.ts: "abc123..."
      src/index.ts: "def456..."
  - name: redis-cache
    version: "0.5.0"
    applied_at: "2026-02-21T09:00:00Z"
    file_hashes:
      src/cache.ts: "ghi789..."
custom_modifications:
  - description: "whatsapp timeout 조정"
    applied_at: "2026-02-22T14:00:00Z"
    files_modified:
      - src/config.ts
    patch_file: ".nanoclaw/custom/001-whatsapp-timeout-조정.patch"
```

---

## 2. 디렉토리 구조와 역할

```
프로젝트 루트/
  .nanoclaw/
    state.yaml          ← 현재 적용된 스킬 목록 및 파일 해시 (핵심 상태)
    base/               ← 클린 코어 스냅샷 (3-way merge의 공통 조상)
      src/
        index.ts        ← "스킬 적용 전" 원본 파일
        ...
    backup/             ← 스킬 적용 중 실패 시 복원용 (임시, 성공 후 삭제)
    custom/
      pending.yaml      ← 커스터마이즈 세션 진행 중일 때만 존재
      001-my-change.patch  ← 커밋된 커스터마이즈 패치 파일
    resolutions/        ← 검증된 3-way merge 충돌 해결 캐시

  skills-engine/        ← 스킬 엔진 소스 (TypeScript)
    apply.ts            ← applySkill() 핵심 로직
    uninstall.ts        ← uninstallSkill() 로직
    update.ts           ← applyUpdate() 로직
    state.ts            ← state.yaml 읽기/쓰기
    customize.ts        ← 커스터마이즈 세션 관리
    ...
```

---

## 3. 스킬 패키지 구조 상세

### 3.1 디렉토리 레이아웃

```
my-skill/              ← 스킬 루트 디렉토리
  manifest.yaml        ← 스킬 메타데이터 및 선언 (필수)
  add/                 ← 새로 추가할 파일들 (없으면 생략 가능)
    src/
      new-feature.ts   ← 코어에 없던 새 파일
  modify/              ← 기존 파일을 패치할 버전들 (없으면 생략 가능)
    src/
      index.ts         ← 기존 index.ts의 "수정된 버전"
  migrations/          ← (선택) 코어 업데이트 시 함께 실행할 마이그레이션
    v0.4.0-migration.yaml
```

### 3.2 manifest.yaml 전체 필드 설명

```yaml
skill: "telegram-channel"           # 스킬 식별자 (고유, 소문자-하이픈)
version: "1.2.0"                    # 스킬 버전 (semver)
description: "Telegram 채널 지원 추가"
core_version: "0.3.x"              # 대상 코어 버전 (x = 와일드카드)

# 완전히 새로 추가하는 파일 목록 (add/ 디렉토리에 있어야 함)
adds:
  - src/channels/telegram.ts
  - src/channels/telegram-auth.ts

# 기존 파일을 수정하는 목록 (modify/ 디렉토리에 있어야 함)
modifies:
  - src/index.ts
  - src/types.ts

# 구조적 변경 (파일 내용 직접 수정 대신 merge 처리)
structured:
  npm_dependencies:           # package.json에 추가할 패키지
    "node-telegram-bot-api": "^0.64.0"
  env_additions:              # .env.example에 추가할 변수
    - "TELEGRAM_BOT_TOKEN=your_token_here"
  docker_compose_services:    # docker-compose.yml에 추가할 서비스
    telegram-webhook:
      image: nginx:alpine
      ports: ["8080:80"]

# 파일 이름 변경/삭제/이동 (apply 전 먼저 실행)
file_ops:
  - type: rename
    from: src/channels/old-name.ts
    to: src/channels/telegram.ts
  - type: delete
    path: src/deprecated-module.ts

# 충돌하는 스킬 목록 (함께 적용 불가)
conflicts:
  - discord-channel    # 채널 구현이 충돌

# 필요한 선행 스킬 목록
depends:
  - base-channel-interface

# 적용 후 검증 명령 (실패 시 자동 롤백)
test: "npx vitest run src/channels/telegram.test.ts"

# 적용 후 실행할 명령들 (test 이전)
post_apply:
  - "npm run build"

# 메타 정보 (선택)
author: "team@example.com"
license: "MIT"
min_skills_system_version: "1.0.0"
tested_with:
  - "0.3.0"
  - "0.3.1"
```

### 3.3 modify/ 파일 작성 방법

`modify/src/index.ts`는 스킬이 적용된 최종 결과물이어야 합니다. 3-way merge 시 아래처럼 사용됩니다:

```
            공통 조상 (.nanoclaw/base/src/index.ts)
                 /                  \
현재 파일              스킬 파일 (modify/src/index.ts)
(사용자 커스터마이즈 포함)
                 \                  /
              3-way merge 결과
              → 충돌 없으면 자동 적용
              → 충돌 있으면 conflict marker
```

---

## 4. 스킬 초기화 (initSkillsSystem)

### 4.1 `skills-engine/init.ts` 동작

```typescript
initSkillsSystem(coreVersion: string)

// 수행 작업:
// 1. .nanoclaw/ 디렉토리 생성
// 2. base/ 에 현재 src/ 스냅샷 복사 (3-way merge 기반점)
// 3. .nanoclaw/state.yaml 생성:
//    { skills_system_version, core_version, applied_skills: [] }
```

**언제 호출하는가**: NanoClaw 최초 설치 시, Claude Code `claude /setup` 과정에서 자동 실행됩니다.

### 4.2 베이스(base) 스냅샷의 중요성

```
base/src/index.ts = "스킬 S를 처음 적용하던 당시의 index.ts"

없으면 어떻게 되나:
  apply.ts 내에서 최초 적용 시 현재 파일을 base로 복사합니다:
  if (!fs.existsSync(basePath)) {
    fs.copyFileSync(currentPath, basePath);  // 현재 → base
  }
  → 이후 3-way merge 시 공통 조상으로 활용
```

---

## 5. 스킬 적용 완전 분석 (applySkill)

### 5.1 전체 실행 흐름

```
applySkill(skillDir)
│
├─ [Pre-flight 검사]
│   ├─ readState()            → .nanoclaw/state.yaml 읽기 (없으면 에러)
│   ├─ checkSystemVersion()   → skills_system_version 호환성
│   ├─ checkCoreVersion()     → core_version 일치 여부 (경고만)
│   ├─ isCustomizeActive()    → pending.yaml 존재 시 차단
│   ├─ checkDependencies()    → depends 스킬 적용 여부
│   └─ checkConflicts()       → conflicts 스킬 적용 여부
│
├─ [드리프트(drift) 감지]
│   └─ modifies 파일별: computeFileHash(current) vs computeFileHash(base)
│      → 다르면 driftFiles 목록에 추가 (경고 출력, 계속 진행)
│
├─ [파일 잠금] acquireLock()   → .nanoclaw/lock 파일 생성
│
├─ [백업] createBackup(filesToBackup)
│           → .nanoclaw/backup/ 에 현재 파일들 복사
│
├─ [파일 작업] executeFileOps(manifest.file_ops)
│           → rename, delete, move 순서대로 실행
│           → 실패 시: restoreBackup() + clearBackup() → 반환
│
├─ [새 파일 복사] add/ → projectRoot/
│           → manifest.adds 목록의 파일들 복사
│           → addedFiles 목록에 추가 (롤백용)
│
├─ [3-way merge] manifest.modifies 파일별
│   ├─ current: projectRoot/src/index.ts
│   ├─ base: .nanoclaw/base/src/index.ts
│   └─ skill: skillDir/modify/src/index.ts
│
│   mergeFile(tmpCurrent, basePath, skillPath)
│     → git merge-file tmpCurrent basePath skillPath
│     → clean merge: copyFileSync(tmp → current)
│     → conflict: conflict marker 삽입된 채 저장
│
│   충돌 발생 시:
│   → mergeConflicts 목록 반환
│   → backupPending: true (백업 유지, 수동 해결 후 recordSkillApplication() 호출)
│
├─ [구조적 작업]
│   ├─ mergeNpmDependencies()   → package.json 병합
│   ├─ mergeEnvAdditions()      → .env.example 병합
│   ├─ mergeDockerComposeServices() → docker-compose.yml 병합
│   └─ runNpmInstall()          → npm dependencies 추가 시 한 번
│
├─ [post_apply 명령]
│   └─ manifest.post_apply 명령 실행 (실패 시 롤백)
│
├─ [상태 업데이트] recordSkillApplication()
│   └─ state.yaml → applied_skills에 추가 (파일 해시 포함)
│
├─ [테스트 실행] manifest.test 명령 실행
│   └─ 실패 시: addedFiles 삭제 + restoreBackup() + 상태 롤백 + clearBackup()
│
└─ [성공] clearBackup() → 반환 { success: true }
```

### 5.2 3-way merge 충돌 해결 절차

충돌 발생 시 `applySkill()`이 반환하는 값:

```typescript
{
  success: false,
  skill: "telegram-channel",
  version: "1.2.0",
  mergeConflicts: ["src/index.ts"],
  backupPending: true,
  error: "Merge conflicts in: src/index.ts. Resolve manually then run recordSkillApplication()..."
}
```

**수동 해결 절차**:

```bash
# 1. 충돌 마커 확인
grep -n "<<<<<<" src/index.ts

# 2. 편집기로 충돌 해결
code src/index.ts

# 3. 해결 후 recordSkillApplication() 호출
node -e "
  import('./skills-engine/index.js').then(m => {
    m.recordSkillApplication('telegram-channel', '1.2.0', {
      'src/index.ts': '<hash>'
    });
    m.clearBackup();
  });
"

# 4. 또는 전체 롤백 (abort)
node -e "
  import('./skills-engine/index.js').then(m => {
    m.restoreBackup();
    m.clearBackup();
  });
"
```

---

## 6. 상태 관리: .nanoclaw/state.yaml

### 6.1 state.yaml 역할

```yaml
# 이 파일이 하는 일:
# 1. 어떤 스킬이 어떤 버전으로 적용되었는지 기록
# 2. 각 스킬이 수정한 파일의 SHA-256 해시 보관 (드리프트 감지용)
# 3. 커스터마이즈 패치 목록 관리
# 4. 코어 버전 추적
```

### 6.2 드리프트(drift)란?

```
상황: 스킬 A가 src/index.ts를 수정함 → file_hashes 저장
사용자가 src/index.ts를 직접 편집함 (커스터마이즈)
스킬 B를 적용하려 할 때:

  computeFileHash(현재 index.ts) ≠ state.yaml의 hash
  → "Drift detected in: src/index.ts"
  → 경고 출력 (중단하지 않음)
  → 3-way merge에서 사용자 변경사항 보존 시도
```

### 6.3 주요 state.ts 함수

```typescript
readState()              // state.yaml 읽기 (없으면 에러)
writeState(state)        // 원자 쓰기 (tmp → rename)
recordSkillApplication() // applied_skills에 스킬 추가/갱신
getAppliedSkills()       // 현재 적용된 스킬 목록
recordCustomModification() // custom_modifications에 패치 기록
computeFileHash(path)    // SHA-256 해시 계산
compareSemver(a, b)      // semver 비교 (-1/0/1)
```

---

## 7. 커스터마이즈 세션: 사용자 수정 보존

### 7.1 커스터마이즈 세션이 필요한 이유

스킬이 관리하는 파일을 직접 수정하면, 다음 스킬 업데이트 때 변경사항이 덮어씌워질 수 있습니다. 커스터마이즈 세션은 이 수정을 **패치 파일로 보존**하고, 나중에 새 코어/스킬에 **재현(replay)** 할 수 있게 합니다.

### 7.2 커스터마이즈 세션 사용법

```typescript
// 1. 세션 시작 (변경 전 스냅샷)
startCustomize("WhatsApp timeout 값 조정")
// → .nanoclaw/custom/pending.yaml 생성
//   (현재 모든 스킬 파일의 해시 기록)

// 2. 원하는 파일 수정
// src/config.ts에서 POLL_INTERVAL = 5000으로 변경 등

// 3. 변경 완료 후 커밋
commitCustomize()
// → 해시 비교로 변경된 파일 감지
// → diff 명령으로 unified patch 생성
// → .nanoclaw/custom/001-whatsapp-timeout-조정.patch 저장
// → state.yaml의 custom_modifications에 기록
// → pending.yaml 삭제

// 또는 중단
abortCustomize()
// → pending.yaml 삭제 (변경사항은 그대로 남음)
```

### 7.3 생성된 패치 파일 형식

```diff
--- .nanoclaw/base/src/config.ts
+++ src/config.ts
@@ -18,7 +18,7 @@
 
-export const POLL_INTERVAL = 2000;
+export const POLL_INTERVAL = 5000;  // WhatsApp 과부하 방지
 export const SCHEDULER_POLL_INTERVAL = 60000;
```

### 7.4 커스터마이즈와 스킬 적용의 관계

```
커스터마이즈 세션 활성 중 → 스킬 적용 차단됨

이유:
  커스터마이즈 세션 중에 구조적 변경이 섞이면
  패치 파일의 범위를 정확히 알 수 없어집니다.
  
해결:
  commitCustomize() 또는 abortCustomize() 후 스킬 적용
```

---

## 8. 스킬 제거 (uninstallSkill)

### 8.1 제거 방식: "재재생(replay)"

스킬을 직접 되돌리는 대신, **다른 스킬들을 새로 재적용**하여 대상 스킬을 건너뜁니다:

```
현재 상태: 코어 + 스킬A + 스킬B + 스킬C
스킬B 제거 요청

uninstallSkill("my-skill-b"):
  1. 백업 생성
  2. 현재 파일들을 base/ 로 초기화 (역방향 되돌기는 불가)
  3. 스킬A 재적용
  4. 스킬C 재적용 (스킬B 건너뜀)
  5. custom_modifications 패치 재적용
  6. state.yaml → applied_skills에서 스킬B 제거
  7. 테스트 실행
```

### 8.2 제거 불가 케이스

```typescript
// 다른 스킬이 의존하는 경우
uninstallSkill("base-channel-interface")
// → Error: Cannot uninstall: skills [telegram-channel, discord-channel] depend on this skill
```

---

## 9. 코어 업데이트 (applyUpdate)

### 9.1 코어 업데이트란?

NanoClaw 코어 자체가 새 버전으로 업데이트될 때, 기존에 적용된 스킬과 커스터마이즈 패치를 새 코어 위에 이식(rebase)하는 과정입니다.

```
현재: 코어 v0.3.1 + 스킬A + 스킬B + 커스터마이즈 패치
↓
목표: 코어 v0.4.0 + 스킬A(재적용) + 스킬B(재적용) + 커스터마이즈 패치(재적용)
```

### 9.2 `applyUpdate()` 흐름

```
applyUpdate(newCoreDir, newVersion)

1. 프리뷰 생성 (preview: UpdatePreview)
   → 변경/삭제된 파일 목록, 충돌 위험 파일, 커스터마이즈 패치 위험

2. 백업 생성

3. 새 코어 파일 복사 (3-way merge)
   각 파일: current ← old_base → new_core
   
4. 마이그레이션 스킬 적용 (migrations/ 디렉토리)
   migrate.ts: new_base → 경로 재매핑 등 자동 처리

5. path_remap 갱신 (파일 이름이 바뀐 경우)
   .nanoclaw/state.yaml.path_remap 업데이트

6. 스킬 재적용 (순서 유지)
   각 스킬 applySkill() 재실행
   실패한 스킬 → skillReapplyResults 기록

7. 커스터마이즈 패치 재적용
   git apply .nanoclaw/custom/001-*.patch

8. base/ 갱신 (새 코어가 새 기반점)

9. state.yaml core_version 업데이트
```

---

## 10. 실전: 새 스킬 작성하기

### 10.1 시나리오: Telegram 채널 추가

#### 단계 1. 스킬 디렉토리 생성

```bash
mkdir -p my-skills/telegram-channel/{add,modify}/src/channels
```

#### 단계 2. manifest.yaml 작성

```yaml
# my-skills/telegram-channel/manifest.yaml
skill: telegram-channel
version: "1.0.0"
description: "Telegram Bot API를 통한 채널 지원"
core_version: "0.3.x"

adds:
  - src/channels/telegram.ts

modifies:
  - src/index.ts
  - src/types.ts

structured:
  npm_dependencies:
    "node-telegram-bot-api": "^0.64.0"
  env_additions:
    - "TELEGRAM_BOT_TOKEN=your_bot_token  # BotFather에서 발급"

conflicts:
  - discord-channel

test: "npx vitest run src/channels/"
```

#### 단계 3. add/ 파일 작성 (새 파일)

```typescript
// my-skills/telegram-channel/add/src/channels/telegram.ts
import TelegramBot from 'node-telegram-bot-api';
import { Channel } from '../types.js';

export class TelegramChannel implements Channel {
  name = 'telegram';
  private bot: TelegramBot;

  constructor(private token: string) {
    this.bot = new TelegramBot(token, { polling: true });
  }

  async connect(): Promise<void> {
    // TelegramBot 폴링 자동 시작
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const chatId = jid.replace('tg:', '');
    await this.bot.sendMessage(chatId, text);
  }

  isConnected(): boolean { return true; }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    await this.bot.stopPolling();
  }
}
```

#### 단계 4. modify/ 파일 작성 (기존 파일의 수정된 버전)

```typescript
// my-skills/telegram-channel/modify/src/index.ts
// 원본 src/index.ts에서 telegram 채널 초기화 코드를 추가한 버전
// 중요: 전체 파일 내용이어야 합니다

import { WhatsAppChannel } from './channels/whatsapp.js';
import { TelegramChannel } from './channels/telegram.js';  // ← 추가
// ... 나머지 imports ...

async function main(): Promise<void> {
  // ... 기존 코드 ...

  // WhatsApp 채널 초기화
  if (process.env.WHATSAPP_ENABLED !== 'false') {
    channels.push(new WhatsAppChannel(...));
  }

  // Telegram 채널 초기화 (추가)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    channels.push(new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN));
  }

  // ... 이후 기존 코드 그대로 ...
}
```

#### 단계 5. 스킬 적용

```bash
# Claude Code에서 (또는 직접 스크립트로)
node -e "
  import('./skills-engine/index.js').then(m => {
    m.applySkill('./my-skills/telegram-channel').then(console.log);
  });
"
```

#### 단계 6. 결과 확인

```bash
# 성공 시
{ success: true, skill: 'telegram-channel', version: '1.0.0' }

# state.yaml 확인
cat .nanoclaw/state.yaml

# .env에 TELEGRAM_BOT_TOKEN 추가
echo "TELEGRAM_BOT_TOKEN=123456:ABC..." >> .env

# 서비스 재시작
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

---

## 11. 흔한 에러와 해결법

### 11.1 "state.yaml not found"

```
에러: .nanoclaw/state.yaml not found. Run initSkillsSystem() first.
원인: 스킬 시스템 초기화 없이 스킬 적용 시도

해결:
  node -e "import('./skills-engine/index.js').then(m => m.initSkillsSystem('0.3.1'));"
```

### 11.2 "A customize session is active"

```
에러: A customize session is active. Run commitCustomize() or abortCustomize() first.
원인: .nanoclaw/custom/pending.yaml 파일이 존재함

해결:
  node -e "import('./skills-engine/index.js').then(m => m.commitCustomize());"
  # 또는
  node -e "import('./skills-engine/index.js').then(m => m.abortCustomize());"
```

### 11.3 "Missing dependencies"

```
에러: Missing dependencies: base-channel-interface
원인: 선행 스킬이 적용되지 않음

해결:
  applySkill('./my-skills/base-channel-interface');
  applySkill('./my-skills/telegram-channel');  // 이후 재시도
```

### 11.4 머지 충돌 (Merge Conflicts)

```
에러: Merge conflicts in: src/index.ts
원인: 3-way merge 자동 해결 불가

해결 절차:
  1. code src/index.ts  (충돌 마커 수동 해결)
  2. 해결 후:
     import { recordSkillApplication, clearBackup, computeFileHash } from './skills-engine/state.js';
     const hash = computeFileHash('src/index.ts');
     recordSkillApplication('skill-name', '1.0.0', { 'src/index.ts': hash });
     clearBackup();
  
  또는 전체 롤백:
     import { restoreBackup, clearBackup } from './skills-engine/backup.js';
     restoreBackup();
     clearBackup();
```

### 11.5 "Tests failed" 후 자동 롤백

```
에러: Tests failed: Process exited with code 1
원인: manifest.test 명령 실패

동작: 자동 롤백 실행됨 (파일 복원, 상태 롤백, 백업 삭제)

해결:
  1. 테스트 실패 원인 파악 (로그 확인)
  2. 스킬의 modify/ 파일이 올바른지 확인
  3. 충돌 없는 클린 머지인지 확인 (클린 머지여도 테스트 실행됨)
```

---

## 부록: skills-engine API 요약

```typescript
// 초기화
initSkillsSystem(coreVersion: string): void

// 스킬 적용/제거
applySkill(skillDir: string): Promise<ApplyResult>
uninstallSkill(skillName: string): Promise<UninstallResult>

// 코어 업데이트
previewUpdate(newCoreDir: string, newVersion: string): UpdatePreview
applyUpdate(newCoreDir: string, newVersion: string): Promise<UpdateResult>

// 커스터마이즈
startCustomize(description: string): void
commitCustomize(): void
abortCustomize(): void
isCustomizeActive(): boolean

// 상태 조회
readState(): SkillState
getAppliedSkills(): AppliedSkill[]
getCustomModifications(): CustomModification[]

// 백업
createBackup(files: string[]): void
restoreBackup(): void
clearBackup(): void
recordSkillApplication(name, version, hashes, outcomes?): void

// 유틸
computeFileHash(path: string): string
acquireLock(): () => void   // 반환값: releaseLock 함수
```

---

*최종 업데이트: 2026-02-25*  
*관련 문서: ARCHITECTURE_ANALYSIS_ko.md, HOST_CONTAINER_PRACTICAL_GUIDE_ko.md*
