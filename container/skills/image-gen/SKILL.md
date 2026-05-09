---
name: image-gen
description: Generate images with OpenAI's gpt-image models. Use when the user asks you to create, draw, make, design, or generate a picture, image, illustration, logo, diagram, or artwork. Saves the result to the group workspace and delivers it via send_file.
---

# Image Generation

Generate images using OpenAI's gpt-image model family. The result is saved
to the group's workspace as a PNG and then sent to the user as a file
attachment.

## When to use

- The user asks for an image, picture, drawing, illustration, logo, or
  diagram ("make me a picture of…", "draw a…", "generate a logo for…").
- The user wants you to visualize something ("show me what that looks
  like").

Do NOT use this for image *editing* of an uploaded photo — this skill only
does text-to-image generation.

## How to run

Call the generator with Bash:

```bash
node /home/node/.claude/skills/image-gen/generate.js \
  --prompt "a watercolor of a koala drinking coffee" \
  --model gpt-image-2 \
  --size 1024x1024 \
  --output /workspace/group/generated/koala.png
```

The script prints the output path to stdout on success. On failure it
exits non-zero and writes the error to stderr (typically an OpenAI API
message).

### Parameters

- `--prompt` (required) — text description of the image.
- `--model` (default `gpt-image-2`) — pick one:
  - `gpt-image-2` — highest quality, default. **Requires a verified OpenAI
    organization.** If you see a "must be verified" error, fall back to
    `gpt-image-1.5` and tell the user they can verify at
    platform.openai.com/settings/organization/general.
  - `gpt-image-1.5` — fast and broadly available, good fallback.
  - `gpt-image-1` — previous generation, still capable.
  - `gpt-image-1-mini` — fastest, cheapest.
  - `dall-e-3` — legacy, only if the user asks for it by name.
- `--size` (default `1024x1024`) — `1024x1024`, `1792x1024` (landscape),
  or `1024x1792` (portrait).
- `--output` (required) — absolute path where the PNG should be saved.
  Put files under `/workspace/group/generated/` so the group stays tidy.

## Delivering the image

After the script succeeds, send the file with the `send_file` MCP tool:

```
mcp__nanoclaw__send_file({
  file_path: "/workspace/group/generated/koala.png",
  caption: "Your watercolor koala"
})
```

Include a short caption that references what was requested so the user
has context alongside the image.

## Model selection guidance

- Default to `gpt-image-2` unless the user has indicated a preference.
- If `gpt-image-2` returns a verification error, retry with
  `gpt-image-1.5` and note the fallback in your reply.
- If the user says "cheaper", "faster", or "just a draft", use
  `gpt-image-1-mini`.
- If the user specifies a model by name, respect their choice.

## Filename conventions

- Directory: `/workspace/group/generated/` (create if missing — the
  script handles this).
- Name: short slug of what was asked, e.g. `koala.png`,
  `sales-pipeline-dashboard.png`.
- If the user asks for multiple variants in one request, suffix with an
  index: `koala-1.png`, `koala-2.png`.

## Troubleshooting

- **Verification error** — expected for `gpt-image-2` on unverified orgs.
  Fall back to `gpt-image-1.5` and tell the user what to do.
- **No image data in response** — the model sometimes refuses prompts on
  content-policy grounds. Re-read the error text; if it's a policy refusal,
  tell the user plainly rather than retrying blindly.
- **OPENAI_API_KEY not set** — the container env is missing the key. This
  is a configuration issue for the user to resolve.
