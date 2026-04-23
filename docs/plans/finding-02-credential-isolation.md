# FINDING-02: SDK Credential Isolation Investigation

**Date:** 2026-02-10
**Status:** Research complete, proxy approach recommended

## Summary

The Claude Agent SDK does NOT support socket/pipe-based authentication. Credentials must be provided as environment variables (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`). The official recommendation is a **credential injection proxy**.

## Current State

NanoClaw exposes credentials via `/workspace/env-dir/env` (read-only mount). With FINDING-01 fix (Phase 3b), non-main agents cannot use Bash to read this file. However, main group agents retain full Bash access and can read credentials.

## Official Anthropic Recommendation

From [Securely deploying AI agents](https://platform.claude.com/docs/en/agent-sdk/secure-deployment):

> Rather than giving an agent direct access to an API key, run a proxy outside the agent's environment that injects the key into requests. The agent can make API calls, but it never sees the credential itself.

The SDK supports two methods:
1. **`ANTHROPIC_BASE_URL`** — point SDK to a proxy that injects credentials
2. **`HTTP_PROXY`/`HTTPS_PROXY`** — route all traffic through a credential-injecting proxy

## Recommended Approach for NanoClaw

### Credential Injection Proxy

1. Run a lightweight HTTP proxy on the host (listening on container gateway `192.168.64.1`)
2. Proxy intercepts requests to `api.anthropic.com`, injects `Authorization` header
3. Container gets `ANTHROPIC_BASE_URL=http://192.168.64.1:PORT` instead of the API key
4. No credentials exposed inside the container

### Implementation Sketch

```
Host (macOS)                          Container (Linux VM)
┌─────────────────┐                  ┌──────────────────┐
│ Proxy (:8443)   │◄────────────────│ Claude Agent SDK  │
│ - Injects API   │                  │ ANTHROPIC_BASE_URL│
│   key into      │────────────────►│ = proxy address   │
│   requests      │  api.anthropic  │ (no API key)      │
└─────────────────┘                  └──────────────────┘
```

### Effort Estimate

- Build/deploy proxy: ~4 hours
- Modify container-runner to set `ANTHROPIC_BASE_URL` instead of exposing key: ~1 hour
- Testing: ~2 hours

### Trade-offs

**Pros:**
- Credentials never enter the container
- Works with existing SDK (no upstream changes needed)
- Can add request logging/auditing at the proxy level
- Can enforce rate limits per-group

**Cons:**
- Additional infrastructure (proxy process)
- Single point of failure (proxy down = agents can't work)
- Latency overhead (minimal for HTTP proxy)
- OAuth token rotation adds complexity

## Current Mitigations

Even without the proxy, risk is partially mitigated:
1. **Non-main agents can't use Bash** (FINDING-01 fix) — can't `cat` the env file
2. **Env file is read-only** — agents can't modify credentials
3. **Container VM isolation** — credentials don't leak to host processes
4. **API key scoping** — Anthropic API keys can be scoped and rotated

## References

- [Anthropic: Securely deploying AI agents](https://platform.claude.com/docs/en/agent-sdk/secure-deployment)
- [GitHub Issue #5082: Credential injection proxy for containers](https://github.com/anthropics/claude-code/issues/5082)
- [Draft PR #5490: Containerized Claude Code with host credential proxy](https://github.com/anthropics/claude-code/pull/5490)
