---
name: add-graphite
description: Add Graphite CLI to NanoClaw container and configure authentication. Installs Graphite for stacked PRs workflow and handles pre-authorization.
---

# Add Graphite CLI

This skill adds Graphite CLI support to NanoClaw by updating the Dockerfile template and pre-authorizing the CLI inside the container.

Graphite CLI enables stacked pull requests workflow, making it easier to manage complex PR chains and keep work organized.

## What This Does

1. Checks if Graphite is already installed in the Dockerfile
2. Updates Dockerfile template to include Graphite CLI
3. Rebuilds the container image with Graphite installed
4. Authenticates Graphite CLI with GitHub inside the container
5. Verifies the installation and auth

## Prerequisites

- GitHub token must be configured (`GITHUB_TOKEN` in `.env`)
- Container runtime must be available (Docker or Apple Container)

## Usage

Just run `/add-graphite` and the skill will walk you through the process.

## Steps

### 1. Check Current State

First, check if Graphite is already installed in the container:

```bash
# Check if Graphite is in the Dockerfile
grep -q "graphite" container/Dockerfile && echo "Found" || echo "Not found"
```

Also check if it's already available in a running container by trying to exec into one:

```bash
# Find a running container
CONTAINER=$(docker ps --filter "label=nanoclaw.group" --format "{{.Names}}" | head -1)
if [ -n "$CONTAINER" ]; then
  docker exec "$CONTAINER" which gt && echo "Graphite already installed" || echo "Not installed"
fi
```

### 2. Update Dockerfile Template

Read `container/Dockerfile` and add Graphite CLI installation after the GitHub CLI installation section.

Add this block after the `# Install GitHub CLI` section (around line 48-55):

```dockerfile
# Install Graphite CLI for stacked PRs workflow
RUN npm install -g @withgraphite/graphite-cli
```

This installs the Graphite CLI globally via npm, making the `gt` command available system-wide.

### 3. Rebuild Container Image

Tell the user:

> Graphite CLI has been added to the Dockerfile. Now I need to rebuild the container image. This will take a few minutes.

Run the container build script:

```bash
cd container && ./build.sh
```

**If the build fails:**
- Read `logs/setup.log` or check the terminal output for errors
- Common issues:
  - Network timeout downloading Graphite → retry the build
  - Architecture mismatch → verify the `GRAPHITE_ARCH` logic matches your platform
  - Permission errors → ensure Docker/Container runtime is running with proper permissions

### 4. Get GitHub Authentication Token

Graphite CLI needs to authenticate with GitHub. It uses the same GitHub token as the rest of NanoClaw.

Check if `GITHUB_TOKEN` is set:

```bash
if grep -q "^GITHUB_TOKEN=" .env; then
  echo "GitHub token found"
else
  echo "GitHub token not found"
fi
```

**If token is missing:**

Tell the user:

> Graphite needs a GitHub token to authenticate. You can use the same token configured for NanoClaw.
>
> If you haven't set up GitHub integration yet:
> 1. Go to https://github.com/settings/tokens (click **Tokens (classic)**)
> 2. Generate a new **classic** token with the **`repo`** scope
> 3. Add it to `.env`: `GITHUB_TOKEN=<token>`
> 4. Run `cp .env data/env/env` to sync to the container
>
> Then re-run this skill.

Wait for confirmation, then verify the token is in `.env`.

### 5. Authenticate Graphite in Container

Graphite authentication is handled automatically by the container entrypoint script.

When a container starts:
1. The entrypoint sources environment variables (including `GITHUB_TOKEN`)
2. If Graphite CLI is installed and not authenticated, it runs: `echo "$GITHUB_TOKEN" | gt auth --token -`
3. This happens on every container start, so authentication is always fresh

No manual auth steps needed! The authentication is built into `container/entrypoint.sh`.

### 6. Verify Installation

After rebuilding and restarting, verify Graphite works by checking container logs:

```bash
tail -f logs/nanoclaw.log
```

You should see Graphite authentication messages when containers start.

To manually verify in a running container:

```bash
# Find a running container
CONTAINER=$(docker ps --filter "label=nanoclaw.group" --format "{{.Names}}" | head -1)

# Check Graphite version and auth status
docker exec "$CONTAINER" gt --version
docker exec "$CONTAINER" gt auth status
```

Expected output:
```
@withgraphite/graphite-cli@1.7.x
✓ Authenticated as <your-github-username>
```

### 7. Copy Graphite Skill

The Graphite skill file provides documentation and examples for using Graphite CLI. It's already included in the container at `container/skills/graphite/SKILL.md`.

When containers start, skills from `container/skills/` are automatically available to agents.

### 8. Done!

Tell the user:

> ✅ *Graphite CLI is now installed and authenticated!*
>
> You can now use Graphite commands inside the container:
> - `gt stack submit` - Submit a stack of PRs
> - `gt stack restack` - Rebase the stack
> - `gt stack` - View current stack
> - `gt log` - View stack history
>
> The agent can use these commands when working on multi-PR workflows.
>
> A `/graphite` skill is also available with usage examples and workflow tips.

## Troubleshooting

### "gt: command not found" in container

Graphite installation didn't work or binary isn't in PATH.

Fix:
```bash
# Manually install in running container
CONTAINER=$(docker ps --filter "label=nanoclaw.group" --format "{{.Names}}" | head -1)
docker exec "$CONTAINER" bash -c "curl -fsSL https://graphite.dev/install.sh | sh && mv /root/.graphite/bin/gt /usr/local/bin/"
```

### Authentication fails

- Verify `GITHUB_TOKEN` is valid: `curl -H "Authorization: token $(grep GITHUB_TOKEN .env | cut -d= -f2)" https://api.github.com/user`
- Check token has `repo` scope
- Try manual auth: `docker exec -it <container> gt auth`

### Containers still using old image without Graphite

After rebuilding the image, existing containers need to be recreated.

Restart the service:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

This will spawn new containers with the updated image.

## Advanced: Graphite Configuration

Graphite stores config in `~/.graphite/`. To persist config across container recreations:

1. Add a volume mount for Graphite config in your container config
2. Or configure it via environment variables (check Graphite docs for supported vars)

For NanoClaw, since containers are ephemeral, the auth token approach (re-authing on boot if needed) is recommended.

## Related Skills

- `/setup` - Initial NanoClaw setup
- `/customize` - Customize Dockerfile and container settings

## Removal

To remove Graphite:

1. Remove the Graphite installation section from `container/Dockerfile`
2. Rebuild: `cd container && ./build.sh`
3. Restart service: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
