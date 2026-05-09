# Remove Classroom — Google Workspace

Reverses `/add-classroom-gws`. Safe to run before or after
`/remove-classroom`.

## Steps

### 1. Remove imports

Delete (or comment out) from `src/index.ts`:

```typescript
import './class-pair-drive.js';
```

Delete (or comment out) from `scripts/class-skeleton-extensions.ts`:

```typescript
import '../src/class-skeleton-drive-mount.js';
```

### 2. Delete the gws files

```bash
rm -f src/class-drive.ts \
      src/class-pair-drive.ts \
      src/class-skeleton-drive-mount.ts
```

### 3. Drop the dep

```bash
pnpm remove googleapis
```

### 4. Stop rclone (optional)

```bash
fusermount -u ~/nanoclaw-drive-mount   # Linux
# or `umount ~/nanoclaw-drive-mount`   # macOS
```

### 5. Decide what to do with provisioned Drive folders

The skill doesn't touch the Drive folders the gws consumer created.
They stay in the instructor's Drive. You can:

- **Keep them** — students retain access; instructor still owns the
  files.
- **Delete them** manually from the Drive UI (or via
  `rclone delete class-drive:<folder>`).

`agent_groups.metadata.drive_folder_id` and `drive_folder_url`
fields are left on the DB; they're harmless without the gws skill
re-installed (no code reads them when class-pair-drive.ts is gone).

### 6. Rebuild

```bash
pnpm exec tsc --noEmit
pnpm test
```
