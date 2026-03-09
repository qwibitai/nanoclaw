# Intent: Make credential proxy group-aware

## What changed
1. Credentials resolved per-request via pluggable `CredentialResolver`, not once at startup from `.env`
2. URL prefix `/scope/<group-folder>/` parsed and stripped before forwarding upstream
3. `setCredentialResolver()` exported — called at startup to wire in `resolveSecrets` from auth store
4. `detectAuthMode()` now takes optional `scope` parameter
5. Default resolver still reads `.env` (backward-compatible when skill is applied but no per-group creds configured)

## Why
The original proxy read `.env` once and used the same credentials for every container.
Per-group auth needs different credentials per group. The proxy is the natural place
to resolve and inject them since containers already route all API traffic through it.

## Key sections

### CredentialResolver type + setter (~lines 33-50)
- `CredentialResolver = (scope: string) => Record<string, string>`
- `defaultResolver` reads `.env` (same as before)
- `setCredentialResolver()` replaces the resolver at startup

### parseScopedUrl (~lines 53-57)
- Extracts `/scope/<id>/` prefix from URL
- Returns `{ scope, path }` — scope is null for unscoped URLs (backward compat)

### Request handler (~lines 80-90)
- Calls `parseScopedUrl(req.url)` to extract scope
- Calls `credentialResolver(scope || 'default')` per-request
- Auth mode determined from resolved credentials, not global state
- Upstream path is the stripped URL (without scope prefix)

### detectAuthMode (~lines 148-151)
- Now takes optional `scope` parameter (defaults to `'default'`)
- Uses `credentialResolver` instead of `readEnvFile`

## Invariants
- All existing proxy behavior preserved for unscoped URLs
- Upstream URL still read from ANTHROPIC_BASE_URL in .env (not credential-dependent)
- Hop-by-hop header stripping unchanged
- Error handling unchanged
