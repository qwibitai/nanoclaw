---
name: add-ffmpeg-tool
description: Add ffmpeg as an MCP tool so the agent can convert, trim, extract audio from, and compress media files (mp4, mp3, wav, mov, webm, etc.) and send the result back to the channel. Wraps the ffmpeg/ffprobe binaries as a stdio MCP server; no third-party npm package, no credentials, no sidecar.
---

# Add ffmpeg Tool

Wires the in-repo `container/agent-runner/src/ffmpeg-mcp/server.ts` MCP server into selected agent groups and adds the `ffmpeg` + `ffprobe` binaries to the container image. After install, the agent can transform an inbound media attachment and reply with the result via `mcp__nanoclaw__send_file`.

Tools surfaced as `mcp__ffmpeg__<name>`:

| Tool | What it does |
|------|---------------|
| `probe` | ffprobe metadata: duration, format, per-stream codec/size info |
| `convert` | Change format/container (mp4 ↔ mp3 ↔ wav ↔ mov ↔ webm, etc.) |
| `trim` | Cut a `[start, start+duration)` segment |
| `extract_audio` | Strip the audio track from a video |
| `compress` | Re-encode for size, by CRF or rough target MB |

## Phase 1: Pre-flight

```bash
grep -q 'INSTALL_FFMPEG' container/Dockerfile && \
grep -q '^INSTALL_FFMPEG=true' .env 2>/dev/null && \
echo "ALREADY APPLIED — skip to Phase 3"
```

Confirm `.env` exists (`ls .env`); if absent, run `/setup` first or `touch .env`.

## Phase 2: Enable the build flag and rebuild

```bash
grep -q '^INSTALL_FFMPEG=' .env \
  && sed -i.bak 's/^INSTALL_FFMPEG=.*/INSTALL_FFMPEG=true/' .env && rm -f .env.bak \
  || echo 'INSTALL_FFMPEG=true' >> .env

./container/build.sh
```

Adds ~80 MB to the image. Verify:

```bash
docker run --rm nanoclaw-agent:latest which ffmpeg ffprobe
```

## Phase 3: Wire per-agent-group

For each group that should be able to transform media, merge into `groups/<folder>/container.json`:

```jsonc
{
  "mcpServers": {
    "ffmpeg": {
      "command": "bun",
      "args": ["run", "/app/src/ffmpeg-mcp/server.ts"],
      "env": {}
    }
  }
}
```

No `additionalMounts`, no credentials. Inputs are read from `/workspace/inbox/...` (already mounted), outputs go to `/workspace/agent/tmp/`.

Optional: extend the per-tool timeout (default 5 min) for groups that handle very long media:

```jsonc
"env": { "NANOCLAW_FFMPEG_TIMEOUT_SEC": "900" }
```

## Phase 4: Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 5: Verify

In a wired chat, send a short `.mp4` with **"convert to mp3"** — you should receive an `.mp3` back. Other prompts to try: **"what's the duration"** (probe), **"give me seconds 5–15"** (trim), **"strip the audio"** (extract_audio).

If something's off:

```bash
tail -200 logs/nanoclaw.log logs/nanoclaw.error.log | grep -F '[ffmpeg-mcp]'
```

Every failure path emits a `[ffmpeg-mcp]` line on the container's stderr, captured by the host into `logs/nanoclaw.log`.

Common signals:
- `command not found: ffmpeg` → image wasn't rebuilt with `INSTALL_FFMPEG=true`. Re-run `./container/build.sh`.
- `Input path must live under /workspace` → tell the agent to operate on `/workspace/inbox/...`.
- `Unsupported output_format` → check `OUTPUT_EXT_WHITELIST` in `server.ts`.
- `ffmpeg failed: ...` → the line includes the last 200 chars of ffmpeg's stderr; usually the input isn't valid media.
- Agent says "I don't have ffmpeg tools" → group's `container.json` is missing the `mcpServers.ffmpeg` entry, or the host wasn't restarted.

## Removal

1. Delete the `"ffmpeg"` entry from `mcpServers` in each group's `container.json`.
2. Set `INSTALL_FFMPEG=false` in `.env`.
3. `./container/build.sh && pnpm run build && systemctl --user restart nanoclaw`.
