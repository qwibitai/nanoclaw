---
title: "분석: 텔레그램 봇 무응답 및 ETIMEDOUT 네트워크 타임아웃 문제"
date: "2026-02-28"
status: "open"
---

# 텔레그램 봇 무응답 및 네트워크 타임아웃 문제

nanoclaw 서비스 운영 중, 텔레그램 봇(`owlyang_bot` 등)이 사용자 입력에 전혀 응답하지 않는 장애가 발생했습니다. 로그 분석 결과 애플리케이션의 로직 문제가 아닌 **네트워크 계층의 외부 통신 차단**이 원인으로 확인되었습니다.

## 1. 현상 및 로그 확인

봇이 메시지를 수신하거나 발신하려고 할 때, 다음과 같은 `ETIMEDOUT` 에러가 `logs/nanoclaw.error.log` 및 `logs/nanoclaw.log`에 대량으로 기록됩니다.

```json
FetchError: request to https://api.telegram.org/bot<TOKEN>/sendMessage failed, reason: 
    at ClientRequest.<anonymous> (/home/gabriel/prj/nanoclaw/node_modules/node-fetch/lib/index.js:1501:11)
    ...
    "errno": "ETIMEDOUT",
    "code": "ETIMEDOUT",
    "name": "FetchError"
```

터미널에서 직접 텔레그램 API 서버로 테스트 헤더 요청(`curl -m 10 -I https://api.telegram.org/`)을 보냈을 때도 응답 없이 연결이 종료(Timeout)되는 현상이 확인되었습니다.

## 2. 원인 분석

NanoClaw가 설치된 호스트 리눅스 머신에서 `api.telegram.org` (텔레그램 공식 API 서버)로 나가는 **아웃바운드(Outbound) 통신이 막혀있습니다.**

가장 유력한 원인들은 다음과 같습니다:
1. **IPv6 라우팅 문제**: 서버가 IPv6를 지원한다고 잘못 판단하여 IPv6 주소로 텔레그램 서버에 접속하려다 중간에 패킷이 유실되는 경우.
2. **DNS 주소 확인 실패**: 호스트 서버의 네임서버(`resolv.conf`) 설정 오류로 인해 텔레그램 서버의 IP를 찾지 못하는 경우.
3. **방화벽(UFW/iptables) 정책**: 서버 내부 방화벽에서 기본 아웃바운드를 `DENY`로 차단했거나, 포트 443(HTTPS)을 막은 경우.
4. **Cloudflare Zero Trust (WARP) 간섭**: 서버에 Cloudflare WARP 클라이언트를 설치하여 아웃바운드 트래픽을 필터링 중일 때, 텔레그램 API 대역이 차단된 경우. (Cloudflare Tunnel인 `cloudflared` 자체는 인바운드 연결 서비스이므로 아웃바운드 통신을 직접 막지는 않습니다)

## 3. 연관 문서 및 해결 방법

이 문제를 해결하기 위한 구체적인 네트워크 점검 및 수정 가이드는 아래 문서를 참고하십시오.

*   [네트워크 아웃바운드 및 Cloudflare 설정 가이드](../guides/cloudflare-outbound-setup.md)
