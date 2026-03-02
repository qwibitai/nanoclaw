---
name: update-from-upstream
description: "Pull upstream NanoClaw changes, merge with local customizations, rebuild both container images, and restart. Use instead of /update when running a customized container setup. Triggers on \"update from upstream\", \"pull upstream and rebuild\"."
---

# Update from Upstream

Pulls upstream NanoClaw changes, merges them with local customizations (custom container image, extra secrets), rebuilds everything, and restarts the service.

This skill wraps the standard `/update` workflow and adds the custom container rebuild steps. See `docs/CUSTOM-CONTAINER.md` for background.

**Principle:** Automate everything. Only pause for user input on merge conflicts or unexpected failures.

## 1. Run the standard upstream update

Invoke the `/update` skill to handle fetching, merging, conflict resolution, migrations, and verification. Wait for it to complete before continuing.

If `/update` fails or the user cancels, stop here — do not proceed to container rebuilds.

## 2. Verify custom files survived the merge

After the upstream merge, check that our customizations are intact:

### 2a. Check `readSecrets()` in `src/container-runner.ts`

```bash
grep -n "GH_TOKEN\|LINEAR_API_KEY" src/container-runner.ts
```

**If both keys are present:** Continue.

**If either key is missing:** The upstream merge overwrote our change. Fix it by ensuring the `readSecrets()` call includes all four keys:

```typescript
return readEnvFile(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GH_TOKEN', 'LINEAR_API_KEY']);
```

Edit `src/container-runner.ts` to restore the missing keys.

### 2b. Check `Dockerfile.custom` exists

```bash
test -f Dockerfile.custom && echo "EXISTS" || echo "MISSING"
```

**If MISSING:** This should never happen (upstream doesn't touch this file). Alert the user and stop.

### 2c. Check `.env.example` has the token placeholders

```bash
grep -c "GH_TOKEN\|LINEAR_API_KEY" .env.example
```

**If count < 2:** Add the missing placeholders to the end of `.env.example`:

```
# Dev tools (optional, for gh and linear CLIs inside containers)
GH_TOKEN=
LINEAR_API_KEY=
```

## 3. Rebuild base container image

```bash
./container/build.sh
```

**If this fails:** Show the error output. Common causes:
- Network issues fetching packages — retry once
- Upstream Dockerfile syntax errors — report to user, this needs upstream fix

## 4. Rebuild custom container image

```bash
docker build -f Dockerfile.custom -t nanoclaw-agent:custom .
```

**If this fails:** Show the error output. Common causes:
- Base image not built (step 3 failed) — fix step 3 first
- Package version no longer available — check `Dockerfile.custom` for pinned versions that may need updating
- `linear-cli` release URL changed — check https://github.com/schpet/linear-cli/releases for the latest release and update the URL in `Dockerfile.custom`

## 5. Verify tools in custom image

Run a quick smoke test:

```bash
docker run --rm --entrypoint sh nanoclaw-agent:custom -c "jq --version && rg --version && gh --version && linear --version"
```

**If any tool fails:** The custom layer build succeeded but a tool is broken. Show which tool failed and the error. This likely means the tool's install method changed — check `Dockerfile.custom`.

## 6. Build TypeScript and restart

```bash
npm run build
```

**If build fails:** Show the error. Try to fix type errors from the merge. If `readSecrets()` was modified in step 2a, make sure the edit is syntactically correct.

Then reload and restart the service:

```bash
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

Verify it started:

```bash
sleep 2 && systemctl --user is-active nanoclaw
```

**If not active:** Check the logs:

```bash
journalctl --user -u nanoclaw --since "1 min ago" --no-pager
```

Show the error to the user.

## 7. Report

Summarize what happened:
- Upstream version change (from → to)
- Whether any custom files needed fixup
- Container image rebuild status
- Service status

If everything succeeded, end with: "Update complete. Both container images rebuilt and service restarted."

## Systemd environment reference

The service at `~/.config/systemd/user/nanoclaw.service` must have:

```
Environment=CONTAINER_IMAGE=nanoclaw-agent:custom
```

If this line is missing (e.g., service file was regenerated), add it after the `PATH` environment line and re-run `systemctl --user daemon-reload`.
