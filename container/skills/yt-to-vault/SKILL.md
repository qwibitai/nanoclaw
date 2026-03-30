# YouTube Skill

This is the ONLY skill for handling YouTube URLs. When a message contains a YouTube URL (youtube.com, youtu.be), follow this pipeline exactly.

## Critical constraints

- Do NOT open a browser or use computer use / screen automation.
- Do NOT ask the user to paste a transcript. The script fetches it automatically.
- Do NOT output the transcript, summary, or action items to the chat. ALL synthesized content goes into the file only.
- Your ONLY chat messages are: (1) a short acknowledgment, then (2) a one-line result.

## Step 1 — Acknowledge

Immediately send: "Processing transcript..."

## Step 2 — Fetch transcript

```bash
python3 /home/node/.claude/skills/yt-to-vault/transcript.py '<URL>'
```

Capture stdout as the raw transcript. If this fails, send an error message and stop.

## Step 3 — Synthesize (do NOT output this to chat)

From the transcript, produce:

- **Executive Summary**: 2-3 sentences. Core argument or demonstration.
- **Action Items**: Up to 3 concrete, specific next steps. Omit if purely informational.

Do not pad. If fewer than 3 genuine action items exist, list fewer.

## Step 4 — Write file

Write the synthesis to: `/workspace/extra/5_AI/YT - <Video Title> - Synthesis.md`

Use this template:

```markdown
---
source: <YouTube URL>
date: <YYYY-MM-DD>
tags: [youtube, synthesis]
---

# <Video Title>

## Executive Summary
<2-3 sentence summary>

## Action Items
- <item 1>
- <item 2>
- <item 3>
```

Use today's date. Use the video's actual title from the transcript output header.
If the video title can't be determined, use the video ID in the filename.

## Step 5 — Confirm

Send exactly one message: "Saved: YT - <Video Title> - Synthesis.md"

If the file write failed, send: "Error: could not write synthesis file" with the reason.

## YouTube search

If the user asks to search YouTube (not a URL, but a search query), use:

```bash
python3 /home/node/.claude/skills/yt-to-vault/search.py <query> [--count N] [--months N] [--no-date-filter]
```
