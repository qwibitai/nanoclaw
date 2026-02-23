# Git + PR Workflow

## Git Commands

```bash
# New feature branch
git checkout -b jarvis-<feature-name>

# Commit
git add -A
git commit -m "feat: description"

# Push
git push -u origin jarvis-<feature-name>
```

## Commit Message Format

| Type | Use |
|------|-----|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code refactor |
| `docs` | Documentation |
| `test` | Tests |
| `ci` | CI/CD |

---

## PR Creation

```bash
# Standard PR — include @claude only if Andy/project policy requires it
gh pr create \
  --title "feat: description" \
  --body "$(cat <<'EOF'
## Summary
- What changed and why

## Test plan
- [ ] Tests pass (exit 0)
- [ ] Browser tested (if UI)
EOF
)"
```

If review policy requires Claude review, add `@claude review this PR` to PR body or comment.

---

## Control-Plane Boundary

Workflow/review setup is owned by `andy-developer`:

- `ANTHROPIC_API_KEY` repository secret management
- `.github/workflows/*` creation and maintenance
- branch protection/ruleset policy

Workers should not change these unless dispatch explicitly marks a control-plane task.

---

## Token Issues

If push fails with "Repository not found":

```bash
# Re-embed token — GH_TOKEN is already set via direnv
git remote set-url origin https://oauth2:${GH_TOKEN}@github.com/openclaw-gurusharan/<repo>.git
git push -u origin jarvis-<feature>
```

See `github-account-isolation.md` for full env/secrets reference.
