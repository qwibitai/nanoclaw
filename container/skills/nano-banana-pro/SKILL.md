---
name: nano-banana-pro
description: Generate or edit images via Gemini 3 Pro Image (Nano Banana Pro).
---

# Nano Banana Pro (Gemini 3 Pro Image)

Use the bundled script to generate or edit images.

Generate

```bash
GEMINI_API_KEY="$GEMINI_API_KEY" uv run /app/skills/nano-banana-pro/scripts/generate_image.py --prompt "your image description" --filename "output.png" --resolution 1K
```

Edit (single image)

```bash
GEMINI_API_KEY="$GEMINI_API_KEY" uv run /app/skills/nano-banana-pro/scripts/generate_image.py --prompt "edit instructions" --filename "output.png" -i "/path/in.png" --resolution 2K
```

Multi-image composition (up to 14 images)

```bash
GEMINI_API_KEY="$GEMINI_API_KEY" uv run /app/skills/nano-banana-pro/scripts/generate_image.py --prompt "combine these into one scene" --filename "output.png" -i img1.png -i img2.png -i img3.png
```

Notes

- Resolutions: `1K` (default), `2K`, `4K`.
- Use timestamps in filenames: `yyyy-mm-dd-hh-mm-ss-name.png`.
- Do not read the image back; report the saved path only.
