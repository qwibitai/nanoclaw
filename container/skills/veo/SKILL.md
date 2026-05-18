---
name: veo
description: Generate, extend, and stitch videos via Google Veo 3.1 (Gemini API).
---

# Veo (Video Generation)

Three scripts. Use them together for longer narratives.

## generate_video.py — Veo 3.1 generation

Basic text-to-video:

```bash
GEMINI_API_KEY="$GEMINI_API_KEY" uv run /app/skills/veo/scripts/generate_video.py \
  --prompt "a single rose blooming at dawn" \
  --filename rose.mp4
```

With reference images (Ingredients to Video — up to 3 refs for character/scene consistency):

```bash
uv run /app/skills/veo/scripts/generate_video.py \
  --prompt "the same fox runs through the snow" \
  --filename fox-snow.mp4 \
  -i fox-front.png -i fox-profile.png
```

First/last-frame interpolation (Veo fills the motion between):

```bash
uv run /app/skills/veo/scripts/generate_video.py \
  --prompt "the rose wilts" \
  --filename wilt.mp4 \
  -i rose-bloom.png \
  --last-frame rose-wilted.png
```

Extend a prior Veo clip (audio continuity, up to 20 extensions / 148s total):

```bash
uv run /app/skills/veo/scripts/generate_video.py \
  --prompt "the fox reaches a frozen lake" \
  --filename fox-lake.mp4 \
  --extend-from "operations/<prior-op-name>" \
  --long
```

Notes:

- Resolutions: `720p` (default), `1080p`, `4k`. 4K requires the standard model, 8s duration.
- Durations: 4, 6, or 8 seconds per call.
- Quality variants: `fast` (default, $0.15/s), `standard` ($0.40/s), `lite` ($0.05/s — no extension, no 4K).
- Cost guardrail: chained extensions need `--long` to opt past the 16s default cap.
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.mp4`.
- The final line of stdout is `MEDIA: <absolute path>` on success — call `send_video` with that path.
- Veo retains generated videos for 2 days on the server; the operation name comes from the script's stderr log on each generation.

## stitch_video.py — ffmpeg concat

Concatenate clips into one MP4:

```bash
uv run /app/skills/veo/scripts/stitch_video.py \
  --input clip1.mp4 --input clip2.mp4 --input clip3.mp4 \
  --filename combined.mp4
```

Overlay a single unified audio track (mitigates Veo's per-clip audio seams):

```bash
uv run /app/skills/veo/scripts/stitch_video.py \
  --input clip1.mp4 --input clip2.mp4 \
  --filename combined.mp4 \
  --audio soundtrack.mp3
```

## extract_frame.py — frame extraction for reference images

Pull a frame from a video so it can be used as a Veo reference image:

```bash
# First frame
uv run /app/skills/veo/scripts/extract_frame.py \
  --input ref-video.mp4 --mode first --filename ref-first.png

# Last frame
uv run /app/skills/veo/scripts/extract_frame.py \
  --input ref-video.mp4 --mode last --filename ref-last.png

# Frame at specific timestamp
uv run /app/skills/veo/scripts/extract_frame.py \
  --input ref-video.mp4 --mode timestamp --timestamp 1.5 --filename mid.png
```

Output line is `FRAME: <absolute path>` (a still, not a deliverable — feed it back into `generate_video.py` via `-i`).

## When to pick which workflow

- **≤8 seconds**: one `generate_video.py` call.
- **8-148 seconds with audio continuity**: chain with `--extend-from` (default-Fast variant only — Lite doesn't extend).
- **>148s, or mixed-character cuts**: multiple independent generations + `stitch_video.py --audio` for a unified soundtrack.
- **Narrative bridge between two scenes**: `--last-frame` interpolation.
- **User uploaded a reference video**: `extract_frame.py` first, then pass the frame to `generate_video.py` via `-i`.
