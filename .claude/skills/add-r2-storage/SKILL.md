---
name: add-r2-storage
description: Add Cloudflare R2 storage integration. Enables file uploads from Discord attachments, per-group access control, and shared/private bucket architecture. Depends on Discord channel.
---

# Add R2 Storage

Adds Cloudflare R2 object storage to NanoClaw. Discord attachments are downloaded and uploaded to a private R2 bucket before CDN URLs expire. Groups get per-row permission control (`full` / `shared_read` / `none`).

**Prerequisite:** Discord channel must be installed first (`skill/discord` or `discord/main` merged).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/r2.ts` exists. If it does, skip to Phase 3 (Setup). The code changes are already in place.

### Verify Discord is installed

Check if `src/channels/discord.ts` exists. If not, tell the user to run `/add-discord` first.

## Phase 2: Apply Code Changes

### Merge the skill branch

```bash
git fetch upstream skill/r2-storage
git merge upstream/skill/r2-storage || {
  git checkout --theirs package-lock.json
  git add package-lock.json
  git merge --continue
}
```

This merges in:
- `src/r2.ts` — R2Client class (upload, download, list, presign, sharedPublish, sharedRead)
- `src/types.ts` — `r2Permission` field on `RegisteredGroup`
- `src/db.ts` — `r2_permission` column migration + CRUD updates
- `src/channels/discord.ts` — attachment download → R2 upload with 1 retry
- `src/container-runner.ts` — pass R2 env vars to containers
- `.env.example` — R2 credential placeholders
- `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` dependencies

If the merge reports conflicts, resolve them by reading the conflicted files and understanding the intent of both sides.

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Create R2 Buckets

Tell the user:

> I need you to set up Cloudflare R2:
>
> 1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/) → R2 Object Storage
> 2. Create **two buckets**:
>    - **Private bucket** (e.g., `nanoclaw-private-<instance>`) — per-instance, isolated storage
>    - **Shared bucket** (e.g., `nanoclaw-shared`) — for cross-instance file exchange
> 3. On the private bucket, add a **Lifecycle Rule**:
>    - Prefix: `uploads/`
>    - Action: Delete after **7 days**
>    - This auto-cleans temporary attachment uploads
> 4. Create **3 API tokens** (R2 → Manage R2 API Tokens):
>    - `<instance>-rw` — Private bucket read/write (Object Read & Write, scoped to private bucket)
>    - `shared-read` — Shared bucket read only (Object Read, scoped to shared bucket)
>    - `shared-write` — Shared bucket read/write (Object Read & Write, scoped to shared bucket)
> 5. Note down the **Account ID** from the R2 overview page

Wait for the user to provide credentials.

### Configure environment

Add to `.env`:

```bash
R2_ACCOUNT_ID=<account-id>
R2_PRIVATE_BUCKET=<private-bucket-name>
R2_PRIVATE_ACCESS_KEY=<private-rw-access-key>
R2_PRIVATE_SECRET_KEY=<private-rw-secret-key>
R2_SHARED_BUCKET=<shared-bucket-name>
R2_SHARED_READ_ACCESS_KEY=<shared-read-access-key>
R2_SHARED_READ_SECRET_KEY=<shared-read-secret-key>
R2_SHARED_WRITE_ACCESS_KEY=<shared-write-access-key>
R2_SHARED_WRITE_SECRET_KEY=<shared-write-secret-key>
NANOCLAW_ID=<unique-instance-id>
```

`NANOCLAW_ID` is used as the prefix for shared bucket keys (e.g., `myvm4`). Each instance must use a unique ID.

R2 is optional — if `R2_ACCOUNT_ID` is missing, the system silently falls back to attachment placeholders (existing behavior).

### Set group permissions

For the main group (full R2 access):

```bash
node -e "
const Database = require('better-sqlite3');
const db = new Database('./store/messages.db');
db.prepare('UPDATE registered_groups SET r2_permission = ? WHERE is_main = 1').run('full');
db.close();
"
```

Permission levels:
- `full` — upload to private bucket, read/write shared bucket
- `shared_read` — read shared bucket only (good for external/client groups)
- `none` — no R2 access, attachments shown as placeholders (default)

### Build and restart

```bash
npm run build
```

For Linux (systemd):
```bash
systemctl --user restart nanoclaw
```

For macOS (launchd):
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Verify

1. Send a file attachment in a registered Discord channel with `r2_permission = 'full'`
2. Check the agent message includes `[File uploaded to R2: uploads/<timestamp>-<filename>]`
3. Check logs for "Attachment uploaded to R2":
   ```bash
   tail -50 logs/nanoclaw.log | grep -i r2
   ```

## Architecture

### Bucket Structure

```
nanoclaw-private-<instance>/     ← Per-instance, isolated
  uploads/                       ← Discord attachments (7-day TTL)
  memory/                        ← Persistent agent files (no TTL)

nanoclaw-shared/                 ← Cross-instance exchange
  <nanoclaw-id>/outbox/          ← Files published by this instance
```

### R2Client API

| Method | Bucket | Description |
|--------|--------|-------------|
| `upload(key, body, contentType?)` | Private | Upload file, returns key |
| `download(key)` | Private | Download as Buffer |
| `read(key)` | Private | Download as UTF-8 string |
| `list(prefix?)` | Private | List objects by prefix |
| `presign(key, ttl?)` | Private | Generate presigned URL (default 24h) |
| `sharedPublish(filename, body, contentType?)` | Shared | Publish to `<nanoclawId>/outbox/` |
| `sharedRead(key)` | Shared | Read from shared bucket |

### Security Model

- Three separate S3 clients with different credentials (private r/w, shared read, shared write)
- Per-group `r2Permission` controls access at the application layer
- Credentials are passed to containers via env vars only for groups with R2 access
- `getR2Client()` returns `null` when R2 is not configured — all callers must handle this

## Troubleshooting

### Attachments still showing as placeholders

1. Check `R2_ACCOUNT_ID` is set in `.env`
2. Check the group has `r2_permission = 'full'`:
   ```bash
   node -e "
   const Database = require('better-sqlite3');
   const db = new Database('./store/messages.db');
   console.log(db.prepare('SELECT jid, name, r2_permission FROM registered_groups').all());
   db.close();
   "
   ```
3. Check logs for R2 errors: `grep -i 'r2\|s3\|upload' logs/nanoclaw.log | tail -20`

### Upload failures

- **AccessDenied**: Check API token has Object Read & Write permission scoped to the correct bucket
- **NoSuchBucket**: Verify bucket name in `.env` matches exactly (case-sensitive)
- **Network errors**: Ensure the instance can reach `<account-id>.r2.cloudflarestorage.com`

### Container agent can't access R2

Check that env vars are being passed through:
```bash
docker inspect <container-name> | grep R2
```
If empty, restart NanoClaw — the env passthrough in `container-runner.ts` reads `.env` at container spawn time.
