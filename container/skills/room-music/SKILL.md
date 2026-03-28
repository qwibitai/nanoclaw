---
name: room-music
description: Generate music tracks using the Room Music Gen AI service. Submit generation jobs with genre, mood, lyrics, instruments, and get back audio files. Use when users ask for music creation, song generation, or audio production.
allowed-tools: Bash(curl:*), Bash(cat:*), WebFetch
---

# Music Generation via Room API

Generate AI music tracks using the Room Music Gen service (ACE-Step).
All requests go through `$ROOM_API_URL/music-gen/` — the proxy handles authentication.

## Prerequisites

The `ROOM_API_URL` environment variable must be set (injected automatically by NanoClaw).
Check with: `echo $ROOM_API_URL`

## Submit a Generation Job

```bash
curl -s -X POST "$ROOM_API_URL/music-gen/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Sunset Vibes",
    "genre": "lo-fi",
    "mood": "calm",
    "vocal_type": "no vocal",
    "tempo": "slow",
    "bpm": 80,
    "duration": 60,
    "instruments": ["piano", "soft drums", "vinyl crackle"],
    "texture": ["warm", "vintage", "lo-fi"],
    "prompt": "relaxing lo-fi beat for studying, warm piano chords"
  }'
```

**Response:** `{"job_id": "abc123"}`

## Check Job Status

```bash
curl -s "$ROOM_API_URL/music-gen/jobs/{job_id}"
```

**Response:** `{"status": "completed", "progress": 100}` or `{"status": "processing", "queue_position": 2}`

Possible statuses: `queued`, `processing`, `completed`, `failed`

## Download Audio

```bash
curl -s "$ROOM_API_URL/music-gen/jobs/{job_id}/audio?format=mp3" \
  -H "Accept: audio/mpeg" \
  -o /workspace/group/music-output.mp3
```

## Job Parameters Reference

| Parameter | Type | Description | Examples |
|-----------|------|-------------|----------|
| `title` | string | Track title | "Midnight Rain" |
| `genre` | string | Music genre | pop, rock, electronic, hip-hop, jazz, classical, lo-fi, ambient, synthwave, cinematic, chiptune |
| `mood` | string | Emotional mood | happy, sad, energetic, calm, dark, uplifting, melancholic, epic, dreamy, mysterious |
| `vocal_type` | string | Vocal style | "male vocal", "female vocal", "duet", "no vocal", "a cappella" |
| `tempo` | string | Speed | very-slow, slow, moderate, fast, very-fast |
| `bpm` | number | Exact BPM (60-220) | 120 |
| `key` | string | Musical key | "C major", "A minor", "G major" |
| `duration` | number | Length in seconds | 30, 60, 90, 120, 180 |
| `instruments` | string[] | Instruments to use | ["piano", "guitar", "strings", "synth pad"] |
| `texture` | string[] | Production feel | warm, crisp, bright, dark, airy, punchy, lush, raw, polished, vintage |
| `lyrics` | string | Song lyrics with structure tags | See lyrics format below |
| `prompt` | string | Free-text description | "epic orchestral battle theme" |

## Lyrics Format (ACE-Step)

Use structure tags for best results:

```
[Intro - Solo piano, gentle]

[Verse 1]
Walking through the empty streets at night
City lights reflecting in the rain

[Chorus - Building emotion]
We were infinite we were gold
Now I'm standing in the cold

[Instrumental - Strings swell]

[Chorus - Full power]
We were infinite we were gold

[Outro - Piano only, fading]
```

- Use `[inst]` for purely instrumental tracks
- Keep 6-10 syllables per line for natural pacing
- ACE-Step sings ~2-3 words/second

## Example: Full Workflow

```bash
# 1. Submit job
JOB=$(curl -s -X POST "$ROOM_API_URL/music-gen/jobs" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Battle Theme",
    "genre": "cinematic",
    "mood": "epic",
    "vocal_type": "no vocal",
    "bpm": 140,
    "duration": 90,
    "instruments": ["orchestra", "drums", "brass", "choir"],
    "texture": ["bright", "punchy"],
    "prompt": "epic orchestral battle theme, intense and heroic"
  }')
echo "$JOB"

# 2. Extract job_id
JOB_ID=$(echo "$JOB" | grep -o '"job_id":"[^"]*"' | cut -d'"' -f4)

# 3. Poll status until completed
while true; do
  STATUS=$(curl -s "$ROOM_API_URL/music-gen/jobs/$JOB_ID")
  echo "$STATUS"
  echo "$STATUS" | grep -q '"completed"' && break
  echo "$STATUS" | grep -q '"failed"' && { echo "Job failed"; break; }
  sleep 5
done

# 4. Download audio
curl -s "$ROOM_API_URL/music-gen/jobs/$JOB_ID/audio?format=mp3" \
  -o /workspace/group/battle-theme.mp3
echo "Saved to /workspace/group/battle-theme.mp3"
```

## Tips

- Duration affects cost: 30s is fast, 180s takes longer
- For vocal tracks, always provide lyrics with structure tags
- Use `send_message` tool to notify the user while waiting for generation
- Generated audio files can be shared via `send_message` or saved to the group workspace
