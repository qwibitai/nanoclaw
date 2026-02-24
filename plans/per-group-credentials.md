# Per-Group API Credentials

## Problem

All groups currently share a single set of credentials (`ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`) read from the project-level `.env` file. This means:

- Every group consumes the same API quota / billing account
- You can't give one group a Claude Code subscription while another uses an API key
- Revoking access to one group means revoking it for all

## Current Credential Flow

```
.env                          readSecrets()               stdin JSON                  sdkEnv
  ANTHROPIC_API_KEY     -->   container-runner.ts:185  --> container-runner.ts:273 --> agent-runner/index.ts:513
  CLAUDE_CODE_OAUTH_TOKEN                                  (deleted at :277)          (never touches process.env)
```

Key files and lines:

| File | Lines | Role |
|------|-------|------|
| `src/env.ts` | 11-42 | `readEnvFile()` — parses `.env`, returns requested keys |
| `src/container-runner.ts` | 185-187 | `readSecrets()` — calls `readEnvFile` for the two secret keys |
| `src/container-runner.ts` | 272-277 | Injects secrets into `ContainerInput`, writes to stdin, deletes from object |
| `src/types.ts` | 35-42 | `RegisteredGroup` — no credential fields today |
| `src/db.ts` | 71-79 | `registered_groups` schema — no credential columns today |
| `src/db.ts` | 510-545 | `getRegisteredGroup()` — reads and hydrates group from DB |
| `src/db.ts` | 547-566 | `setRegisteredGroup()` — persists group to DB |
| `src/ipc.ts` | 351-382 | `register_group` IPC handler — only main group can register |
| `container/agent-runner/src/index.ts` | 191 | `SECRET_ENV_VARS` list for bash sanitization |
| `container/agent-runner/src/index.ts` | 511-516 | Merges `containerInput.secrets` into `sdkEnv` |

## Proposed Design

### Credential Resolution Order

Per-group credentials are optional. When a container launches, credentials resolve as:

```
1. Group-specific credential (from DB)  →  if set, use it
2. Global credential (from .env)        →  fallback
```

Each group can independently use either `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` (or both). The resolution is per-key, so a group could override just one while inheriting the other.

> **WARNING — Review before implementation:** The fallback logic is dangerous. A group that is intended to use its own credentials but has them misconfigured (e.g. typo, expired token, missing value) would silently fall back to the global credential — consuming the wrong billing account, bypassing per-group access control intent, and masking the configuration error. Consider whether fallback should be opt-in rather than automatic, or whether groups with any per-group credential set should **never** fall back (fail loudly instead). This decision has billing, security, and UX implications and must be deliberately reviewed at implementation time.

### Data Model Changes

**`src/types.ts` — `RegisteredGroup` interface (line 35)**

Add optional credential fields:

```typescript
export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean;
  // Per-group credentials (optional — falls back to global .env)
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
}
```

No `credentialMode` flag needed — the presence of a value is the signal. Null/undefined = use global.

**`src/db.ts` — Schema migration (after line 79)**

Add two nullable encrypted columns:

```sql
ALTER TABLE registered_groups ADD COLUMN anthropic_api_key_enc TEXT;
ALTER TABLE registered_groups ADD COLUMN oauth_token_enc TEXT;
```

These store encrypted ciphertext, never plaintext.

### Encryption at Rest

Credentials in SQLite must be encrypted. The approach:

1. **Master key location**: `~/.config/nanoclaw/credentials.key`
   - Same external directory as `mount-allowlist.json` — outside the project root, inaccessible to containers
   - Generated automatically on first use (32 random bytes, hex-encoded)
   - File permissions set to `0600` (owner-only read/write)

2. **Algorithm**: AES-256-GCM via Node.js built-in `crypto` module (no new dependency)
   - Encrypt: `crypto.createCipheriv('aes-256-gcm', key, iv)` with random 12-byte IV
   - Stored format: `iv_hex:auth_tag_hex:ciphertext_hex`
   - Decrypt: `crypto.createDecipheriv('aes-256-gcm', key, iv)` with auth tag verification

3. **New file**: `src/credential-store.ts`

```typescript
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

const KEY_PATH = path.join(os.homedir(), '.config', 'nanoclaw', 'credentials.key');
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function getOrCreateKey(): Buffer {
  const dir = path.dirname(KEY_PATH);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(KEY_PATH)) {
    return Buffer.from(fs.readFileSync(KEY_PATH, 'utf-8').trim(), 'hex');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, key.toString('hex'), { mode: 0o600 });
  return key;
}

export function encrypt(plaintext: string): string {
  const key = getOrCreateKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(stored: string): string {
  const key = getOrCreateKey();
  const [ivHex, tagHex, ciphertextHex] = stored.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(ciphertextHex, 'hex', 'utf8') + decipher.final('utf8');
}
```

### File-by-File Changes

#### 1. `src/types.ts` (line 35-42)

Add `anthropicApiKey?` and `claudeCodeOauthToken?` to `RegisteredGroup`.

#### 2. `src/credential-store.ts` (new file)

Encryption/decryption helpers as shown above. Master key at `~/.config/nanoclaw/credentials.key`.

#### 3. `src/db.ts`

**Schema migration** (after line 102): Add two `ALTER TABLE` statements for the new encrypted columns, wrapped in try/catch like the existing migrations.

**`getRegisteredGroup()`** (lines 510-545): Read the encrypted columns, decrypt if present, populate the new fields on the returned object.

**`setRegisteredGroup()`** (lines 547-566): Encrypt credential fields if present, write to the new columns. Update the INSERT/REPLACE statement to include the two new columns.

**`getAllRegisteredGroups()`** (lines 568-601): Same decrypt-on-read treatment.

#### 4. `src/container-runner.ts` (lines 185-187)

Change `readSecrets()` to accept the group and merge:

```typescript
function readSecrets(group: RegisteredGroup): Record<string, string> {
  const global = readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
  // Per-group overrides (if set, takes priority over global)
  if (group.anthropicApiKey) {
    global['ANTHROPIC_API_KEY'] = group.anthropicApiKey;
  }
  if (group.claudeCodeOauthToken) {
    global['CLAUDE_CODE_OAUTH_TOKEN'] = group.claudeCodeOauthToken;
  }
  return global;
}
```

Update call site at line 273:

```typescript
input.secrets = readSecrets(group);  // was: readSecrets()
```

The `group` parameter is already available — `runContainerAgent` receives it at line 218.

#### 5. `src/ipc.ts` (lines 351-382)

Accept optional credential fields in the `register_group` handler:

```typescript
deps.registerGroup(data.jid, {
  name: data.name,
  folder: data.folder,
  trigger: data.trigger,
  added_at: new Date().toISOString(),
  containerConfig: data.containerConfig,
  requiresTrigger: data.requiresTrigger,
  anthropicApiKey: data.anthropicApiKey,        // new
  claudeCodeOauthToken: data.claudeCodeOauthToken,  // new
});
```

#### 6. `container/agent-runner/src/index.ts`

**No changes needed.** The agent runner already:
- Accepts any `Record<string, string>` secrets (line 514)
- Merges them into `sdkEnv` generically (line 515)
- Strips `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` from bash (line 191, 199)

### Security Considerations

| Concern | Mitigation |
|---------|------------|
| Plaintext credentials in SQLite | AES-256-GCM encryption at rest |
| Master key compromise | Stored at `~/.config/nanoclaw/credentials.key` with `0600` perms, outside project root, never mounted into containers |
| Credential leakage via logs | Existing `delete input.secrets` at line 277 already handles this; no credential values in log output |
| Cross-group credential access | Container isolation unchanged — each group only receives its own resolved secrets via stdin |
| Credential leakage via bash | Existing `SECRET_ENV_VARS` sanitization in agent-runner (line 191-199) covers this |
| IPC credential injection | Only main group can call `register_group` (line 352-358 authorization gate) |
| DB file stolen | Encrypted columns are useless without the master key file |

### What Does NOT Change

- The container-side agent runner (zero changes)
- The bash sanitization hook
- The stdin-based secret passing mechanism
- The `ContainerInput` interface (secrets are already `Record<string, string>`)
- Mount security, path validation, or IPC authorization
- Groups without per-group credentials (they keep using global `.env` as today)

### Summary

| Aspect | Details |
|--------|---------|
| Files changed | 4 existing (`types.ts`, `db.ts`, `container-runner.ts`, `ipc.ts`) + 1 new (`credential-store.ts`) |
| Breaking changes | None — all new fields are optional with global fallback |
| New dependencies | None — uses Node.js built-in `crypto` |
| DB migration | Additive — two nullable columns |
| Container-side changes | None |
| Encryption | AES-256-GCM, master key at `~/.config/nanoclaw/credentials.key` |
