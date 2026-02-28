# Apple 컨테이너 네트워킹 설정 (macOS 26)

Apple 컨테이너의 vmnet 네트워킹을 통해 컨테이너가 인터넷에 접근하도록 하려면 수동 구성이 필요합니다. 이 설정을 하지 않으면 컨테이너는 호스트와 통신할 수는 있지만 외부 서비스(DNS, HTTPS, API)에는 연결할 수 없습니다.

## 빠른 설정

다음 두 명령을 실행하세요 (`sudo` 권한 필요):

```bash
# 1. IP 포워딩 활성화 (호스트가 컨테이너 트래픽을 라우팅하도록 함)
sudo sysctl -w net.inet.ip.forwarding=1

# 2. NAT 활성화 (컨테이너 트래픽이 인터넷 인터페이스를 통해 변환되어 나가도록 함)
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **비고:** `en0` 부분을 사용 중인 현재 인터넷 인터페이스로 변경하세요. 확인 방법: `route get 8.8.8.8 | grep interface`

## 영구 적용하기

위 설정들은 재부팅 시 초기화됩니다. 이를 영구적으로 유지하려면 다음과 같이 설정합니다:

**IP 포워딩** — `/etc/sysctl.conf` 파일에 추가:
```
net.inet.ip.forwarding=1
```

**NAT 규칙** — `/etc/pf.conf` 파일에 추가 (기존 규칙들보다 앞에 위치해야 함):
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

추가 후 설정 다시 로드하기: `sudo pfctl -f /etc/pf.conf`

## IPv6 DNS 문제

비활성 상태 변경 없이, 기본적으로 DNS 리졸버(Resolver)는 IPv4 (A) 레코드보다 IPv6 (AAAA) 레코드를 먼저 반환합니다. 앞서 설정한 NAT은 IPv4만을 처리하기 때문에 컨테이너 내부의 Node.js 애플리케이션들은 IPv6 연결을 먼저 시도했다가 실패하게 됩니다.

컨테이너 이미지와 러너(runner)는 다음과 같이 IPv4를 우선 사용하도록 구성되어 있습니다:
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

이 값은 `Dockerfile` 내부에 지정되어 있으며, 동시에 `container-runner.ts` 파일에서 구동할 때 `-e` 플래그로도 전달됩니다.

## 동작 확인

```bash
# IP 포워딩이 활성화되어 있는지 확인
sysctl net.inet.ip.forwarding
# 예상 출력 결과: net.inet.ip.forwarding: 1

# 컨테이너의 인터넷 접근성 테스트
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# 예상 출력 결과: 404 (API는 살아있다는 의미)

# 브릿지(Bridge) 인터페이스 확인 (컨테이너가 동작 중일 때만 존재함)
ifconfig bridge100
```

## 문제 해결 

| 증상                                 | 원인                                   | 해결책                                                |
| ------------------------------------ | -------------------------------------- | ----------------------------------------------------- |
| `curl: (28) Connection timed out`    | IP 포워딩 비활성화 됨                  | `sudo sysctl -w net.inet.ip.forwarding=1` 명령어 실행 |
| HTTP 기동은 성공, HTTPS는 시간 초과  | IPv6 DNS 해석 문제                     | `NODE_OPTIONS=--dns-result-order=ipv4first` 추가      |
| `Could not resolve host`             | DNS 라우팅 전달 실패                   | bridge100이 존재하는지 및 pfctl NAT 규칙 확인         |
| 컨테이너의 결과를 받은 후 멈춤(Hang) | agent-runner 내 `process.exit(0)` 누락 | 컨테이너 이미지 재빌드                                |

## 원리 및 구조

```
컨테이너 VM (192.168.64.x)
    │
    ├── eth0 → 게이트웨이 192.168.64.1
    │
bridge100 (192.168.64.1) ← 호스트 브릿지, 컨테이너 실행 시 vmnet을 통해 생성됨
    │
    ├── IP 포워딩 (sysctl)이 bridge100 → en0 으로 패킷을 라우팅함
    │
    ├── NAT (pfctl)가 192.168.64.0/24 → en0의 할당된 IP로 네트워크 주소 변환(마스커레이드)
    │
en0 (현재 사용 중인 WiFi/이더넷) → 인터넷
```

## 참고 자료

- [apple/container#469](https://github.com/apple/container/issues/469) — macOS 26에서 컨테이너 네트워킹 불가 이슈 설정법
- [apple/container#656](https://github.com/apple/container/issues/656) — 빌드 중 인터넷 URL 접속 불가 시 대응 방안
