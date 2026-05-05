# FINDING-03: Network Egress Investigation

**Date:** 2026-02-10
**Status:** Research complete, implementation deferred

## Summary

Apple Container does NOT provide built-in network egress filtering. Each container gets a dedicated IP via vmnet with unrestricted outbound internet access. There is no `--network=none` or egress allowlist feature.

## Key Findings

### What Apple Container provides

- **Per-container VM isolation**: Each container runs in its own lightweight VM
- **Dedicated IP per container**: On the 192.168.64.0/24 subnet (default vmnet)
- **Container-to-container isolation**: Built into macOS 15 (containers can't talk to each other)
- **Custom networks (macOS 26+)**: `container network create` for container-to-container grouping, NOT egress filtering

### What Apple Container does NOT provide

- No `--network=none` flag for disabling outbound access
- No egress allowlist (domain or IP-based)
- No outbound traffic logging
- No proxy integration

## Possible Approaches

### 1. macOS `pf` firewall rules (recommended)

Route all container subnet traffic through `pf` (packet filter) rules:

```bash
# Block all outbound from container subnet except allowlisted IPs
# Add to /etc/pf.conf or /etc/pf.anchors/nanoclaw

# Resolve api.anthropic.com to IP addresses
ANTHROPIC_IPS = "{ 104.18.0.0/16, 172.66.0.0/16 }"

# Container subnet
CONTAINER_NET = "192.168.64.0/24"

# Block all outbound from containers, except:
# - DNS (needed for resolution)
# - Anthropic API
# - HTTPS to allowlisted IPs
block out quick on bridge100 from $CONTAINER_NET to ! $ANTHROPIC_IPS port 443
pass out quick on bridge100 from $CONTAINER_NET to $ANTHROPIC_IPS port 443
pass out quick on bridge100 from $CONTAINER_NET to any port 53
```

**Pros:** Works at host level, no container changes needed, well-understood technology
**Cons:** Requires sudo, IP-based (not domain-based), IPs can change, bridge interface name may vary

### 2. In-container iptables

Run iptables rules inside the container VM.

**Blocked:** Container runs as non-root `node` user. Cannot modify iptables.

### 3. Proxy-based filtering (ToolHive approach)

Run an egress proxy (like Squid) on the host or in a sidecar container:
- Set `HTTP_PROXY`/`HTTPS_PROXY` env vars in the container
- Proxy allowlists specific domains

**Pros:** Domain-based filtering, comprehensive logging
**Cons:** Complex setup, requires maintaining proxy infrastructure, HTTPS inspection adds latency

### 4. DNS-based filtering

Run a custom DNS server that only resolves allowlisted domains:
- Container uses custom DNS
- Non-allowlisted domains return NXDOMAIN

**Pros:** Simple concept, domain-based
**Cons:** Doesn't prevent direct IP access, requires custom DNS setup

## Recommendation

**Short-term (Phase 2):** No implementation. The complexity vs. risk tradeoff doesn't justify immediate action for a personal assistant tool. The primary threat (prompt-injected agent exfiltrating data) is already partially mitigated by:
- Container VM isolation (no host access)
- Read-only project mount (FINDING-04, now implemented)
- IPC authorization (prevents cross-group access)

**Medium-term:** If egress filtering is needed, implement Option 1 (pf firewall rules) with a helper script that:
1. Resolves `api.anthropic.com` to current IPs
2. Generates pf rules
3. Loads rules via `sudo pfctl -f`

**Long-term:** Monitor Apple Container releases for native egress filtering support. The project is under active development (v0.5.0 as of Oct 2025).
