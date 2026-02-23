# GitHub Access

Account: `openclaw-gurusharan`. Full access to push, pull, commit, branch, and manage all repos under this account.

## Authentication

`GITHUB_TOKEN` is available in your environment. Use it for all git operations:

```bash
# Configure git to use the token for HTTPS (run once per session)
git config --global credential.helper store
echo "https://openclaw-gurusharan:$GITHUB_TOKEN@github.com" > ~/.git-credentials

# Or embed directly in remote URL for one-off ops
git clone https://openclaw-gurusharan:$GITHUB_TOKEN@github.com/openclaw-gurusharan/REPO.git
```

Always set git identity before committing:

```bash
git config --global user.email "openclaw-gurusharan@users.noreply.github.com"
git config --global user.name "Andy (openclaw-gurusharan)"
```

## Workspace

Clone repos into `/workspace/extra/repos/` — persists on host at `~/Documents/remote-claude/NanoClawWorkspace`:

```bash
cd /workspace/extra/repos
git clone https://openclaw-gurusharan:$GITHUB_TOKEN@github.com/openclaw-gurusharan/REPO.git
cd REPO
git add -A && git commit -m "message" && git push
```

## Discovering Repos

```bash
# List all repos under the account
gh repo list openclaw-gurusharan --limit 50
```

## Access Scope

- Any public repo on GitHub — clone without auth
- Any private repo where `openclaw-gurusharan` is a collaborator — use `$GITHUB_TOKEN`
- Private repos on other accounts where not a collaborator — not accessible
