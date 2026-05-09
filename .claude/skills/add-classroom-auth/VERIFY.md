# Verify Classroom — Per-Student Auth

After running `/add-classroom-auth`:

- `pnpm exec tsc --noEmit` is clean.
- `pnpm test` is green; `student-auth.test.ts` and
  `student-auth-server.test.ts` are present and passing.
- `bun test` (from `container/agent-runner/`) is green;
  `auth-nudge.test.ts` covers the failure-detection regex.
- `src/index.ts` includes the four auth-related imports
  (`class-codex-auth`, `class-pair-auth`, `class-telegram-commands`,
  `student-auth-handlers`).
- `src/config.ts` includes `STUDENT_AUTH_PORT`,
  `STUDENT_AUTH_BIND_HOST`, `NANOCLAW_PUBLIC_URL` exports.

Sanity for the runtime configuration:

```bash
# Public URL set?
grep -q '^NANOCLAW_PUBLIC_URL=' .env && echo "OK: NANOCLAW_PUBLIC_URL set"

# Auth port reachable on localhost (after host restart)?
curl -sf http://127.0.0.1:3003/student-auth?t=invalid -o /dev/null -w "%{http_code}\n"
# Expect: 404 (token invalid → "Link expired" page)
```

End-to-end (a paired student doing `codex login` + uploading) is
covered in `plans/class-smoke-test.md` — the auth section.
