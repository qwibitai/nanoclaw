# Intent: Make credential proxy group-aware with service routing

## What changed
1. Credentials resolved per-request via pluggable `CredentialResolver`, not once at startup from `.env`
2. Container identified by TCP source IP (`req.socket.remoteAddress`) for group scope
3. Service identified by URL path prefix (e.g. `/claude/v1/messages`) — prefix stripped before forwarding
4. `registerContainerIP()` / `unregisterContainerIP()` exported — called by container-runner on spawn/exit
5. `setCredentialResolver()` exported — called at startup to wire in `resolveSecrets` from auth store
6. `detectAuthMode()` now takes `scope` parameter
7. Default resolver still reads `.env` (backward-compatible when skill is applied but no per-group creds configured)

## Why
The original proxy read `.env` once and used the same credentials for every container.
Per-group auth needs different credentials per group. The proxy is the natural place
to resolve and inject them since containers already route all API traffic through it.

Two-axis identification:
- **IP** → which container (group scope) — kernel-enforced, not spoofable
- **URL prefix** → which service (`/claude/`, future: `/openai/`, etc.)

## Key sections

### CredentialResolver type + setter (~lines 30-47)
- `CredentialResolver = (scope: string) => Record<string, string>`
- `defaultResolver` reads `.env` (same as before)
- `setCredentialResolver()` replaces the resolver at startup

### Container IP registry (~lines 49-70)
- `containerIpToScope` Map: container bridge IP → group folder
- `registerContainerIP(ip, scope)` — called by container-runner after spawn
- `unregisterContainerIP(ip)` — called on container exit
- `normalizeIP()` strips `::ffff:` prefix from IPv4-mapped IPv6

### parseServicePrefix (~line 72)
- Extracts `/<service>/` prefix from URL path
- Returns `{ service, path }` — path is forwarded to upstream

### Request handler (~lines 91-115)
- Parses service prefix, rejects unknown services
- Reads `req.socket.remoteAddress`, normalizes, looks up group scope
- Falls back to `'default'` scope for unknown IPs (with warning log)
- Calls `credentialResolver(scope)` per-request
- Forwards `parsed.path` to upstream (prefix stripped)

### detectAuthMode (~lines 195+)
- Takes `scope` parameter
- Uses `credentialResolver` instead of `readEnvFile`

## Invariants
- All existing proxy behavior preserved when no IP registered (falls back to default)
- Upstream URL still read from ANTHROPIC_BASE_URL in .env (not credential-dependent)
- Hop-by-hop header stripping unchanged
- Error handling unchanged

## Platform caveat
On Docker Desktop (macOS/Windows), all containers may appear from the same gateway IP.
See docs/per-container-credential-routing.md for workarounds.
