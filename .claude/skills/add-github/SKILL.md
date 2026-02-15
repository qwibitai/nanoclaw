---
name: add-github
description: Add GitHub integration to NanoClaw. Agents can create issues, comment on PRs, check CI status, and manage repositories using the gh CLI. Guides through GitHub token setup and container configuration.
---

# Add GitHub Integration

This skill gives NanoClaw agents the ability to interact with GitHub repositories. Agents can create issues, comment on PRs, check CI status, browse code, and manage repositories -- all from WhatsApp.

Uses the official `gh` CLI which is already installed in the container base image (it comes with Claude Code).

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

**USER ACTION REQUIRED**

**Use the AskUserQuestion tool** to present this:

> You'll need a GitHub Personal Access Token (classic) for the agent to use.
>
> 1. Go to https://github.com/settings/tokens
> 2. Click **Generate new token (classic)**
> 3. Give it a name (e.g., "NanoClaw")
> 4. Select scopes:
>    - `repo` - Full repository access
>    - `read:org` - Read org membership (optional, for org repos)
>    - `workflow` - Manage GitHub Actions (optional)
> 5. Click **Generate token** and copy it
>
> Do you have your token ready?

Wait for user to confirm and provide the token.

---

## Implementation

### Step 1: Add GitHub Token to Environment

Add the token to `.env`:

```bash
echo "GITHUB_TOKEN=<token_from_user>" >> .env
```

Add `GITHUB_TOKEN` to the list of allowed env vars in `src/container-runner.ts`. Find the `allowedVars` array in the `buildVolumeMounts` function and add to it:

```typescript
const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN'];
```

### Step 2: Configure gh CLI in Container

Read `container/Dockerfile` and add the `gh` CLI authentication setup. Find the entrypoint script section and add environment variable setup:

If the Dockerfile already sources the env file, `gh` will pick up `GITHUB_TOKEN` automatically since `gh` respects the `GITHUB_TOKEN` environment variable natively. Verify this by checking the entrypoint.

If the Dockerfile uses a custom entrypoint script, ensure it exports `GITHUB_TOKEN`:

```bash
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
```

### Step 3: Enable Bash Tool for gh Commands

Read `container/agent-runner/src/index.ts` and verify that `Bash` is in the `allowedTools` array. The `gh` CLI is invoked via Bash, so this tool must be available.

The `Bash` tool should already be allowed. Confirm:

```typescript
allowedTools: [
  'Bash',  // This enables gh CLI usage
  ...other tools...
],
```

### Step 4: Update Group Memory

Append to `groups/CLAUDE.md`:

```markdown

## GitHub

You have access to the `gh` CLI for GitHub operations. Use it via the Bash tool:

**Common commands:**
- `gh issue list -R owner/repo` - List issues
- `gh issue create -R owner/repo --title "..." --body "..."` - Create an issue
- `gh pr list -R owner/repo` - List PRs
- `gh pr view 123 -R owner/repo` - View PR details
- `gh pr checks 123 -R owner/repo` - Check CI status
- `gh api repos/owner/repo/pulls/123/comments` - View PR comments
- `gh release list -R owner/repo` - List releases
- `gh repo view owner/repo` - View repo info

**Tips:**
- Always use `-R owner/repo` to specify which repository
- Use `--json` flag for structured output: `gh issue list -R owner/repo --json number,title,state`
- For commenting on PRs/issues: `gh issue comment 123 -R owner/repo --body "..."`
```

Also append the same section to `groups/main/CLAUDE.md`.

### Step 5: Rebuild Container and Restart

Rebuild the container to include the updated env vars:

```bash
cd container && ./build.sh
```

Compile TypeScript:

```bash
cd .. && npm run build
```

Restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### Step 6: Test

Tell the user:

> GitHub integration is ready! Test it by sending:
>
> `@Andy list the open issues on owner/repo`
>
> Or:
>
> `@Andy what's the status of PR #123 on owner/repo?`
>
> Replace `owner/repo` with a real repository you have access to.

Monitor logs:

```bash
tail -f logs/nanoclaw.log
```

---

## Advanced: Mount Git Config for Push Access

If you want the agent to be able to clone and push to repos, you'll need to mount git configuration:

Read `src/container-runner.ts` and find the `buildVolumeMounts` function. Add:

```typescript
// Git config for authenticated operations
const gitConfigDir = path.join(homeDir, '.gitconfig');
if (fs.existsSync(gitConfigDir)) {
  mounts.push({
    hostPath: gitConfigDir,
    containerPath: '/home/node/.gitconfig',
    readonly: true,
  });
}
```

**Security note:** This gives the container read access to your git config. Only add this if you trust the agent with your git credentials.

---

## Troubleshooting

### "gh: command not found"

The `gh` CLI should be available in the container via Claude Code. If not:

1. Check if it's in the container: `docker run --rm nanoclaw-agent:latest which gh`
2. If missing, add to Dockerfile: `RUN apt-get update && apt-get install -y gh`

### "authentication required"

- Verify `GITHUB_TOKEN` is in `.env`
- Verify it's in the `allowedVars` array
- Rebuild the container
- Test the token: `GITHUB_TOKEN=<token> gh auth status`

### "Resource not accessible"

- The token may not have the required scope
- Regenerate with correct scopes (at minimum: `repo`)

---

## Removing GitHub Integration

1. Remove `GITHUB_TOKEN` from `.env`

2. Remove `GITHUB_TOKEN` from the `allowedVars` array in `src/container-runner.ts`

3. Remove "GitHub" sections from `groups/*/CLAUDE.md`

4. Rebuild:
   ```bash
   cd container && ./build.sh && cd ..
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```
