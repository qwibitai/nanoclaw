---
name: add-github
description: Add GitHub CLI (gh) integration to NanoClaw. Enables listing repos, reading code, managing issues/PRs, and searching GitHub without cloning repos locally. Guides through installation and authentication setup.
---

# Add GitHub Integration

This skill adds GitHub CLI capabilities to NanoClaw, allowing you to work with GitHub repos directly from Telegram.

## What You Can Do

Once configured:
- List your repos
- Read files from any repo without cloning
- Search code across repos
- Create and manage issues
- Create and manage pull requests
- View releases, workflows, etc.

## Installation Steps

### 1. Check if gh is Already Installed

```bash
which gh && gh --version || echo "gh not installed"
```

If gh is installed, skip to "Authentication" section.

### 2. Install GitHub CLI in Container

The GitHub CLI needs to be installed in the container image. We'll modify the Dockerfile:

```bash
# Read current Dockerfile
cat /workspace/project/container/Dockerfile
```

Add these lines after the chromium installation section (before the npm install lines):

```dockerfile
# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*
```

### 3. Rebuild Container Image

After modifying the Dockerfile:

```bash
cd /workspace/project
docker build -t nanoclaw-agent:latest -f container/Dockerfile container/
```

This will take a few minutes. The image will be rebuilt with GitHub CLI included.

### 4. Restart NanoClaw

After the image is rebuilt, restart the NanoClaw service to use the new image.

## Authentication

### Option 1: Using GitHub Token (Recommended for Containers)

1. Create a Personal Access Token on GitHub:
   - Go to https://github.com/settings/tokens
   - Click "Generate new token" → "Generate new token (classic)"
   - Select scopes: `repo`, `read:org`, `workflow`
   - Copy the token

2. Add token to NanoClaw's .env file:

```bash
# On the host machine, edit the .env file
echo 'GITHUB_TOKEN=ghp_yourTokenHere' >> /workspace/project/.env
```

3. The token will be available in containers via environment variables

### Option 2: Interactive Login (If Running Locally)

```bash
gh auth login
```

Follow the prompts to authenticate via browser.

## Verification

Test that gh is working:

```bash
# List your repos
gh repo list --limit 5

# View your profile
gh api user

# Search repos
gh repo list | grep -i "search-term"
```

## Usage Examples

Once configured, you can ask Nano things like:

- "List my GitHub repos"
- "Show me the README from my clc repo"
- "Search for 'authentication' in my repos"
- "Create an issue in TSAMonster repo"
- "Show open PRs in my Better Consultants projects"

## Common Commands Reference

```bash
# List repos
gh repo list [owner] --limit 30

# Clone a repo (if needed)
gh repo clone owner/repo

# View repo details
gh repo view owner/repo

# List issues
gh issue list --repo owner/repo

# Create issue
gh issue create --repo owner/repo --title "Title" --body "Description"

# List PRs
gh pr list --repo owner/repo

# View file contents
gh api repos/owner/repo/contents/path/to/file

# Search code
gh search code --owner owner "search query"

# List releases
gh release list --repo owner/repo
```

## Troubleshooting

### "gh: command not found" in new containers

- The container image needs to be rebuilt
- Make sure you ran `docker build` after modifying the Dockerfile
- Restart NanoClaw to use the new image

### Authentication failures

- Check that GITHUB_TOKEN is set in .env
- Verify token has correct scopes
- Try creating a new token

### Rate limiting

- Authenticated requests have higher rate limits
- Consider using a token with appropriate permissions
- GitHub API limits: 5000 requests/hour (authenticated)

## Notes

- The GitHub token should be kept secret
- Never commit tokens to git repos
- Tokens can be revoked at any time from GitHub settings
- The .env file is git-ignored by default

## Next Steps

After setup is complete, update Nano's memory to include:
- Your GitHub username
- Important repos to track
- Common tasks you want to automate
