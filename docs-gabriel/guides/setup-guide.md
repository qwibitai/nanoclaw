# NanoClaw 설치 및 인증 설정 가이드

NanoClaw를 처음 설치하고 1년짜리 Claude 인증 토큰을 발급·적용하는 방법을 설명합니다.

---

## 목차

1. [사전 요구사항](#1-사전-요구사항)
2. [저장소 클론](#2-저장소-클론)
3. [1년 장기 토큰 발급 및 .env 설정](#3-1년-장기-토큰-발급-및-env-설정)
4. [/setup 실행 (전체 설치)](#4-setup-실행-전체-설치)
5. [설치 단계별 상세 설명](#5-설치-단계별-상세-설명)
6. [토큰 만료 시 갱신 방법](#6-토큰-만료-시-갱신-방법)
7. [자주 묻는 질문](#7-자주-묻는-질문)

---

## 1. 사전 요구사항

| 항목 | 버전 | 확인 명령 |
|------|------|-----------|
| Node.js | 20 이상 | `node --version` |
| Claude Code | 최신 | `claude --version` |
| Docker | 최신 | `docker --version` |
| Claude Pro/Max 구독 | - | [claude.ai](https://claude.ai) |

> **참고:** Linux에서는 Docker가 기본 컨테이너 런타임입니다. macOS에서는 Apple Container도 선택 가능합니다.

---

## 2. 저장소 클론

```bash
git clone https://github.com/qwibitai/NanoClaw.git
cd NanoClaw
```

---

## 3. 1년 장기 토큰 발급 및 .env 설정

> **왜 장기 토큰이 필요한가?**
>
> 일반 `claude login` (OAuth)으로 발급된 토큰은 **8~12시간** 후 만료됩니다.
> `claude setup-token`으로 발급한 토큰은 **1년간** 유효하여 NanoClaw가 재인증 없이 지속적으로 동작합니다.

### 3-1. 장기 토큰 발급

터미널에서 아래 명령을 실행합니다:

```bash
claude setup-token
```

실행 시 브라우저 인증 URL이 표시됩니다:

```
Browser didn't open? Use the url below to sign in:
https://claude.ai/oauth/authorize?code=true&client_id=...

Paste code here if prompted >
```

**브라우저에서 인증 완료 후 받은 코드를 터미널에 붙여넣으면** 토큰이 출력됩니다:

```
✓ Long-lived authentication token created successfully!

Your OAuth token (valid for 1 year):
sk-ant-oat01-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX

Store this token securely. You won't be able to see it again.
```

> ⚠️ **중요:** 이 토큰은 **다시 볼 수 없습니다.** 반드시 즉시 `.env` 파일에 저장하세요.

### 3-2. .env 파일 생성

NanoClaw 프로젝트 루트에 `.env` 파일을 생성합니다:

```bash
# 프로젝트 루트에서 실행
echo "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-여기에토큰붙여넣기" > .env
```

또는 편집기로 직접 작성:

```env
# .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

> **참고:** Anthropic API Key를 사용하는 경우 대신 아래를 사용합니다:
> ```env
> ANTHROPIC_API_KEY=sk-ant-XXXXXXXXXXXXXXXX
> ```
> API Key는 만료 기간이 없어 가장 안정적입니다.

### 3-3. .env 설정 확인

```bash
cat .env
# CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... 이 출력되면 정상
```

---

## 4. /setup 실행 (전체 설치)

Claude Code를 실행하고 `/setup`을 입력합니다:

```bash
claude
```

Claude Code 실행 후:
```
/setup
```

> **참고:** `.env` 파일이 이미 존재하면 `/setup`이 이를 감지하고 **"유지할지 재설정할지"** 확인합니다. 방금 만든 `.env`는 유지(keep)를 선택하세요.

---

## 5. 설치 단계별 상세 설명

`/setup` 실행 시 Claude Code가 자동으로 아래 단계를 진행합니다:

| 단계 | 내용 | 자동/수동 |
|------|------|-----------|
| **1. Bootstrap** | Node.js 확인, npm 의존성 설치 | 자동 |
| **2. 환경 체크** | OS, Docker, 기존 설정 확인 | 자동 |
| **3. 컨테이너 런타임** | Docker 설치/실행 확인 | 자동 |
| **4. Claude 인증** | `.env`의 토큰 확인 | **수동** (사전 준비 필요) |
| **5. WhatsApp 인증** | QR코드 또는 페어링 코드 스캔 | **수동** (QR 스캔 필요) |
| **6. 트리거 설정** | 봇 이름/트리거 단어 설정 | **수동** (선택) |
| **7. 그룹 선택** | 등록할 WhatsApp 채팅 선택 | **수동** (선택) |
| **8. 채널 등록** | 선택한 채널 DB 등록 | 자동 |
| **9. 마운트 설정** | 에이전트 접근 가능 디렉터리 설정 | **수동** (선택) |
| **10. 서비스 시작** | systemd/launchd 서비스 등록 및 시작 | 자동 |
| **11. 검증** | 전체 설치 상태 최종 확인 | 자동 |

### WhatsApp 인증 방법 선택

- **QR 브라우저** (GUI 환경 권장): 브라우저에서 QR 스캔
- **페어링 코드** (헤드리스 서버 권장): 전화번호 입력 후 WhatsApp 앱에서 코드 입력
- **QR 터미널**: `npm run auth`를 별도 터미널에서 실행

---

## 6. 토큰 만료 시 갱신 방법

1년 후 토큰이 만료되면 다음 단계로 갱신합니다:

```bash
# 1. 새 토큰 발급
claude setup-token

# 2. .env 파일 업데이트
nano .env  # 또는 원하는 편집기 사용
# CLAUDE_CODE_OAUTH_TOKEN=새_토큰_값 으로 변경

# 3. 서비스 재시작 (Linux systemd)
systemctl --user restart nanoclaw

# 3. 서비스 재시작 (macOS launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 토큰 상태 확인

현재 토큰 만료 시간 확인:

```bash
node -e "
const creds = require(process.env.HOME + '/.claude/.credentials.json');
const oauth = creds.claudeAiOauth;
const expiresAt = new Date(oauth.expiresAt);
console.log('만료:', expiresAt.toLocaleString('ko-KR', {timeZone: 'Asia/Seoul'}));
console.log('남은 일수:', Math.round((oauth.expiresAt - Date.now()) / 1000 / 60 / 60 / 24), '일');
"
```

---

## 7. 자주 묻는 질문

### Q. `claude setup-token`과 일반 `claude login`의 차이는?

| 방식 | 유효 기간 | 용도 |
|------|-----------|------|
| `claude login` (기본 OAuth) | **8~12시간** | 일반 대화형 사용 |
| `claude setup-token` | **1년** | 서버/자동화 환경 |
| Anthropic API Key | **만료 없음** | 가장 안정적, Pro 구독 불필요 |

### Q. `/setup` 실행 시 기존 `.env`가 덮어쓰여지나요?

아니요. `/setup`은 `.env`가 이미 존재하면 **"유지할지 재설정할지"** 먼저 묻습니다. 덮어쓰기를 강제하지 않습니다.

### Q. NanoClaw가 왜 토큰 만료 없이 동작하나요?

NanoClaw는 `claude setup-token`으로 발급한 1년짜리 토큰을 `.env`에 저장하고, 컨테이너 내부 에이전트 실행 시 해당 토큰을 주입합니다. 일반 OAuth와 달리 세션이 아닌 장기 토큰을 사용하기 때문에 지속적인 운영이 가능합니다.

### Q. 서비스 실행 중 토큰 갱신이 가능한가요?

네. `.env`를 수정한 후 서비스를 재시작하면 됩니다. 실행 중인 에이전트 작업은 완료 후 새 토큰이 적용됩니다.

---

## 관련 문서

- [호스트 관리 가이드](./host-management.md)
- [외부 마운트 설정](./external-mounts.md)
- [Skills 엔진 가이드](./skills-engine.md)
- [NanoClaw 공식 README](../README.md)
