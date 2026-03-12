# Multi-Tenant Container Credential Isolation - Design Document

**Status**: Proposed
**Scope Estimate**: ~150 lines (Phase 1: ~100 lines)

## Requirements

- R-001: Illysium group containers must not have access to non-Illysium GitHub repos
- R-002: Illysium group containers must not see non-Illysium calendar accounts
- R-003: Global CLAUDE.md must not leak project names, descriptions, and cross-project info to shared groups
- R-004: Changes must follow the existing `tools` array scoping pattern (e.g., `gmail:illysium`, `snowflake:apollo`)
- R-005: Backwards compatible — groups without explicit scoping continue to get all credentials

## Architecture Overview

Three independent isolation gaps need closing. Each follows the same pattern already established by `gmail:<account>` and `snowflake:<connection>`: the `tools` array in `container_config` gates what credentials get mounted, and `container-runner.ts` enforces it at mount time.

## Current State Analysis

| Credential | Scoped? | Mechanism | Gap |
|-----------|---------|-----------|-----|
| Gmail | Yes | `gmail:illysium` mounts only that account's dir | None |
| Snowflake | Yes | `snowflake:apollo` filters connections.toml | None |
| Calendar | No | `calendar` mounts full tokens.json (5 accounts) | All accounts visible |
| GitHub | No | Single GITHUB_TOKEN passed to all containers | Full org access |
| Global CLAUDE.md | No | Mounted read-only to all non-main groups | All project names visible |

## Options Evaluated

### 1. Calendar Account Scoping

#### Option A: Filter tokens.json at mount time (Selected)

**Approach**: Same pattern as Snowflake. When `tools` contains `calendar:illysium`, read `tokens.json`, remove all keys except `illysium`, write a filtered copy to a staging dir, mount that instead.

**Why selected**: Exact same pattern as the existing Snowflake connection filtering. Zero changes to the calendar MCP server itself. The `@cocal/google-calendar-mcp` reads `tokens.json` and creates clients for every key present — removing keys removes access. ~25 lines of code.

#### Option B: Run per-account calendar MCP servers (Rejected)

**Approach**: Similar to how Gmail spawns `gmail-sunday`, `gmail-illysium` etc., spawn separate calendar MCP instances with separate token files.

**Why not**: Over-engineered. The calendar MCP already handles multi-account via a single tokens.json. Filtering that file is simpler and consistent with Snowflake precedent. Would also require agent-runner changes to spawn multiple servers.

#### Option C: Use ENABLED_TOOLS env var to restrict to read-only (Rejected)

**Approach**: Use the calendar MCP's built-in `ENABLED_TOOLS` to restrict to read-only operations.

**Why not**: This restricts operations, not accounts. A read-only container would still see all 5 accounts' events, which is the actual information leak.

### 2. GitHub Token Scoping

#### Option A: Per-group token via tools array (Selected)

**Approach**: Add `github:<scope>` to the tools array pattern. When present, read the token from a per-scope env var or file rather than the default `GITHUB_TOKEN`. When `tools` array does not include `github` at all (and does not include it by omission via `undefined`), strip the token entirely.

Implementation: In `readSecrets()`, accept the group's tools config. For `github:illysium`, look for `GITHUB_TOKEN_ILLYSIUM` in `.env`. If tools is defined but has no `github` or `github:*` entry, omit GITHUB_TOKEN from secrets.

**Why selected**: Follows the established scoping convention. Fine-grained PATs are a GitHub feature — we just need to route the right PAT to the right container. Minimal code change (~20 lines in `readSecrets()` + entrypoint stays unchanged).

#### Option B: Add a `githubToken` field to ContainerConfig (Rejected)

**Approach**: New field `containerConfig.githubToken` that overrides the global token.

**Why not**: Stores a secret in the database (container_config is persisted as JSON in SQLite). The tools array approach keeps secrets in `.env` where they belong, and config just references which scope to use.

#### Option C: No GitHub scoping, rely on CLAUDE.md instructions (Rejected)

**Approach**: Tell the agent "only use Illysium repos" in the group CLAUDE.md.

**Why not**: Prompt-level restrictions are not security controls. A determined user in the shared Slack channel could prompt-inject past them. The token itself grants access — the only real isolation is giving a different token.

### 3. Global CLAUDE.md Filtering

#### Option A: `globalContext: false` config flag (Selected)

**Approach**: Add `globalContext?: boolean` to `ContainerConfig` (default: `true` for backwards compat). When `false`, skip mounting `groups/global/` entirely. The group's own CLAUDE.md provides all context the agent needs.

**Why selected**: Simplest possible change (~3 lines in `buildVolumeMounts`). The illysium group CLAUDE.md already has its own scope restrictions and project context. Mounting the global file only adds cross-project information that shouldn't be visible. No need for dynamic filtering — a binary on/off is sufficient because the global CLAUDE.md is inherently cross-project.

#### Option B: Generate a filtered global CLAUDE.md per group (Rejected)

**Approach**: At container launch, parse global CLAUDE.md, extract only the row for this group's project, write a filtered version to a staging dir.

**Why not**: Fragile (depends on markdown table parsing), and the illysium CLAUDE.md already has the info the agent needs. The global file's value IS cross-project awareness — filtering it down to one project makes it redundant with the group CLAUDE.md.

#### Option C: Move sensitive info out of global CLAUDE.md (Rejected)

**Approach**: Restructure global CLAUDE.md to not contain project names/descriptions.

**Why not**: The global CLAUDE.md is useful for the main group and personal groups where Dave wants cross-project awareness. The problem isn't the file's content — it's that shared groups shouldn't see it.

## Detailed Design

### Database / Config Changes

Add to `ContainerConfig` interface in `src/types.ts`:

```typescript
export interface ContainerConfig {
  // ... existing fields ...
  globalContext?: boolean; // Default: true. Set false to skip mounting groups/global/
}
```

No schema migration needed — `container_config` is a JSON text column. New field is optional with backwards-compatible default.

### Change 1: Calendar Account Scoping (~25 lines)

**File**: `src/container-runner.ts`, inside `buildVolumeMounts()`, the calendar section (lines 860-883).

Current code mounts the full `~/.config/google-calendar-mcp` directory. New code:

```
if calendar is enabled:
  check for account-specific restriction (e.g. 'calendar:illysium')
  if account-specific:
    read tokens.json
    parse as JSON
    create filtered copy with only the allowed account keys
    write to staging dir: data/sessions/{group}/calendar/tokens.json
    mount staging dir instead of real dir
  else:
    mount full dir (existing behavior)
```

The staging approach mirrors what Snowflake already does with `data/sessions/{group}/snowflake/`.

### Change 2: GitHub Token Scoping (~20 lines)

**File**: `src/container-runner.ts`, modify `readSecrets()` to accept tools config.

```
function readSecrets(tools?: string[]): Record<string, string> {
  const secrets = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);

  if tools is undefined (all tools): read GITHUB_TOKEN as before
  else if tools includes 'github' (unscoped): read GITHUB_TOKEN as before  
  else if tools includes 'github:<scope>':
    read GITHUB_TOKEN_<SCOPE> from .env (e.g. GITHUB_TOKEN_ILLYSIUM)
    fall back to GITHUB_TOKEN if scoped var not found
  else (tools defined but no github entry): omit GITHUB_TOKEN entirely

  return secrets;
}
```

**File**: `src/container-runner.ts`, update the call site (line 1326) to pass tools:
```
input.secrets = readSecrets(group.containerConfig?.tools);
```

**File**: `.env` — add scoped tokens:
```
GITHUB_TOKEN=ghp_xxx          # default (full access)
GITHUB_TOKEN_ILLYSIUM=ghp_yyy  # fine-grained PAT scoped to Illysium-ai org
```

The fine-grained PAT should be created on GitHub with:
- Repository access: Only Illysium-ai org repos
- Permissions: Contents (read/write), Pull requests (read/write), Issues (read/write)

### Change 3: Global Context Gating (~3 lines)

**File**: `src/container-runner.ts`, inside `buildVolumeMounts()`, the global dir section (lines 638-645).

```
// Current:
const globalDir = path.join(GROUPS_DIR, 'global');
if (fs.existsSync(globalDir)) {
  mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
}

// New:
const globalDir = path.join(GROUPS_DIR, 'global');
const mountGlobal = group.containerConfig?.globalContext !== false;
if (mountGlobal && fs.existsSync(globalDir)) {
  mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: true });
}
```

### Change 4: Update Illysium Container Config

Update the illysium group's container_config in the database:

```sql
-- Add github scoping, calendar scoping, and disable global context
UPDATE registered_groups
SET container_config = json_set(
  container_config,
  '$.globalContext', json('false')
)
WHERE folder = 'illysium';
```

And update the tools array to include scoped entries:
```json
{
  "tools": [
    "gmail:illysium",
    "calendar:illysium",
    "github:illysium",
    "granola",
    "snowflake:apollo",
    "snowflake:apollo_wgs",
    "snowflake:xzo_dev",
    "snowflake:xzo_prod"
  ],
  "assistantName": "illie",
  "globalContext": false
}
```

### sender_id Exemption

The current illysium CLAUDE.md has scope restrictions that only apply to non-Dave senders. This is a soft control (prompt-based) that can be prompt-injected. However, with credential isolation in place, it becomes defense-in-depth rather than the sole control:

- Even if the prompt restriction is bypassed, the container has no GitHub token for non-Illysium repos
- Even if the agent tries to access Dave's personal calendar, the tokens aren't mounted
- The global CLAUDE.md with project names isn't available

The sender_id exemption can remain as-is for now. It allows Dave to use the illysium channel for cross-project work when needed (he has the right to do so as owner). The credential scoping prevents teammates from doing the same.

## Security Considerations

- **Token storage**: Scoped GitHub tokens stay in `.env`, never in the database. The tools array only references the scope name.
- **Staging directories**: Calendar tokens are filtered and written to `data/sessions/{group}/calendar/`, same pattern as Snowflake staging. These dirs are ephemeral and not mounted into other groups.
- **Backwards compatibility**: `tools: undefined` means "all tools enabled" — existing groups get full access. Only groups with explicit tools arrays are restricted.
- **No new attack surface**: All three changes reduce access, they don't add new credential paths.

## Performance Considerations

- Calendar token filtering adds one JSON parse + write per container launch (~1ms). Negligible.
- GitHub token lookup adds one env var read. Negligible.
- Global context gating saves one mount. Marginal improvement.

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fine-grained PAT expires or gets revoked | H - Illysium agents can't push code | Monitor via `gh auth status` in scheduled task; alert Dave |
| Calendar tokens.json format changes upstream | L - Filtering breaks | tokens.json is a simple `{name: tokenData}` object; format is stable |
| Dave forgets to create GITHUB_TOKEN_ILLYSIUM | L - Falls back to full token | Log a warning when scoped token is requested but not found |
| Group with `tools: []` (empty array, like nanoclaw-dev) | L - No GitHub token at all | Already the case today (`isToolEnabled` returns false for empty array) |

## Testing Strategy

- **Unit**: Test `readSecrets` with various tools configurations: undefined, empty, 'github', 'github:illysium', no github entry
- **Unit**: Test calendar token filtering: full tokens.json in, filtered out with only specified accounts
- **Integration**: Launch illysium container, verify `gh auth status` works with scoped token, verify `git clone` of Illysium-ai repo succeeds, verify clone of non-Illysium repo fails
- **Integration**: Launch illysium container, verify calendar MCP only shows illysium account events
- **Integration**: Launch personal container (no tools restriction), verify all credentials still work

## Implementation Phases

### Phase 1: MVP (~100 lines)
- `globalContext: false` flag (3 lines)
- Calendar `calendar:<account>` filtering (25 lines in container-runner)
- GitHub `github:<scope>` token routing (20 lines in readSecrets)
- Update illysium container_config in DB
- ContainerConfig type update (1 line)

Validates: credential isolation works end-to-end for the illysium group.

### Phase 2: Hardening (~50 lines, if needed)
- Warning log when scoped token is missing (falls back to default)
- Scheduled health check for fine-grained PAT validity
- Consider removing sender_id exemption from illysium CLAUDE.md (requires Dave's explicit approval since it changes his own workflow)

## Open Questions

- [ ] Does Dave already have a fine-grained PAT for the Illysium-ai org, or does one need to be created? (Blocks Phase 1 for GitHub scoping)
- [ ] Should Granola also be scoped? Currently all groups with `granola` get the same token. If Granola notes contain sensitive cross-project info, this could be a leak vector. (Low priority — Granola is Dave-only, not shared with teammates)
- [ ] Should the `calendar` entry without a scope (e.g., `"calendar"` in the tools array) continue to mount ALL accounts, or should it be changed to mount only the "normal" (primary) account? (Backwards compat says keep current behavior)
