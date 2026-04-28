# Remove: add-acurast-staking

## 1. Remove MCP server entry

Edit the group's `container.json` and delete the `acurast-staking` key from `mcpServers`.

## 2. Remove skill file

```bash
rm -rf /mnt/cache/appdata/nanoclaw/data/sessions/<GROUP_ID>/agent-runner-src/.claude/skills/add-acurast-staking/
```

## 3. Remove env vars (if no longer needed)

Remove `ACURAST_ADDR` and `ACURAST_COMMITMENT_ID` from the NanoClaw Unraid template.

## 4. Optionally remove @polkadot/api

If no other skills depend on it, remove from `container/package.json` and rebuild the agent image:

```bash
docker rmi nanoclaw-agent:latest
# Restart NanoClaw from Unraid UI
```
