---
name: podcast-research
description: Build the transcript library before writing any podcast briefing. Runs the YouTube → Groq → MLX transcript ladder against the watchlist's last 48h. Use when starting any briefing-style episode that covers external content (YouTube channels or podcast feeds).
---

# Build the Transcript Library

**Never write podcast coverage based on a title or RSS description alone. Always get the full content first.**

## The command

```
node /workspace/agent/podcast/bin/ingest-transcripts.mjs --feed <key>
```

Or for all feeds at once:

```
node /workspace/agent/podcast/bin/ingest-transcripts.mjs --all
```

Flags: `--force` (re-ingest existing), `--limit N` (cap discovery), `--dry-run` (no writes), `--retain-days N` (explicitly prune old transcript folders).

## What it does

1. Walks the feed's watchlist (`podcast/feeds/<key>.watchlist.json`).
2. Discovers episodes published in the last `lookbackHours` (default 48) by reading each channel's RSS XML.
3. Runs the **transcript ladder** for each episode:
   1. **YouTube captions** (free, instant, via `youtube-transcript` npm)
   2. **Groq Whisper** free tier (`whisper-large-v3-turbo`) — chunks audio with ffmpeg if > 24 MB
   3. **Local Apple Silicon MLX Whisper** — host-only fallback (won't run inside the container)
4. Writes per-episode folders to `podcast/library/transcripts/<feed>/<source>/<id>/`:
   - `transcript.txt` — plain text
   - `clean.md` — paragraph-formatted prose
   - `segments.json` — timestamped segments
   - `metadata.json` — provenance (engine, model, word count, status)
5. Optionally prunes old episode folders only if `--retain-days N` or `PODCAST_TRANSCRIPT_RETENTION_DAYS=N` is set.
6. Writes `podcast/library/transcripts/last-ingest.json` with the current run summary.
7. Rebuilds `podcast/library/transcripts/index.json`.
8. Writes `podcast/library/transcripts/feed-status.json` with per-feed freshness and latest-ready pointers.

## Reporting failures to Ilan (do not skip)

After running ingest, **always** read `/workspace/agent/podcast/library/transcripts/last-ingest.json`.

If `totals.failed > 0` OR `failures.length > 0`:
- Include a section in your Telegram reply titled `Ingest issues:` listing each failure as one bullet: `<feed>/<source>: <one-line summary of the error>`.
- Do NOT silently ship a thinner briefing without flagging that transcripts were lost.
- Keep the rest of the reply as normal: title, R2 URL, one-line through-line.

If `totals.failed === 0`, no failure section needed — reply normally.

For library freshness, use `/workspace/agent/podcast/library/transcripts/feed-status.json`, not `last-ingest.json`. `last-ingest.json` only describes the most recent command and may be a single-feed run; `feed-status.json` has `feeds.<key>.latestReadyCreatedAt`, `latestReadyPublishedAt`, and `lastRun` for each feed.

## Use the library when writing the script

Use `transcript.txt` or `clean.md` from the library as your source material when writing the script. Do not use titles or RSS descriptions when a transcript exists or can be produced. **Cover the content, not the topic list** — explain the actual argument, the data, the claim, the mechanism so the listener doesn't need to watch the original.

This skill owns source/external transcripts only. Pod-created episode scripts are registered separately under `podcast/library/produced/` by the publish pipeline or by `node podcast/bin/sync-produced-library.mjs`.

## Single-shot transcription (one-off podcast MP3s)

```
node /workspace/agent/podcast/bin/transcribe-audio.mjs <mp3Url|path> [--json output.json]
```

Same Groq → local MLX fallback. The MP3 URL comes from the `<enclosure url="...">` tag of an RSS item. Useful for transcribing something not in any watchlist.

## In-container limitations

- **Local MLX is Apple Silicon only.** Inside the Linux container the ladder is YouTube captions → Groq. If both fail, the episode is marked `status: failed` in metadata and shows up in `last-ingest.json` failures and `feed-status.json`.
- **ffmpeg + python3 + yt-dlp** are installed via the Pod's `container.json` apt list. If you see "command not found" errors, the container image rebuild hasn't happened yet — kill the container so the next spawn rebuilds.

## Rare manual setup

If you ever need to install local deps on the host: `python3 -m pip install -r /workspace/agent/podcast/requirements.txt`. Optional overrides in `.env`: `PODCAST_TRANSCRIBE_MODE=auto|groq|local`, `PODCAST_GROQ_WHISPER_MODEL=whisper-large-v3-turbo`, `PODCAST_LOCAL_WHISPER_MODEL=mlx-community/whisper-large-v3-turbo`.
