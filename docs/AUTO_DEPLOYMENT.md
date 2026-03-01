# Automatic Deployment

NanoClaw can automatically detect when the `main` branch is updated on GitHub and deploy the changes to your host system without manual intervention.

## How It Works

1. **Polling Loop**: NanoClaw polls the `origin/main` branch every minute (configurable) to check for new commits
2. **Change Detection**: When a new commit is detected, the deployment process starts automatically
3. **Deployment Steps**: Executes the same steps from the manual deployment guide:
   - Record current state (for rollback)
   - Stash any uncommitted changes
   - Pull latest changes from `origin/main`
   - Analyze what changed (dependencies, source code, etc.)
   - Install dependencies (if `package.json` changed)
   - Rebuild TypeScript (if source code changed)
   - Restart the systemd service
   - Verify service is running
4. **Notifications**: Sends real-time notifications to your main chat about deployment progress and results
5. **Error Handling**: If deployment fails, you're notified immediately with error details

## Configuration

Auto-deployment is **enabled by default**. Configure it via environment variables:

```bash
# Disable auto-deployment
AUTO_DEPLOY_ENABLED=false

# Change polling interval (default: 60000ms = 1 minute)
AUTO_DEPLOY_POLL_INTERVAL=120000  # Check every 2 minutes
```

Add these to your `.env` file or set them as environment variables.

## Deployment Notification Examples

When a deployment runs, you'll receive real-time notifications in your main chat:

```
🔄 Deployment started
Current commit: a1b2c3d

📊 Changes detected
• 12 files changed
• Dependencies: No
• Source code: Yes

🔨 Building TypeScript...

🔄 Restarting service...

✅ Deployment successful!
• Previous: a1b2c3d
• Current: e4f5g6h
• Duration: 45.2s
```

If deployment fails:

```
❌ Deployment failed!
• Error: Failed to restart service: Unit not found
• Duration: 15.3s
• Manual intervention may be required
```

## What Gets Deployed Automatically

The auto-deployment system handles:

- ✅ Source code changes (`src/**/*.ts`)
- ✅ Dependency updates (`package.json`, `package-lock.json`)
- ✅ Configuration changes
- ✅ Documentation updates
- ✅ Any other changes to tracked files

**Note:** Container rebuild (Dockerfile changes) is not yet automated. If the Dockerfile changes, you'll need to rebuild manually:

```bash
docker build -t nanoclaw-agent:latest container/
systemctl --user restart nanoclaw
```

## Git Configuration Requirements

For auto-deployment to work, your host system needs:

1. **Git credentials configured** for GitHub access:
   ```bash
   # Personal Access Token (PAT) method
   git config --global credential.helper store
   echo "https://<username>:<token>@github.com" > ~/.git-credentials

   # OR SSH key method (preferred)
   ssh-keygen -t ed25519 -C "your_email@example.com"
   # Add ~/.ssh/id_ed25519.pub to GitHub SSH keys
   ```

2. **Remote tracking configured**:
   ```bash
   git remote -v
   # Should show:
   # origin  https://github.com/user/repo.git (fetch)
   # origin  https://github.com/user/repo.git (push)
   ```

3. **On main branch with tracking**:
   ```bash
   git checkout main
   git branch --set-upstream-to=origin/main main
   ```

## Security Considerations

### What Auto-Deployment Does NOT Do

- ❌ Does not push commits to GitHub
- ❌ Does not make code changes
- ❌ Does not merge branches
- ❌ Does not modify git history

### What It CAN Do

- ✅ Pull changes from `origin/main`
- ✅ Stash local uncommitted changes (non-destructively)
- ✅ Install dependencies
- ✅ Build and restart the service

### Safety Features

1. **Read-only git operations**: Only `git fetch` and `git pull` are used
2. **Stashing, not discarding**: Local changes are stashed, not deleted
3. **Rollback information**: Previous commit hash is recorded before deployment
4. **Service verification**: Checks that service is running after restart
5. **Error notifications**: You're immediately notified of any failures

### What Could Go Wrong?

**Scenario: Broken code gets merged to main**
- Auto-deployment will pull and deploy it
- If the build fails, you'll be notified
- Service restart might fail, leaving the old version running
- **Solution**: Revert the bad commit on GitHub, auto-deployment will pull the fix

**Scenario: Service fails to start after deployment**
- You'll receive a notification
- Service verification will fail
- Old version may still be running (if restart failed)
- **Solution**: Check logs with `journalctl --user -u nanoclaw -n 50`

**Scenario: Merge conflicts**
- If you have local uncommitted changes that conflict with remote
- Git pull will fail
- You'll be notified
- **Solution**: Manually resolve conflicts or discard local changes

## Manual Rollback

If auto-deployment causes issues, you can manually roll back:

```bash
cd ~/nanoclaw

# Stop the service
systemctl --user stop nanoclaw

# Revert to previous commit (check notification for commit hash)
git reset --hard <previous-commit-hash>

# Reinstall dependencies (if needed)
npm install

# Rebuild
npm run build

# Restart
systemctl --user restart nanoclaw
```

## Disabling Auto-Deployment

To disable auto-deployment temporarily:

```bash
# Option 1: Environment variable (survives restarts)
echo "AUTO_DEPLOY_ENABLED=false" >> .env
systemctl --user restart nanoclaw

# Option 2: One-time disable (until next restart)
# Edit the running process environment (advanced)
```

To re-enable:

```bash
# Remove from .env
sed -i '/AUTO_DEPLOY_ENABLED/d' .env
systemctl --user restart nanoclaw
```

## Monitoring Deployments

### View deployment history

Deployment events are logged to the systemd journal:

```bash
# View all deployment-related logs
journalctl --user -u nanoclaw | grep -i deploy

# View last deployment
journalctl --user -u nanoclaw | grep -i "Deployment started" -A 20

# Watch for live deployment activity
journalctl --user -u nanoclaw -f | grep -i deploy
```

### Check current state

```bash
# Current git commit
git -C ~/nanoclaw rev-parse HEAD

# Service status
systemctl --user status nanoclaw

# Recent logs
journalctl --user -u nanoclaw -n 50
```

## Testing Auto-Deployment

To test that auto-deployment works:

1. Make a trivial change in the container (not on host):
   ```bash
   # In Claude Code container
   cd /workspace/group/nanoclaw-dev
   echo "# Test" >> README.md
   git add README.md
   git commit -m "Test auto-deployment"
   git push origin main
   ```

2. Watch for deployment notification in your main chat (within ~1 minute)

3. Verify deployment succeeded:
   ```bash
   # On host
   git -C ~/nanoclaw log -1
   # Should show your test commit
   ```

4. Clean up (optional):
   ```bash
   # Revert test commit
   git revert HEAD
   git push origin main
   ```

## Troubleshooting

### Auto-deployment not triggering

**Check if it's enabled:**
```bash
journalctl --user -u nanoclaw | grep "Auto-deployment monitoring"
# Should see: "Auto-deployment monitoring enabled"
```

**Check git fetch access:**
```bash
cd ~/nanoclaw
git fetch origin main
# Should complete without errors
```

**Check for errors in logs:**
```bash
journalctl --user -u nanoclaw | grep -i "auto-deploy" -C 5
```

### Deployment stuck or hanging

Auto-deployment has timeouts:
- Git operations: 10 seconds
- npm install: 2 minutes
- npm build: 2 minutes
- Service restart: 2 minutes

If a step times out, you'll be notified and can investigate manually.

### GitHub rate limiting

GitHub API has rate limits for fetching:
- **Authenticated**: 5,000 requests/hour
- **Unauthenticated**: 60 requests/hour

With 1-minute polling, you'll make 60 requests/hour, which is fine for authenticated access.

**Solution**: Ensure git credentials are configured for authenticated access.

## Advanced Configuration

### Custom deployment script

If you need custom deployment steps, edit `src/auto-deploy.ts`:

```typescript
// Add custom step after build
const customStep = Date.now();
try {
  await execCommand('npm run custom-script', projectRoot);
  steps.push({
    name: 'Run custom script',
    success: true,
    duration: Date.now() - customStep,
  });
} catch (err) {
  // Handle error
}
```

### Different polling interval per environment

```bash
# Production: check every 5 minutes
AUTO_DEPLOY_POLL_INTERVAL=300000

# Development: check every 30 seconds
AUTO_DEPLOY_POLL_INTERVAL=30000
```

### Send notifications to multiple chats

Edit `src/index.ts` to send notifications to multiple groups:

```typescript
startAutoDeployLoop(
  PROJECT_ROOT,
  AUTO_DEPLOY_POLL_INTERVAL,
  async (message) => {
    // Send to main and dev-team groups
    for (const jid of ['main-jid', 'dev-team-jid']) {
      const channel = findChannel(channels, jid);
      if (channel) {
        await channel.sendMessage(jid, message);
      }
    }
  },
);
```

## Future Enhancements

Planned improvements for auto-deployment:

- [ ] Container rebuild detection (when Dockerfile changes)
- [ ] Automatic rollback on service failure
- [ ] Health check after deployment
- [ ] Deployment approval flow (manual confirmation before deploying)
- [ ] Webhook support (instead of polling)
- [ ] Deploy on git tags only (e.g., `v1.0.0`)
- [ ] Blue-green deployment strategy
- [ ] Deployment metrics and history in database

## Comparison to Manual Deployment

| Aspect | Manual | Auto-Deployment |
|--------|--------|-----------------|
| **Trigger** | You run commands | Automatic on main branch update |
| **Speed** | ~2-3 minutes | ~1-2 minutes (no human delay) |
| **Notifications** | None | Real-time progress updates |
| **Error handling** | You investigate | Immediate notification |
| **Rollback** | Manual | Automatic recording of previous state |
| **Consistency** | Varies by operator | Always follows same steps |
| **Documentation** | Reference deployment guide | Self-documenting via notifications |

## See Also

- [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) - Manual deployment process
- [SECURITY.md](SECURITY.md) - Security model and considerations
- [Container Runtime](container-runtime.md) - Container isolation details
