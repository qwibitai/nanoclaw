# 서버 아웃바운드(Outbound) 통신 확인 및 Cloudflare 네트워크 설정 가이드

본 문서는 NanoClaw 운영 중 텔레그램 API 서버(`api.telegram.org`) 등 외부 서비스로의 통신이 막히는 타임아웃(ETIMEDOUT) 현상을 진단하고 해결하는 방법을 안내합니다.

---

## 1. 아웃바운드 통신 실패 현상 이해하기

Cloudflare Tunnel(`cloudflared`)은 외부에서 서버 내부로 들어오는 **인바운드(Inbound) 트래픽을 안전하게 연결**해 주는 역할을 합니다. 터널을 뚫었다고 해서 서버에서 밖으로 나가는 트래픽이 차단되는 것은 아닙니다.

만약 외부 서버(텔레그램)와 통신할 수 없다면, 호스트 서버 환경 자체의 네트워크 라우팅, 방화벽, 혹은 DNS 문제일 확률이 높습니다.

---

## 2. 진단: 아웃바운드 통신 상태 확인 방법

터미널에서 아래 명령어들을 순차적으로 실행하여 어디서 막히는지 확인합니다.

### A. 일반 HTTPS 통신 확인
```bash
curl -m 5 -I https://google.com
```
*   **정상**: `HTTP/2 200` 등의 응답
*   **실패**: 구글조차 접속되지 않는다면 서버의 전체 인터넷 자체가 끊긴 것입니다.

### B. 텔레그램 API 통신 확인
```bash
curl -m 5 -I https://api.telegram.org
```
*   **실패 시 (`Connection timed out`)**: 텔레그램 서버로 가는 거점에서 트래픽이 드랍되고 있습니다.

### C. IPv4 vs IPv6 강제 연결 확인
텔레그램 서버 통신 실패의 80%는 잘못된 IPv6 라우팅 때문입니다.
```bash
# IPv4로만 강제 연결 테스트
curl -4 -m 5 -I https://api.telegram.org

# IPv6로만 강제 연결 테스트
curl -6 -m 5 -I https://api.telegram.org
```
*   `curl -4`는 성공하는데 `curl -6`가 예외/타임아웃이 난다면 호스트의 IPv6 설정이 꼬인 것입니다.

---

## 3. 해결 방안 및 수정 방법

진단 결과에 따라 아래의 조치 방안을 적용합니다.

### 조치 1. IPv6 우선순위 해제 (가장 흔한 해결책)

IPv6 통신 지원이 완벽하지 않은 서버(일부 VPS나 가정용 망)에서 발생하는 타임아웃을 해결합니다.

Ubuntu/Debian 기준, 시스템이 IPv4를 우선 사용하도록 설정합니다.
```bash
# sysctl을 사용하여 일시적으로 IPv6 비활성화
sudo sysctl -w net.ipv6.conf.all.disable_ipv6=1
sudo sysctl -w net.ipv6.conf.default.disable_ipv6=1

# /etc/gai.conf 를 편집하여 IPv4 우선 탐색 설정
sudo sed -i 's/^#precedence ::ffff:0:0\/96  100/precedence ::ffff:0:0\/96  100/' /etc/gai.conf
```
설정 후 봇을 재구동하면 통신이 복구될 수 있습니다.

### 조치 2. 로컬 방화벽 (UFW / iptables) 확인 및 허용

서버의 내부 방화벽에서 아웃바운드 포트(443)를 차단하고 있을 수 있습니다.
```bash
# UFW 방화벽 상태 확인
sudo ufw status verbose
```
출력 결과 중 `Default: deny (outgoing)`으로 되어 있다면 아웃바운드가 막힌 상태입니다.
```bash
# HTTPS(443) 아웃바운드 허용
sudo ufw allow out 443/tcp
sudo ufw reload
```

### 조치 3. Cloudflare Zero Trust (WARP) 필터링 예외 처리

호스트에 Cloudflare Tunnel 외에도 **Cloudflare WARP 클라이언트 다운스트림(Zero Trust 단말 에이전트)**이 설치되어 활성화되어 있다면, Zero Trust 대시보드의 Gateway 정책에 의해 텔레그램 API IP가 소셜 미디어/메신저 카테고리로 묶여 차단(Block) 당하고 있을 가능성이 있습니다.

1. Cloudflare Zero Trust 대시보드 로그인
2. **Gateway** -> **Policies** -> **DNS / Network / HTTP** 메뉴 확인
3. 텔레그램 허용: `api.telegram.org` 도메인에 대해 [Bypass] 혹은 [Allow] 정책을 추가
4. 혹은 테스트를 위해 서버 내 WARP 클라이언트를 일시 중지:
   ```bash
   warp-cli disconnect
   ```

### 조치 4. DNS 변경

호스트가 사용하는 통신사/로컬 DNS가 텔레그램 도메인 질의를 막는 경우가 드물게 존재합니다.
`/etc/resolv.conf` 에 Cloudflare DNS (`1.1.1.1`) 또는 Google DNS (`8.8.8.8`)를 추가하여 회피할 수 있습니다.

---

## 4. 최종 점검

조치를 취한 후 다음 스크립트로 상태를 초기화하고 텔레그램 채널이 정상적으로 `Connected successfully`가 되는지 확인합니다.

```bash
systemctl --user restart nanoclaw.service
tail -f ~/prj/nanoclaw/logs/nanoclaw.log | grep TELEGRAM
```
