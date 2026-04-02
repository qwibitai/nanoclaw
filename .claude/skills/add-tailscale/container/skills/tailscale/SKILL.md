---
name: tailscale
description: Tailscale VPN — the container is connected to a tailnet. Use tailscale hostnames to reach private services.
---

# Tailscale VPN

This container is connected to a Tailscale network (tailnet). You can reach private hosts by their Tailscale hostname or IP.

## What you can do

- Access internal APIs, databases, or services by tailscale hostname (e.g. `http://my-server:8080`)
- Use `tailscale status` to see connected peers
- Use `tailscale ping <hostname>` to check reachability

## Notes

- Tailscale runs in userspace networking mode
- DNS for tailnet hostnames resolves automatically via `100.100.100.100`
- Internet traffic routes normally (not through tailnet unless `--exit-node` was configured)
