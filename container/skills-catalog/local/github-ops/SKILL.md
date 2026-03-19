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

### Clone a repo to /home/node/work/

```bash
mkdir -p /home/node/work
cd /home/node/work && git clone https://github.com/OWNER/REPO.git
```

### Create a branch, commit, push

```bash
cd /home/node/work/REPO
git checkout -b feat/branch-name
# make changes
git add -A
git commit -m "feat: description"
USERNAME=$(gh api user --jq .login)
git remote set-url origin https://${USERNAME}:${GH_TOKEN}@github.com/${USERNAME}/REPO.git
git push origin feat/branch-name
```

### Fork a repo

```bash
gh repo fork OWNER/REPO --clone=false
# then clone your fork:
USERNAME=$(gh api user --jq .login)
cd /home/node/work && git clone https://${USERNAME}:${GH_TOKEN}@github.com/${USERNAME}/REPO.git
```

### Open a PR

```bash
gh pr create --repo OWNER/REPO --head USERNAME:BRANCH --base main \
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

- Always clone to /home/node/work/ (writable)
- Never force push without explicit user confirmation
- Always check git status before committing
- When opening PRs, write clear body explaining what changed and why
