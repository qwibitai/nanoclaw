# Apple Container Networking Setup (macOS 26)

Apple Container's vmnet networking requires manual configuration for containers to access the internet. Without this, containers can communicate with the host but cannot reach external services (DNS, HTTPS, APIs).

## Quick Setup

Run these two commands (requires `sudo`):

```bash
# 1. Enable IP forwarding so the host routes container traffic
sudo sysctl -w net.inet.ip.forwarding=1

# 2. Enable NAT so container traffic gets masqueraded through your internet interface
echo "nat on en0 from 192.168.64.0/24 to any -> (en0)" | sudo pfctl -ef -
```

> **Note:** Replace `en0` with your active internet interface. Check with: `route get 8.8.8.8 | grep interface`

## Making It Persistent

These settings reset on reboot. To make them permanent:

**IP Forwarding** — add to `/etc/sysctl.conf`:
```
net.inet.ip.forwarding=1
```

**NAT Rules** — add to `/etc/pf.conf` (before any existing rules):
```
nat on en0 from 192.168.64.0/24 to any -> (en0)
```

Then reload: `sudo pfctl -f /etc/pf.conf`

## IPv6 DNS Issue

By default, DNS resolvers return IPv6 (AAAA) records before IPv4 (A) records. Since our NAT only handles IPv4, Node.js applications inside containers will try IPv6 first and fail.

The container image and runner are configured to prefer IPv4 via:
```
NODE_OPTIONS=--dns-result-order=ipv4first
```

This is set both in the `Dockerfile` and passed via `-e` flag in `container-runner.ts`.

## Verification

```bash
# Check IP forwarding is enabled
sysctl net.inet.ip.forwarding
# Expected: net.inet.ip.forwarding: 1

# Test container internet access
container run --rm --entrypoint curl nanoclaw-agent:latest \
  -s4 --connect-timeout 5 -o /dev/null -w "%{http_code}" https://api.anthropic.com
# Expected: 404

# Check bridge interface (only exists when a container is running)
ifconfig bridge100
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `curl: (28) Connection timed out` | IP forwarding disabled | `sudo sysctl -w net.inet.ip.forwarding=1` |
| HTTP works, HTTPS times out | IPv6 DNS resolution | Add `NODE_OPTIONS=--dns-result-order=ipv4first` |
| `Could not resolve host` | DNS not forwarded | Check bridge100 exists, verify pfctl NAT rules |
| Container hangs after output | Missing `process.exit(0)` in agent-runner | Rebuild container image |

## How It Works

```
Container VM (192.168.64.x)
    │
    ├── eth0 → gateway 192.168.64.1
    │
bridge100 (192.168.64.1) ← host bridge, created by vmnet when container runs
    │
    ├── IP forwarding (sysctl) routes packets from bridge100 → en0
    │
    ├── NAT (pfctl) masquerades 192.168.64.0/24 → en0's IP
    │
en0 (your WiFi/Ethernet) → Internet
```

## Credential Proxy Binding

The NanoClaw credential proxy injects the Claude Code OAuth token into container requests. On Docker Desktop (macOS), the proxy binds to `127.0.0.1` and Docker routes `host.docker.internal` to loopback — so containers reach it transparently.

Apple Container does **not** resolve `host.docker.internal`. Containers are assigned IPs in `192.168.64.0/24` and the host is at `192.168.64.1` (the `bridge100` interface). NanoClaw auto-detects this:

- `container-runtime.ts` scans for a `bridge*` interface on macOS to identify Apple Container
- `PROXY_BIND_HOST` is set to the bridge IP (e.g. `192.168.64.1`) so the proxy is reachable from containers
- `CONTAINER_HOST_GATEWAY` is set to the same IP so containers know where to send auth requests

Both can be overridden via environment variables if needed:
```bash
CREDENTIAL_PROXY_HOST=192.168.64.1   # override proxy bind address
CONTAINER_HOST_GATEWAY=192.168.64.1  # override gateway address in containers
```

### File bind mounts

Apple Container only supports **directory** bind mounts, not file mounts. The Docker setup shadows `.env` inside the container by mounting `/dev/null` over it — this does not work on Apple Container. NanoClaw skips the shadow on Apple Container; credentials are injected by the proxy and never need to be read from `.env` inside the container.

## References

- [apple/container#469](https://github.com/apple/container/issues/469) — No network from container on macOS 26
- [apple/container#656](https://github.com/apple/container/issues/656) — Cannot access internet URLs during building
