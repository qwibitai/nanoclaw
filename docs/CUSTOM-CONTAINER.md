# Custom Container Image

The agent container is extended with dev tools via a layered `Dockerfile.custom` that builds on top of the base `nanoclaw-agent:latest` image. This avoids modifying the upstream `container/Dockerfile` directly, so upstream pulls are conflict-free.

## What's in the custom layer

| Tool | Source | Purpose |
|------|--------|---------|
| `jq` | apt | JSON processing in shell |
| `ripgrep` (`rg`) | apt | Fast code search |
| `gh` | GitHub apt repo | GitHub CLI (issues, PRs, repos) |
| `linear` | [schpet/linear-cli](https://github.com/schpet/linear-cli) binary | Linear issue management |

## How it works

```
container/Dockerfile          →  nanoclaw-agent:latest   (upstream, untouched)
Dockerfile.custom (FROM latest) →  nanoclaw-agent:custom   (our layer on top)
```

The systemd service sets `CONTAINER_IMAGE=nanoclaw-agent:custom` so the app uses the custom image. The `config.ts` already reads `process.env.CONTAINER_IMAGE`.

## Secrets

`GH_TOKEN` and `LINEAR_API_KEY` are read from `.env` by `readSecrets()` in `src/container-runner.ts` and passed to the container via stdin (never mounted as files or env vars). They are **not** in `SECRET_ENV_VARS`, so the agent's sanitization hook won't strip them — this is intentional so `gh` and `linear` can authenticate.

Set them in `.env`:

```
GH_TOKEN=ghp_xxxx
LINEAR_API_KEY=lin_api_xxxx
```

## Files involved

| File | Relationship to upstream |
|------|--------------------------|
| `container/Dockerfile` | Untouched — matches upstream exactly |
| `Dockerfile.custom` | New file — not in upstream |
| `src/container-runner.ts` | One-line change: 2 keys added to `readSecrets()` |
| `.env` / `data/env/env` | Local only (gitignored) |
| `.env.example` | Minor addition (placeholder lines) |
| `~/.config/systemd/user/nanoclaw.service` | Outside the repo |

## Updating from upstream

When pulling upstream changes:

1. **No conflict expected** on `container/Dockerfile` — it matches upstream
2. **Possible trivial conflict** on `src/container-runner.ts` if upstream changes the `readSecrets()` line — just re-add `'GH_TOKEN', 'LINEAR_API_KEY'` to the array
3. **Possible trivial conflict** on `.env.example` if upstream adds lines at the end

After merging upstream:

```bash
# 1. Rebuild base image (picks up upstream Dockerfile changes)
./container/build.sh

# 2. Rebuild custom layer on top
docker build -f Dockerfile.custom -t nanoclaw-agent:custom .

# 3. Compile and restart
npm run build
systemctl --user daemon-reload
systemctl --user restart nanoclaw
```

Use the `/update-from-upstream` skill to automate all of this.

## Adding more tools

Edit `Dockerfile.custom` and rebuild:

```bash
docker build -f Dockerfile.custom -t nanoclaw-agent:custom .
systemctl --user restart nanoclaw
```

If the tool needs an API key, add it to the `readSecrets()` array in `src/container-runner.ts` and to `.env`.
