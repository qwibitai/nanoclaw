---
name: youtube
description: Download YouTube videos with yt-dlp, save to attachments, and optionally analyze with Gemini. Use when a user shares a YouTube link or asks you to download/analyze a video.
allowed-tools: Bash(yt-dlp:*), Bash(node:analyze-video)
---

# YouTube Video Download & Analysis

## Quick start

```bash
# Download video to attachments
yt-dlp -f "bv*+ba/b" --merge-output-format mp4 \
  -o "/workspace/group/attachments/%(title)s.%(ext)s" \
  "<url>"

# Analyze with Gemini (if API key is set)
node /home/node/.claude/skills/youtube/analyze-video.mjs \
  "/workspace/group/attachments/Video Title.mp4"
```

## Download workflow

1. **Download the video:**
```bash
yt-dlp -f "bv*+ba/b" --merge-output-format mp4 \
  --no-playlist \
  -o "/workspace/group/attachments/%(title)s.%(ext)s" \
  "<url>"
```

2. **Get the title** (useful for context):
```bash
yt-dlp --print title "<url>"
```

3. **Analyze with Gemini** (optional — requires `GEMINI_API_KEY` in env):
```bash
node /home/node/.claude/skills/youtube/analyze-video.mjs \
  "/workspace/group/attachments/filename.mp4" \
  "optional caption or context"
```

The analysis script prints a description to stdout. If the API key is not set or the file is too large (>20MB for Gemini inline), it prints a fallback message instead.

## Options

- **Audio only:** `yt-dlp -f "ba" -x --audio-format mp3 -o "/workspace/group/attachments/%(title)s.%(ext)s" "<url>"`
- **Subtitles:** `yt-dlp --write-subs --sub-lang en -o "/workspace/group/attachments/%(title)s.%(ext)s" "<url>"`
- **Info only:** `yt-dlp --print title --print duration_string --print filesize_approx "<url>"`

## Error handling

- If download fails, check if the URL is valid and accessible
- If Gemini analysis fails, the script exits cleanly with a fallback message — never blocks the workflow
- For very long videos, consider downloading audio only and transcribing instead
