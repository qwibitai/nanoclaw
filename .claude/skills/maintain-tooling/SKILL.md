# Maintain Tooling

Periodic maintenance skill for NanoClaw's development tooling.

## Full Check Pipeline

```bash
pnpm run check   # Runs format:check, lint, typecheck, test in parallel via turbo
pnpm run knip    # Dead code detection (separate — heavier analysis)
```

## Check for Outdated Dependencies

```bash
pnpm outdated
```

Review output, then update within semver ranges:

```bash
pnpm update
```

Or update to latest (review breaking changes first):

```bash
pnpm update --latest
```

## Audit for CVEs

```bash
pnpm audit
```

If upstream hasn't patched, add an override in `package.json`:

```json
"pnpm": {
  "overrides": {
    "vulnerable-package": ">=fixed.version"
  }
}
```

Then `pnpm install` to apply.

## Dead Code Detection

```bash
pnpm run knip
```

- Unused exports reported as **warnings** (not errors) because skills in `.claude/skills/` import dynamically
- Unused **dependencies** and **files** are errors — fix those
- Run `pnpm run knip:fix` to auto-remove unused exports/deps (review changes before committing)

## Update Individual Tools

| Tool   | Update Command                           |
| ------ | ---------------------------------------- |
| oxfmt  | `pnpm update oxfmt`                      |
| oxlint | `pnpm update oxlint`                     |
| turbo  | `pnpm update turbo`                      |
| knip   | `pnpm update knip`                       |
| tsgo   | `pnpm update @typescript/native-preview` |
| vitest | `pnpm update vitest @vitest/coverage-v8` |

After updating, run `pnpm run check` to verify nothing broke.

## Verify Security Fixes Haven't Regressed

```bash
pnpm audit                                    # 0 vulnerabilities expected
node -e "require('better-sqlite3')"           # Native module works
pnpm run check                                # All checks pass
```

Check that `pnpm.overrides` in `package.json` still has:

- `rollup: ">=4.59.0"` (CVE fix)
- `undici: ">=6.23.0"` (CVE fix)
