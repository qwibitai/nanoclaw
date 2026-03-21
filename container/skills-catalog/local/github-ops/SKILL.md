---
name: github-ops
description: Perform GitHub operations — create repos, open PRs, manage issues, clone, commit, push, review code, fork repos. Use when asked to do anything involving GitHub, git hosting, code review, or repository management.
allowed-tools: Bash(gh:*), Bash(git:*)
---

# GitHub Operations

## Prerequisites

- GH_TOKEN must be set (check with `gh auth status`)
- Always use HTTPS with token in remote URL for push: `https://USERNAME:${GH_TOKEN}@github.com/...`
- Get current authenticated username: `gh api user --jq .login`

## Common Operations

### Create a new repo

```bash
gh repo create REPO_NAME --public --description "DESC" --add-readme
```

### Check push access before starting work

Always check permissions first — if you have push access, work directly without forking.

```bash
gh api repos/OWNER/REPO --jq '.permissions'
# push=true → clone and push branches directly (no fork needed)
# push=false → fork first (see below)
```

### Clone a repo to /workspace/group/

```bash
mkdir -p /workspace/group
USERNAME=$(gh api user --jq .login)
cd /workspace/group && git clone https://${USERNAME}:${GH_TOKEN}@github.com/OWNER/REPO.git
```

### Create a branch, commit, push (with push access)

```bash
cd /workspace/group/REPO
git checkout -b feat/branch-name
# make changes
git add -A
git commit -m "feat: description"
git push origin feat/branch-name
```

### Open a PR (direct contributor)

```bash
gh pr create --repo OWNER/REPO --head BRANCH --base main \
  --title "Title" --body "Body"
```

### Fork a repo (only when you do NOT have push access)

```bash
gh repo fork OWNER/REPO --clone=false
USERNAME=$(gh api user --jq .login)
cd /workspace/group && git clone https://${USERNAME}:${GH_TOKEN}@github.com/${USERNAME}/REPO.git
```

### Open a PR from a fork

```bash
USERNAME=$(gh api user --jq .login)
gh pr create --repo OWNER/REPO --head ${USERNAME}:BRANCH --base main \
  --title "Title" --body "Body"
```

### List and view issues

```bash
gh issue list --repo OWNER/REPO
gh issue view NUMBER --repo OWNER/REPO
```

### Create an issue

```bash
gh issue create --repo OWNER/REPO --title "Title" --body "Body"
```

### View PR status/checks

```bash
gh pr status --repo OWNER/REPO
gh pr checks PR_NUMBER --repo OWNER/REPO
```

### Comment on a PR or issue

```bash
gh pr comment NUMBER --repo OWNER/REPO --body "Comment"
```

## Workflow Notes

- Always clone to /workspace/group/ (writable)
- Never force push without explicit user confirmation
- Always check git status before committing
- When opening PRs, write clear body explaining what changed and why
