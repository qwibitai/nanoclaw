# Verify Classroom — Google Workspace

After running `/add-classroom-gws`:

- `pnpm exec tsc --noEmit` is clean.
- `pnpm test` is green.
- `src/class-drive.ts`, `src/class-pair-drive.ts`,
  `src/class-skeleton-drive-mount.ts` exist.
- `src/index.ts` includes `import './class-pair-drive.js';`.
- `scripts/class-skeleton-extensions.ts` includes
  `import '../src/class-skeleton-drive-mount.js';`.
- `googleapis` is in `package.json` dependencies and resolved in
  `pnpm-lock.yaml`.

Sanity checks for the runtime configuration:

```bash
# OAuth credentials with Drive scope
jq '.scope' ~/.config/gws/credentials.json | grep -q drive && echo "OK: Drive scope present"

# rclone installed
rclone --version | head -1

# rclone remote configured
rclone listremotes | grep -q '^class-drive:$' && echo "OK: class-drive remote present"

# Mount allowlist includes the rclone target
jq '.allowlist[]' ~/.config/nanoclaw/mount-allowlist.json | grep -q nanoclaw-drive-mount && echo "OK: mount allowlisted"
```

Real end-to-end (a paired student getting their Drive folder) is
covered in `plans/class-smoke-test.md` step 2.
