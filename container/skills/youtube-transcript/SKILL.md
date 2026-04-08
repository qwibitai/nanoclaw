---
name: youtube-transcript
description: Extract transcripts (subtitles/auto-captions) from YouTube videos. Use when the user shares a YouTube link and wants the content summarized, analyzed, or discussed, or when asked to get a transcript from a video. Supports any language available on the video.
---

# YouTube Transcript

Extract text transcripts from YouTube videos via auto-generated or manual captions.

## Usage

```bash
python3 scripts/transcript.py <url_or_id> [--lang en] [--save path/to/file.txt]
```

Accepts full URLs (`youtube.com/watch?v=...`, `youtu.be/...`) or bare video IDs.

Without `--save`, outputs plain text to stdout. With `--save`, writes to file and prints path to stderr.

## Examples

```bash
# Get transcript to stdout
python3 scripts/transcript.py "https://youtu.be/41UDGsBEjoI"

# Save to file
python3 scripts/transcript.py 41UDGsBEjoI --save /tmp/transcript.txt

# Prefer Russian captions
python3 scripts/transcript.py 41UDGsBEjoI --lang ru
```

## Dependency

Requires `youtube-transcript-api` (pip). Install if missing:

```bash
pip3 install youtube-transcript-api
```

## Limitations

- Only works if video has captions (manual or auto-generated)
- Auto-generated captions may have errors (no punctuation, wrong words)
- Some videos have captions disabled by uploader
- Age-restricted or private videos may not work

## Workflow

1. Run script to extract raw transcript
2. Agent curates: fix obvious transcription errors, add structure, summarize if needed
