# Intent: Replace readSecrets() with auth/provision resolveSecrets()

## What changed
1. Import: removed `readEnvFile` from `./env.js`, added `resolveSecrets` from `./auth/provision.js`
2. Deleted `readSecrets()` function (was reading 4 env keys from .env)
3. Changed call site: `input.secrets = readSecrets()` → `input.secrets = resolveSecrets(group)`

## Why
The old `readSecrets()` read the same .env keys for all groups. The new
`resolveSecrets(group)` reads credentials from the encrypted store with
per-group scope resolution and default fallback.

## Key sections

### Import (~line 18)
- Removed: `import { readEnvFile } from './env.js';`
- Added: `import { resolveSecrets } from './auth/provision.js';`

### readSecrets function (was ~lines 213-225)
- Entire function body deleted
- Replaced with comment: `// readSecrets() replaced by resolveSecrets()`

### Call site in runContainerAgent (~line 312)
- `input.secrets = readSecrets()` → `input.secrets = resolveSecrets(group)`
- `resolveSecrets` takes `group: RegisteredGroup` parameter

## Invariants
- All exported interfaces unchanged
- Secrets are still passed via stdin, never mounted as files
- The `delete input.secrets` line after write is unchanged
- All other functions (buildVolumeMounts, buildContainerArgs, etc.) unchanged
- Output parsing unchanged

## Must-keep
- The import path `./auth/provision.js` (not `./auth/index.js`)
- `resolveSecrets(group)` receives the full RegisteredGroup
