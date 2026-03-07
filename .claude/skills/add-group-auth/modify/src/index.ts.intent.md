# Intent: Integrate per-group auth system into main orchestrator

## What changed
Six distinct modifications:

### 1. Imports (top of file)
- `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` from `./config.js`
- `initCredentialStore`, `importEnvToDefault`, `createAuthGuard` from `./auth/index.js`
- `ChatIO` type from `./auth/types.js`

### 2. registerGroup() — default credentials flag
Sets `containerConfig.useDefaultCredentials` to `NEW_GROUPS_USE_DEFAULT_CREDENTIALS`
if not explicitly set on the group.

### 3. createChatIO() — new helper function
After `_setRegisteredGroups()`. Creates a `ChatIO` that sends via channel
and receives by polling `getMessagesSince`.

### 4. processGroupMessages() — auth guard
Creates an `AuthGuard` via `createAuthGuard()` at the top of the function.
- Pre-run: `guard.preCheck()` verifies credentials, runs reauth if missing.
  On failure, advances cursor past trigger messages and returns.
- Streaming: `guard.onStreamResult(result)` detects auth errors, kills container.
- Post-run: `guard.handleAuthError(agentResult.error)` triggers reauth on auth errors.

Variable rename: `output` → `agentResult`.
Condition change: `output === 'error'` → `agentResult.status === 'error'`.

### 5. runAgent() — return type change
`'success' | 'error'` → `{ status: 'success' | 'error'; error?: string }`
Three return points changed to return objects.

### 6. main() — initialization
Added `initCredentialStore()` and `importEnvToDefault()` before `initDatabase()`.

## Why
Enables automatic detection of missing/expired credentials and interactive
reauth through normal messaging channels. Auth detection and reauth logic
is encapsulated in `auth/guard.ts` to minimize index.ts injection surface.

## Invariants
- All other functions unchanged (startMessageLoop, recoverPendingMessages, etc.)
- Message formatting, cursor management, idle timer logic unchanged
- Channel typing indicators unchanged
- IPC watcher and task scheduler initialization unchanged
- Queue management unchanged

## Must-keep
- `initCredentialStore()` must be called before `initDatabase()`
- `importEnvToDefault()` must be called at startup to migrate .env credentials
- `runAgent` return type must be the object form (callers depend on `.status` and `.error`)
