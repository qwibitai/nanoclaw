---
name: add-ytdlp
description: Add yt-dlp as an MCP tool so the agent can search, fetch metadata, download subtitles/transcripts, and pull video/audio from YouTube, Vimeo, X, TikTok, and ~1000 other sites. Patches `container/Dockerfile` to install the standalone yt-dlp binary, adds `@kevinwatt/yt-dlp-mcp` as an agent-runner dep, and wires it as a stdio MCP server.
---

# Add Video Download

Patches `container/Dockerfile` to install `yt-dlp` (~30MB), adds the upstream `@kevinwatt/yt-dlp-mcp` npm package as an agent-runner runtime dep, and wires it into selected agent groups as a stdio MCP server. After install the agent can take a URL the user shares and reply with the file via `mcp__nanoclaw__send_file`, or with metadata/transcripts/subtitles inline.

The trunk container image ships **without** yt-dlp — it's added only when this skill runs. The patch is a real Dockerfile edit so it survives `./container/build.sh` and `pnpm run dev` invocations consistently.

The MCP server itself is the upstream `@kevinwatt/yt-dlp-mcp` package (MIT, Node 18+, single maintainer Dewei Yen). We pin a specific version into `container/agent-runner/package.json` rather than vendoring or wrapping — the package is a thin Zod-validated stdio bridge to the yt-dlp CLI, so its API surface is whatever yt-dlp itself can do.

Tools surfaced as `mcp__yt-dlp__ytdlp_<name>` (8 total — see [README](https://github.com/kevinwatt/yt-dlp-mcp) for full schemas):

| Tool | What it does |
|------|---------------|
| `ytdlp_search_videos` | YouTube search with pagination + date filter (JSON / Markdown) |
| `ytdlp_get_video_metadata` | Full JSON metadata (title, channel, views, formats, …) |
| `ytdlp_get_video_metadata_summary` | Human-readable metadata summary |
| `ytdlp_list_subtitle_languages` | List available subtitle languages for a URL |
| `ytdlp_download_video_subtitles` | VTT subtitles with timestamps |
| `ytdlp_download_transcript` | Clean plain-text transcript |
| `ytdlp_download_video` | Save video file (480p / 720p / 1080p / best, optional trim) |
| `ytdlp_download_audio` | Audio only (M4A / MP3) |

Downloads land in `$YTDLP_DOWNLOADS_DIR` (defaults below to `/workspace/agent/tmp`), so the agent can hand the resulting path straight to `mcp__nanoclaw__send_file`.

## Phase 1: Pre-flight

```bash
grep -q '# ---- yt-dlp' container/Dockerfile && echo "DOCKERFILE ALREADY PATCHED — skip Phase 2"
grep -q '@kevinwatt/yt-dlp-mcp' container/agent-runner/package.json && echo "AGENT-RUNNER ALREADY HAS DEP — skip Phase 3"
```

## Phase 2: Patch the Dockerfile and rebuild

Use the Edit tool to insert a new RUN block into `container/Dockerfile` immediately before the `# Chromium path for agent-browser ...` ENV line (i.e. right after the system-deps `RUN ... apt-get install ...` block). Insert exactly:

```dockerfile
# ---- yt-dlp (added by /add-ytdlp) ---------------------------------
# Standalone PyInstaller-bundled Linux binary from the upstream GitHub release
# (~30MB). No apt package, no Python on PATH required. Used by the
# @kevinwatt/yt-dlp-mcp MCP server. The --version smoke-test fails the build
# if the download is corrupt or the tag was retracted. Bump deliberately.
# Replace <tag> with the N-1 tag in the releases page
ARG YTDLP_VERSION=<tag>
RUN curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
         -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

```

The leading `# ---- yt-dlp` marker is the idempotency anchor — re-running the skill on a patched Dockerfile is a no-op.

## Phase 3: Add the MCP server as an agent-runner dep

`@kevinwatt/yt-dlp-mcp` is npm-published; pin a specific version so rebuilds are reproducible. The agent-runner tree uses Bun, not pnpm, so the `minimumReleaseAge` policy does not apply here — pick a version deliberately by checking [the npm release history](https://www.npmjs.com/package/@kevinwatt/yt-dlp-mcp?activeTab=versions) and prefer one that's been live for at least a few days.

```bash
cd container/agent-runner && bun add @kevinwatt/yt-dlp-mcp@0.8.4
cd ../..
```

This updates `container/agent-runner/package.json` and `container/agent-runner/bun.lock`. Both must be committed — the Dockerfile copies them in and runs `bun install --frozen-lockfile`.

Then rebuild:

```bash
./container/build.sh
```

Verify (the image tag is install-slug-derived and printed at the end of `build.sh`; `--entrypoint sh` is required so the agent-runner entrypoint doesn't intercept):

```bash
IMAGE=$(docker images --filter 'reference=nanoclaw-agent*:latest' --format '{{.Repository}}:{{.Tag}}' | head -1)
docker run --rm --entrypoint sh "$IMAGE" -c 'yt-dlp --version && test -f /app/node_modules/@kevinwatt/yt-dlp-mcp/lib/index.mjs && echo OK'
```

Expect a yt-dlp date version (e.g. `2026.03.17`) followed by `OK`.

## Phase 4: Wire per-agent-group

For each group that should get video-download capability, merge into `groups/<folder>/container.json`:

```jsonc
{
  "mcpServers": {
    "yt-dlp": {
      "command": "bun",
      "args": ["run", "/app/node_modules/@kevinwatt/yt-dlp-mcp/lib/index.mjs"],
      "env": {
        "YTDLP_DOWNLOADS_DIR": "/workspace/agent/tmp"
      }
    }
  }
}
```

`YTDLP_DOWNLOADS_DIR` redirects downloads from the package's default `~/Downloads` (which doesn't exist in the container) to the existing session tmp path, swept periodically by `mcp__nanoclaw__send_file` consumers.

Optional env overrides (see [package config docs](https://github.com/kevinwatt/yt-dlp-mcp/blob/main/docs/configuration.md)):

```jsonc
"env": {
  "YTDLP_DOWNLOADS_DIR": "/workspace/agent/tmp",
  "YTDLP_DEFAULT_RESOLUTION": "1080p",      // 480p | 720p | 1080p | best (default 720p)
  "YTDLP_DEFAULT_SUBTITLE_LANG": "en"        // default subtitle language
}
```

If the group should be allowed to read private / age-gated YouTube content, see the package's [cookie guide](https://github.com/kevinwatt/yt-dlp-mcp/blob/main/docs/cookies.md) — it's a separate decision and requires mounting a cookie file.

## Phase 5: Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 6: Verify

In a wired chat, send a YouTube link with **"download this"** — you should get the video file back. Other prompts to try: **"give me the transcript"** (`ytdlp_download_transcript`), **"what's the channel and view count"** (`ytdlp_get_video_metadata_summary`), **"audio only"** (`ytdlp_download_audio`).

If something's off:

```bash
tail -200 logs/nanoclaw.log logs/nanoclaw.error.log | grep -F 'yt-dlp'
```

Common signals:
- `command not found: yt-dlp` → image wasn't rebuilt after the Dockerfile patch. Re-run `./container/build.sh`.
- `Cannot find module '@kevinwatt/yt-dlp-mcp'` → `bun.lock` wasn't updated, or the image was built before the lockfile change. Re-run `bun add` then rebuild.
- Agent says "I don't have download tools" → group's `container.json` is missing the `mcpServers["yt-dlp"]` entry, or the host wasn't restarted.
- Download succeeds but `mcp__nanoclaw__send_file` fails to find the file → check `YTDLP_DOWNLOADS_DIR` matches what `send_file` is given. Default `/workspace/agent/tmp` is the safe choice.

## Removal

1. Delete the `"yt-dlp"` entry from `mcpServers` in each group's `container.json`.
2. `cd container/agent-runner && bun remove @kevinwatt/yt-dlp-mcp && cd ../..`.
3. Edit `container/Dockerfile` and remove the `# ---- yt-dlp (added by /add-ytdlp) ---` block (the comment header through the trailing blank line).
4. `./container/build.sh && pnpm run build && systemctl --user restart nanoclaw`.
