---
name: commit
description: Commit and optionally push changes. Scans for secrets, writes good commit messages, and credits the user as co-author. Use when user says "commit", "push", "save changes", or "commit and push".
---

# Commit Changes

## 1. Pre-flight Checks

Run all checks automatically before staging anything.

### Sensitive Data Scan

Scan staged and unstaged diffs for leaked secrets:

```bash
git diff --cached --diff-filter=d -- . | grep -iEn '(sk-ant-|sk-[a-z]+-[a-z0-9]{20,}|ghp_|gho_|github_pat_|xoxb-|xoxp-|AKIA[0-9A-Z]{16}|password\s*=\s*["\x27][^"\x27]{8,})' | head -20
git diff --diff-filter=d -- . | grep -iEn '(sk-ant-|sk-[a-z]+-[a-z0-9]{20,}|ghp_|gho_|github_pat_|xoxb-|xoxp-|AKIA[0-9A-Z]{16}|password\s*=\s*["\x27][^"\x27]{8,})' | head -20
```

Also check untracked files that would be added:

```bash
git ls-files --others --exclude-standard | xargs -I{} grep -liEn '(sk-ant-|sk-[a-z]+-[a-z0-9]{20,}|ghp_|gho_|github_pat_|xoxb-|xoxp-|AKIA[0-9A-Z]{16})' {} 2>/dev/null | head -10
```

**If any real secrets are found:** STOP. Show the user what was found and which files. Do NOT proceed until resolved.

Ignore pattern examples like `sk-ant-oat01-...` or `<your-token>` — only flag actual key values.

### Verify .gitignore Coverage

Confirm these sensitive paths are gitignored:

```bash
git check-ignore .env data/ store/ *.keys.json
```

If any are NOT ignored, warn the user before proceeding.

## 2. Review Changes

```bash
git status
git diff --stat
```

Show the user a summary of what will be committed. If there are unrelated changes that should be separate commits, suggest splitting them.

## 3. Stage and Commit

Stage the relevant files. Prefer specific file paths over `git add -A`:

```bash
git add <specific files>
```

Never stage files that match secret patterns (`.env`, `*.keys.json`, `data/env/`, `store/`).

### Commit Message

Write a concise commit message following the project's style (imperative mood, lowercase start for type prefixes). Look at recent commits for style:

```bash
git log --oneline -5
```

Always include the user as co-author. The user's identity:

```
Co-Authored-By: harmonycapybara <harmonycapybara@users.noreply.github.com>
```

And the AI co-author:

```
Co-Authored-By: Claude <noreply@anthropic.com>
```

Use a HEREDOC for the commit message:

```bash
git commit -m "$(cat <<'EOF'
<type>: <description>

Co-Authored-By: harmonycapybara <harmonycapybara@users.noreply.github.com>
Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## 4. Push (if requested)

Only push if the user explicitly asked. Confirm the remote and branch first:

```bash
git remote -v
git branch -vv
```

Then push:

```bash
git push
```

If the branch has no upstream, use:

```bash
git push -u origin <branch>
```

Never force push without explicit user confirmation.
