# Remove Classroom — Per-Student Auth

Reverses `/add-classroom-auth`.

## Steps

### 1. Remove imports from `src/index.ts`

Delete (or comment out):

```typescript
import './class-codex-auth.js';
import './class-pair-auth.js';
import './class-telegram-commands.js';
import './student-auth-handlers.js';
```

### 2. Remove the auth config exports from `src/config.ts`

Delete the block:

```typescript
const studentAuthEnv = readEnvFile(['NANOCLAW_PUBLIC_URL', 'STUDENT_AUTH_BIND_HOST']);
export const STUDENT_AUTH_PORT = ...;
export const STUDENT_AUTH_BIND_HOST: string = ...;
export const NANOCLAW_PUBLIC_URL: string = ...;
```

### 3. Delete the auth files

```bash
rm -f src/student-auth.ts src/student-auth.test.ts \
      src/student-auth-server.ts src/student-auth-server.test.ts \
      src/student-auth-handlers.ts \
      src/class-codex-auth.ts \
      src/class-telegram-commands.ts \
      src/class-pair-auth.ts \
      container/agent-runner/src/auth-nudge.ts \
      container/agent-runner/src/auth-nudge.test.ts
```

### 4. Decide what to do with stored student auth tokens

The skill stores per-student auth tokens at
`data/student-auth/<sanitized_user_id>/auth.json`. Removing the
skill code without cleaning the storage leaves the tokens on disk;
they're harmless without the resolver registered, but they're
sensitive credentials.

**Wipe the tokens** (recommended unless you might re-install):

```bash
rm -rf data/student-auth/
```

### 5. Optional: unset `NANOCLAW_PUBLIC_URL`

If you set it in `.env` only for this skill, remove it. Other
skills don't read it.

### 6. Restart and rebuild

```bash
pnpm exec tsc --noEmit
pnpm test
systemctl --user restart nanoclaw   # or macOS launchd equivalent
```
