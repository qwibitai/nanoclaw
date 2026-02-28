# 컨테이너 스킬 추가하기

> 메신저(WhatsApp 등)를 통해 대화하는 Claude에게 새로운 기능을 추가하는 방법입니다.

---

## 개념 정리

| 종류              | 위치                | 사용자                        |
| :---------------- | :------------------ | :---------------------------- |
| **컨테이너 스킬** | `container/skills/` | 메신저 사용자 대상 Claude     |
| 호스트 스킬       | `.claude/skills/`   | 개발자 대상 (프로젝트 관리용) |

**메신저 사용자에게 새로운 도구를 주려면 → `container/skills/` 에 추가**

---

## 작동 원리

```
container/skills/{skill}/SKILL.md  (소스)
         │
         ▼ 컨테이너 시작 시 자동 복사 (buildVolumeMounts)
data/sessions/{folder}/.claude/skills/{skill}/SKILL.md
         │
         ▼ 볼륨 마운트
/home/node/.claude/skills/{skill}/SKILL.md  (컨테이너 내부)
```

---

## 설치 방법

### 1단계: 스킬 폴더 생성

```bash
mkdir container/skills/my-tool
```

### 2단계: SKILL.md 작성

```markdown
---
name: my-tool
description: >
  사용자가 "날씨 알려줘", "기온 확인" 등을 요청할 때 사용합니다.
  이 스킬로 외부 API를 호출해 날씨 정보를 가져올 수 있습니다.
---

# My Tool 가이드

## 사용법

Bash 도구를 사용하여 날씨 API를 호출합니다:

```bash
curl "https://api.weather.example.com/current?city=Seoul"
```

응답 JSON에서 `temperature` 필드를 추출해 사용자에게 전달합니다.
```

### 3단계: (필요 시) Dockerfile에 도구 추가

스킬이 컨테이너에 없는 프로그램을 사용한다면:

```dockerfile
# container/Dockerfile 수정
RUN apt-get install -y jq python3-pip
```

이후 이미지 재빌드:
```bash
./container/build.sh
# 또는
docker build -t nanoclaw-agent:latest container/
```

### 4단계: 반영 확인

1. **자동 복사**: 다음 컨테이너 시작 시 자동으로 반영됩니다.
2. **즉시 반영**: 기존 컨테이너가 실행 중이면 30분 유휴 후 종료되거나 서비스를 재시작:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
systemctl --user restart nanoclaw                  # Linux
```

---

## SKILL.md 잘 쓰는 법

**`description`이 가장 중요합니다.** Claude는 이 설명을 보고 언제 이 스킬을 사용할지 결정합니다.

```yaml
---
name: calculator
description: >
  수학 계산, 단위 변환, 환율 계산 등 계산이 필요할 때 사용합니다.
  "계산해줘", "얼마야", "변환", "환율" 등의 키워드에서 활성화됩니다.
---
```

**명확한 예제를 포함하세요.** Claude는 예제 코드를 보고 사용법을 가장 잘 이해합니다.

---

## 트러블슈팅

**스킬이 인식되지 않을 때:**
- `SKILL.md` 파일명이 대문자로 정확히 작성되었는지 확인
- 폴더 구조: `container/skills/{name}/SKILL.md` 맞는지 확인
- 서비스 재시작 후 재시도

**명령어 실행 실패 시:**
```bash
# 컨테이너에 직접 접속하여 확인
docker run --rm -it --entrypoint /bin/bash nanoclaw-agent:latest
which jq  # 도구 설치 여부 확인
```

**스킬 복사 여부 확인:**
```bash
ls data/sessions/main/.claude/skills/
```

*업데이트: 2026-02-25*
