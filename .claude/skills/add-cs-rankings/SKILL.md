---
name: add-cs-rankings
description: Add CS university rankings lookup to NanoClaw agents. Queries CSRankings.org for publication metrics by conference, country, and institution.
---

# Add CS Rankings

Adds the `csrankings-query` CLI tool to all container agents, allowing them to look up computer science university rankings from [CSRankings.org](https://csrankings.org/). The tool supports filtering by conference, country, and output format (plain text or JSON). Cache persists between container restarts.

## Phase 1: Pre-flight

1. Check if `container/skills/cs-rankings/SKILL.md` exists — if yes, skip to Phase 3.
2. Verify the container build toolchain works: `./container/build.sh` should be executable.

## Phase 2: Apply Code Changes

The changes are made directly (no branch merge required). The following files are modified:

- `container/skills/cs-rankings/SKILL.md` — agent-facing skill documentation
- `container/Dockerfile` — adds Python, uv, and csrankings-query installation
- `src/container-runner.ts` — adds persistent cache mount for CSRankings data

### Validate

```bash
npm run build
```

### Rebuild container

```bash
./container/build.sh
```

### Restart service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 3: Verify

### Test the tool

Ask the agent a question like:
> "How does Stanford rank in NeurIPS and ICML publications?"

The agent should use `csrankings-query` to look up the data and respond with publication counts.

### Check cache persistence

After the first query, the CSRankings data is cached in `data/csrankings-cache/`. Subsequent queries within 24 hours use cached data without network requests.

## Troubleshooting

### Agent says csrankings-query command not found

Container needs rebuilding. Run `./container/build.sh` and restart the service.

### Network errors fetching CSRankings data

The tool fetches data from GitHub (CSRankings repository). If the container has no network access, the tool falls back to stale cache if available. Use `--refresh` to force a fresh fetch.

### Cache not persisting

Verify the mount exists: check that `data/csrankings-cache/` is created on the host and mounted to `/home/node/.cache/csrankings/` in the container.
