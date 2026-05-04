---
name: add-ffmpeg-tool
description: Add ffmpeg as an MCP tool so the agent can convert, trim, extract audio from, and compress media files (mp4, mp3, wav, mov, webm, etc.) and send the result back to the channel. Wraps the ffmpeg/ffprobe binaries as a stdio MCP server; no third-party npm package, no credentials, no sidecar.
---

# Add ffmpeg Tool

Wires the in-repo `container/agent-runner/src/ffmpeg-mcp/server.ts` stdio MCP server into selected agent groups and adds the `ffmpeg` + `ffprobe` binaries to the container image. After this skill runs, the agent can take an inbound media attachment, transform it, and reply with the result via the existing `mcp__nanoclaw__send_file` tool.

Tools exposed (surfaced to the agent as `mcp__ffmpeg__<name>`):

| Tool | What it does |
|------|---------------|
| `probe` | ffprobe metadata: duration, format, per-stream codec/size info |
| `convert` | Change format/container (mp4 ↔ mp3 ↔ wav ↔ mov ↔ webm, etc.) |
| `trim` | Cut a `[start, start+duration)` segment |
| `extract_audio` | Strip the audio track from a video |
| `compress` | Re-encode for size, by CRF or rough target MB |

Streaming, complex filtergraphs, watermark/overlay, and DRM are intentionally out of scope — keeps the surface auditable.

**Why this pattern:** ffmpeg is a CLI binary already on `$PATH` once installed, so no separate npm package or OAuth flow is needed. The MCP server lives inside the agent-runner source tree (mounted RO at `/app/src` at runtime) and is invoked per-group via `bun run`. The tool-allowlist pattern (`mcp__ffmpeg__*`) is auto-derived from the group's `mcpServers` map by `providers/claude.ts` — no manual allowlist edit.

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'INSTALL_FFMPEG' container/Dockerfile && \
grep -q '^INSTALL_FFMPEG=true' .env 2>/dev/null && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Confirm the .env file exists

```bash
ls .env 2>&1
```

If absent, you're on a fresh checkout — run `/setup` first or `touch .env`.

## Phase 2: Apply Code Changes

### Enable the build flag

Upsert `INSTALL_FFMPEG=true` into `.env` (mirrors `INSTALL_CJK_FONTS`):

```bash
grep -q '^INSTALL_FFMPEG=' .env \
  && sed -i.bak 's/^INSTALL_FFMPEG=.*/INSTALL_FFMPEG=true/' .env && rm -f .env.bak \
  || echo 'INSTALL_FFMPEG=true' >> .env
```

`./container/build.sh` and `setup/container.ts` both read this var and pass `--build-arg INSTALL_FFMPEG=true` to docker, so the conditional `apt-get install ffmpeg` block in the Dockerfile fires.

### Rebuild the container image

```bash
./container/build.sh
```

ffmpeg (+ ffprobe + libs) adds ~80 MB. Verify the binaries landed:

```bash
docker run --rm "$(./container/build.sh --print-image 2>/dev/null || echo nanoclaw-agent:latest)" which ffmpeg ffprobe
```

(If `--print-image` isn't supported, just `docker images | head` to find the right tag.)

## Phase 3: Wire Per-Agent-Group

For each agent group that should be able to transform media (typically the user's personal DM agent — anywhere they routinely send video/audio attachments), edit `groups/<folder>/container.json` and merge in:

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

That's it — no `additionalMounts`, no env vars, no credentials. The MCP server reads input files from `/workspace/inbox/...` (already mounted as part of the session DB layout) and writes outputs to `/workspace/agent/tmp/`, which is the existing RW per-group workspace.

If the group should **not** have ffmpeg (e.g. a shared/scoped agent the user doesn't want producing media), leave its `container.json` untouched.

### Optional: extend the per-tool timeout

The default is 5 minutes per ffmpeg invocation. For groups that handle very long videos, override via env in the same `mcpServers.ffmpeg` block:

```jsonc
"env": { "NANOCLAW_FFMPEG_TIMEOUT_SEC": "900" }
```

## Phase 4: Build and Restart

```bash
pnpm run build
systemctl --user restart nanoclaw  # Linux
# launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
```

## Phase 5: Verify

### Test from the wired agent

Tell the user:

> Send a short `.mp4` to your `<agent-name>` chat with the message **"convert to mp3"**. The agent should call `mcp__ffmpeg__convert`, then `mcp__nanoclaw__send_file`, and you should receive the `.mp3` back in the same chat. Other things to try:
> - Send a video and ask **"what's the duration"** → uses `probe`, no file delivered.
> - Send a video and ask **"give me seconds 5–15 as a clip"** → uses `trim`.
> - Send a video and ask **"strip the audio out"** → uses `extract_audio`.

### Check logs if it's not working

```bash
tail -200 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'ffmpeg|mcp'
```

Every failure path inside the MCP server emits a `[ffmpeg-mcp]` line on stderr — the host pipes container stderr into the normal log stream, so `grep ffmpeg-mcp` is the fastest signal.

Common signals:
- `command not found: ffmpeg` → `INSTALL_FFMPEG=true` wasn't in `.env` at build time, or the image wasn't rebuilt. Re-run `./container/build.sh`.
- `Input path must live under /workspace` → the agent passed a path it shouldn't have. Tell it to operate on the attachment under `/workspace/inbox/...` (already in the system prompt context).
- `Unsupported output_format` → check the whitelist in `server.ts` (`OUTPUT_EXT_WHITELIST`); add the extension if it's a legitimate media format you trust.
- `ffmpeg failed: ...` → the line includes the last 200 chars of ffmpeg's stderr. Common cause: the input file isn't actually media (corrupted upload, wrong MIME).
- Agent says "I don't have ffmpeg tools" → the group's `container.json` is missing the `mcpServers.ffmpeg` entry, or the host wasn't restarted.

## Removal

1. Delete the `"ffmpeg"` entry from `mcpServers` in each group's `container.json`.
2. Set `INSTALL_FFMPEG=false` in `.env` (or remove the line) — frees ~80 MB on the next image build.
3. Optional: delete `container/agent-runner/src/ffmpeg-mcp/` if no group still uses it. Removing it doesn't break anything else; the file is only loaded when explicitly wired.
4. `./container/build.sh && pnpm run build && systemctl --user restart nanoclaw`.

## Notes

- **No credentials, no sidecar.** Unlike `/add-gmail-tool` (OAuth + OneCLI) or `/add-local-whisper` (Python sidecar), ffmpeg is a static binary — the MCP server is a thin wrapper that spawns it via `Bun.spawn` with array-form argv. No shell, no string interpolation, no privileged mounts.
- **Per-group opt-in.** Wiring is per-`container.json`, matching the `/add-gmail-tool` and `/add-ollama-tool` precedent. A group without the entry simply doesn't see the tools.
- **Output staging.** Tools write to `/workspace/agent/tmp/ffmpeg-<uuid>.<ext>`. The agent then chains `mcp__nanoclaw__send_file` to deliver. `/workspace/agent` is already RW-mounted; nothing new is needed.
- **Failure logging.** Every failure path (path traversal, extension whitelist, timeout, non-zero exit, missing binary) writes a `[ffmpeg-mcp] <tool>: <reason>` line to the container's stderr, which surfaces in `logs/nanoclaw.log` for operator triage. The user-facing error returned to the agent stays brief; the log line carries the full detail (exit code, stderr tail).

## Credits & references

- **Skill pattern:** modeled on [`add-gmail-tool`](../add-gmail-tool/SKILL.md) (per-group `container.json` wiring) and [`add-local-whisper`](../add-local-whisper/SKILL.md) (`.env`-driven build flag).
- **MCP server SDK:** [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk).
- **ffmpeg:** [ffmpeg.org](https://ffmpeg.org/), LGPL/GPL.
