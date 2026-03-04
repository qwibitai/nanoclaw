# Intent: Integrate per-group auth system into main orchestrator

## What changed
Six distinct modifications:

### 1. Imports (top of file)
- `NEW_GROUPS_USE_DEFAULT_CREDENTIALS` from `./config.js`
- `initCredentialStore`, `importEnvToDefault`, `resolveSecrets` from `./auth/index.js`
- `isAuthError` from `./auth/providers/claude.js`
- `runReauth` from `./auth/reauth.js`
- `ChatIO` type from `./auth/types.js`

### 2. registerGroup() — default credentials flag
Sets `containerConfig.useDefaultCredentials` to `NEW_GROUPS_USE_DEFAULT_CREDENTIALS`
if not explicitly set on the group.

### 3. createChatIO() — new helper function
After `_setRegisteredGroups()`. Creates a `ChatIO` that sends via channel
and receives by polling `getMessagesSince`.

### 4. processGroupMessages() — pre-run credential check
Before fetching missed messages, calls `resolveSecrets(group)`. If empty,
triggers `runReauth()`. Returns false if reauth fails.

### 5. processGroupMessages() — post-run auth error detection
After agent run, if error, calls `isAuthError(agentResult.error)` and
triggers `runReauth()` (only when no output was already sent to user).

Variable rename: `output` → `agentResult`.
Condition change: `output === 'error'` → `agentResult.status === 'error'`.

### 6. runAgent() — return type change
`'success' | 'error'` → `{ status: 'success' | 'error'; error?: string }`
Three return points changed to return objects.

### 7. main() — initialization
Added `initCredentialStore()` and `importEnvToDefault()` before `initDatabase()`.

## Why
Enables automatic detection of missing/expired credentials and interactive
reauth through normal messaging channels.

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
