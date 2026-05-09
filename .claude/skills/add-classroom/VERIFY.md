# Verify Classroom (base)

After running `/add-classroom`:

- `pnpm exec tsc --noEmit` is clean.
- `pnpm test` is green; new test files `class-config.test.ts`,
  `class-container-env.test.ts` are present and passing.
- `src/index.ts` imports `class-pair-greeting`, `class-playground-gate`,
  `class-container-env` (none of `class-pair-drive`, `class-pair-auth`,
  `class-codex-auth`, `class-telegram-commands` until those skills are
  layered on).

Quick smoke (no real channel needed):

```bash
mkdir -p /tmp/kb /tmp/wiki
git -C /tmp/wiki init -q && cd /tmp/wiki && echo '# wiki' > index.md && git add . && git -c user.email=test@local -c user.name=test commit -qm init && cd -
pnpm exec tsx scripts/class-skeleton.ts --count 1 --names "Test" --kb /tmp/kb --wiki /tmp/wiki
```

Should print the test student's pairing code and write
`data/class-config.json`, `class-roster.csv`, and
`groups/student_01/`. The DB row `agent_groups WHERE folder =
'student_01'` should exist.

To complete pairing end-to-end (with a real Telegram bot), see
`plans/class-smoke-test.md`.
