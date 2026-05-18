---
title: "feat: Edna video generation and stitching via Veo 3.1"
type: feat
status: active
created: 2026-05-17
---

# feat: Edna video generation and stitching via Veo 3.1

## Summary

Add a `veo` container skill that lets Edna generate videos via Google's Veo 3.1 (Gemini API), stitch clips together with `ffmpeg`, and use reference videos by extracting frames as image references. Outbound video flows through a new `sendVideo` channel method mirroring the just-landed Slack image plumbing — Slack-first, other channels deferred.

---

## Problem Frame

Edna has image generation today (the `nano-banana-pro` container skill produces images via Gemini 3 Pro Image, and outbound image upload to Slack just landed). She has no equivalent for video. Users want her to generate short videos from text prompts and image references — and stitch multiple clips into longer sequences — without leaving the chat. Google's Veo 3.1 is the natural pairing: same SDK (`google-genai`), same `GEMINI_API_KEY`, same async-operation polling shape, and Slack's `files.uploadV2` accepts video uploads without channel changes.

Two constraints shape the implementation:

1. **Veo can't ingest arbitrary video as input.** Image references work (up to 3); video references must be reduced to frames first. The native `extend` feature only works on Veo-generated clips. So user-supplied reference videos route through a frame-extraction helper.
2. **Audio seams.** Each Veo clip ships with its own independently generated audio track. When stitching independent clips with `ffmpeg`, audio shifts at every cut. The native `extend` feature partially mitigates this (it conditions on the prior clip's last second), but stitching needs a unified post-audio overlay path to fully solve seams.

---

## Requirements

- **R1.** Edna can generate a Veo 3.1 video from a text prompt, optionally with up to 3 image references.
- **R2.** Edna can chain video generations using Veo's native `extend` feature (up to 148s total, ≤20 extensions).
- **R3.** Edna can do first/last-frame interpolation by passing start and end images.
- **R4.** Edna can stitch independent video clips together with `ffmpeg`, optionally overlaying a single unified audio track.
- **R5.** Edna can extract frames (first, last, or keyframe-by-timestamp) from a reference video to use as image references for a new generation.
- **R6.** The orchestrator delivers generated videos back to the originating Slack channel.
- **R7.** Default model variant is Veo 3.1 Fast; users may opt into Standard or Lite via flag.
- **R8.** Default per-call duration is capped at 16s; longer renders require an explicit `--long` flag.
- **R9.** Authorization and path-escape checks for outbound video match the existing image flow.
- **R10.** Edna's `groups/main/CLAUDE.md` documents when to pick `extend` vs `ffmpeg` concat vs first/last-frame.

---

## Key Technical Decisions

- **Engine.** Veo 3.1 via the Gemini API using the existing `google-genai` Python SDK, same `GEMINI_API_KEY` env path already proven by `nano-banana-pro`. Vertex AI variant is out of scope.
- **Skill shape.** New container skill at `container/skills/veo/` mirroring `nano-banana-pro/`: one `SKILL.md` plus a `scripts/` directory with self-contained Python scripts using `uv` inline dependencies. Each script is independently invocable so Edna composes them.
- **Three scripts, not one.** Generation, stitching, and frame extraction are separate concerns with different dependencies (`google-genai` vs `ffmpeg`). Keeping them split makes failures localized and tests focused. They share no state — Edna passes file paths between them.
- **Async polling inside the script.** Veo is long-poll (operations API); the Python script blocks on poll until completion or timeout, prints progress lines (parsed as agent stdout), and emits the final `MEDIA:` token. This avoids needing orchestrator-side job tracking — the script is the unit of async work, matching how `nano-banana-pro` handles slow image generations.
- **Outbound channel parity with images.** Add `sendVideo` as an optional method on the `Channel` interface (matching how `sendImage` is optional). Add a `videos/` IPC namespace and `processVideoIpcFile` helper. Add `routeOutboundVideo` to the router. Slack implements `sendVideo` via the same `files.uploadV2` already used for images — Slack auto-detects video mime type and renders inline.
- **MCP tool surface.** Add `send_video` to the agent-runner's MCP server (`container/agent-runner/src/ipc-mcp-stdio.ts`) mirroring `send_image`. Edna calls this after the generation script emits a path.
- **Container additions.** Add `ffmpeg` to `container/Dockerfile` apt-get install list — needed for both stitching and frame extraction. Adds ~100MB to the image; acceptable.
- **Cost guardrail at the CLI boundary.** The 16s default cap lives in `generate_video.py`'s argparse layer, not in Edna's prompt context — defense-in-depth means a model that ignores the prompt instruction still can't blow the budget without an explicit `--long` flag.
- **Default `--quality fast`.** Veo 3.1 Fast at $0.15/s vs Standard at $0.40/s is a 2.7× cost reduction for visible-but-acceptable quality loss. Standard remains opt-in for hero outputs.

---

## System-Wide Impact

| Surface | Change |
|---|---|
| `container/Dockerfile` | Adds `ffmpeg` to apt-get install list — affects every container build |
| `container/skills/veo/` | New skill — loaded by every agent container at startup |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | New `send_video` MCP tool — visible to every agent |
| `src/types.ts` | Adds optional `sendVideo` to `Channel` interface — every channel implementation sees it; only Slack implements |
| `src/router.ts` | New `routeOutboundVideo` — orchestrator wiring |
| `src/ipc.ts` | New `videos/` IPC namespace + `processVideoIpcFile` — IPC watcher reads one more directory per group |
| `src/channels/slack.ts` | Implements `sendVideo` via `files.uploadV2` |
| `groups/main/CLAUDE.md` | Adds Edna's strategy guidance (extend vs concat vs interpolation) |

Stakeholders:
- **End user (Edna's Boss).** Gains video generation in chat.
- **Edna.** New capability surface; needs CLAUDE.md guidance to pick the right stitching strategy.
- **Ops/cost.** Default guardrails keep per-call cost ≤$2.40 (16s @ Fast 1080p); explicit `--long` opts into higher spend.

---

## Implementation Units

### U1. Add ffmpeg to container Dockerfile

**Goal:** Make `ffmpeg` available inside agent containers so stitching and frame-extraction scripts can run.

**Requirements:** R4, R5

**Dependencies:** none

**Files:**
- `container/Dockerfile`

**Approach:** Append `ffmpeg` to the existing apt-get install list (the block that already installs Chromium and fonts). Single-line change; preserves the existing `--no-install-recommends` discipline if present, or matches the existing block's flags.

**Patterns to follow:** The existing apt-get install block at `container/Dockerfile` lines 7-29.

**Test scenarios:**
- Test expectation: none — pure container infra. Validation is the build success in U3/U4 (scripts that use ffmpeg) and the smoke test in U7.

**Verification:** `./container/build.sh` completes without error and `ffmpeg -version` resolves inside a built container.

---

### U2. Create `veo` skill scaffold and `generate_video.py`

**Goal:** Ship the core Veo 3.1 generation script — text-to-video, image-references (up to 3), first/last-frame interpolation, native `extend`, and operations polling.

**Requirements:** R1, R2, R3, R7, R8

**Dependencies:** none (parallel with U1)

**Files:**
- `container/skills/veo/SKILL.md` (new)
- `container/skills/veo/scripts/generate_video.py` (new)
- `container/skills/veo/scripts/__init__.py` (new, empty — keeps the scripts directory consistent with potential test imports)

**Approach:**
- `SKILL.md` mirrors `container/skills/nano-banana-pro/SKILL.md` in shape: name, description, three invocation examples (basic generate, image-ref, extend), and notes on filename timestamping and the `MEDIA:` token.
- `generate_video.py` uses `uv` inline script metadata for `google-genai>=1.0.0` and `pillow>=10.0.0`.
- Argparse surface: `--prompt`, `--filename`, `--input-image` (repeatable, max 3), `--last-frame` (single path), `--duration {4,6,8}`, `--resolution {720p,1080p,4K}`, `--quality {standard,fast,lite}` (default `fast`), `--extend-from <prior-operation-id>`, `--long` (flag), `--api-key`.
- Cost guardrail: if `--duration > 16` (i.e. caller asks for chained durations) or `--extend-from` is set without `--long`, reject with a clear error citing the override flag. Per-call Veo durations max at 8, so the cap matters for chained `extend` flows; first call alone is always ≤8.
- Model ID mapping: `fast → veo-3.1-fast-generate-preview`, `standard → veo-3.1-generate-preview`, `lite → veo-3.1-lite-generate-preview`.
- Polling: call `client.models.generate_videos(...)`, then loop on the returned operation polling its status; print one `Polling... (Ns elapsed)` line every ~10s for visible progress.
- Output: write MP4 to `--filename`, then emit `MEDIA: <absolute path>` as the final stdout line (same convention as `nano-banana-pro/scripts/generate_image.py:173`).
- Image references and `--last-frame` are mutually compatible: refs seed the generation, last-frame caps it (first/last interpolation mode). Validate counts.
- `--extend-from` takes a prior operation handle (Veo retains generated videos 2 days); pass it through the SDK's `video=` parameter on `generate_videos`.

**Execution note:** New domain behavior — implement with test scaffolding for argparse validation, then add a real Veo call only via an integration test gated by `GEMINI_API_KEY` (skip if unset).

**Patterns to follow:**
- `container/skills/nano-banana-pro/scripts/generate_image.py` — uv script header, argparse shape, `MEDIA:` token emission, error handling structure
- `container/skills/nano-banana-pro/SKILL.md` — skill markdown shape (frontmatter, sections, examples)

**Test scenarios:**
- **Happy path:** `--prompt "..." --filename out.mp4` returns a file at the expected path and final stdout line begins with `MEDIA: `.
- **Image refs:** Passing 3 `--input-image` paths is accepted; passing 4 fails with a clear error.
- **Duration cap:** Default invocation with no `--long` accepts `--duration 8`; chained `--extend-from` without `--long` is rejected with a message naming the `--long` flag.
- **Quality mapping:** Each of `fast`/`standard`/`lite` resolves to the correct Veo model ID (assert via mocked client capturing the call args).
- **Last-frame mode:** `--last-frame` path is passed to the SDK's interpolation field; missing file produces a clean error before any API call.
- **Polling output:** Stdout includes at least one `Polling...` progress line during a simulated slow operation.
- **Failure path:** A simulated SDK error surfaces a non-zero exit code and a clear stderr message; no `MEDIA:` token is emitted on failure.
- **No API key:** Missing `GEMINI_API_KEY` and no `--api-key` exits 1 with a message naming both options (mirrors `generate_image.py:68-73`).

**Verification:** Argparse unit tests pass under `uv run`. A live integration test against the Veo API (gated by env) produces a playable MP4 and the `MEDIA:` token.

---

### U3. `stitch_video.py` — ffmpeg concat with optional unified audio overlay

**Goal:** Concatenate multiple MP4 clips into one video using ffmpeg's concat demuxer; optionally strip per-clip audio and overlay a single unified audio track to eliminate audio seams.

**Requirements:** R4

**Dependencies:** U1 (needs ffmpeg in the container)

**Files:**
- `container/skills/veo/scripts/stitch_video.py` (new)
- `container/skills/veo/scripts/test_stitch_video.py` (new — pytest-compatible, runs via `uv run pytest`)

**Approach:**
- Argparse: `--input` (repeatable, ≥2), `--filename` (output path), `--audio <path>` (optional unified audio track; when set, per-clip audio is stripped and the unified track is overlaid), `--api-key` not needed (no external API).
- Implementation: write a temp file with `file '<absolute path>'` lines, invoke `ffmpeg -f concat -safe 0 -i <list> -c copy <out>` for the no-audio-overlay case; switch to a `-c:v copy -c:a aac -i <audio>` form (or `-an` strip then overlay) when `--audio` is set.
- Validate all inputs exist and are MP4 before invoking ffmpeg; surface ffmpeg stderr on failure with the exact command that ran.
- Emit `MEDIA: <absolute path>` as the final stdout line on success.

**Patterns to follow:**
- `container/skills/nano-banana-pro/scripts/generate_image.py` — argparse + `MEDIA:` token pattern
- ffmpeg concat demuxer documentation (standard pattern; no codebase precedent yet)

**Test scenarios:**
- **Happy path (concat only):** Two short test MP4 fixtures concatenate into one file with the combined duration (±0.1s tolerance).
- **Happy path (audio overlay):** Two clips + an audio track produce an output whose audio matches the unified track length and whose video matches the combined visual length.
- **Audio shorter than video:** Unified audio shorter than video length results in either silence-padding or audio-loop (decide and document) — assert the chosen behavior.
- **Audio longer than video:** Unified audio longer than video is truncated to video length.
- **Single input:** Passing one `--input` is rejected with a message saying ≥2 is required.
- **Missing input:** A non-existent input path fails before invoking ffmpeg with a clean error.
- **Non-MP4 input:** Passing a `.mov` (or any non-MP4) fails with a clean error naming the offending path.
- **ffmpeg failure:** A simulated ffmpeg non-zero exit surfaces the command and stderr; no `MEDIA:` token on failure.

**Verification:** Pytest unit tests pass under `uv run pytest container/skills/veo/scripts/test_stitch_video.py`. Manual run with two real Veo outputs produces a playable concatenation.

---

### U4. `extract_frame.py` — pull image references from a reference video

**Goal:** Extract the first frame, last frame, or a frame at a specific timestamp from a reference video, so user-supplied videos can be used as image references for Veo generation.

**Requirements:** R5

**Dependencies:** U1 (needs ffmpeg)

**Files:**
- `container/skills/veo/scripts/extract_frame.py` (new)
- `container/skills/veo/scripts/test_extract_frame.py` (new)

**Approach:**
- Argparse: `--input <video>`, `--filename <output.png>`, `--mode {first,last,timestamp}`, `--timestamp <seconds>` (required when mode=timestamp).
- Implementation: invoke `ffmpeg -i <video> -vf "select=eq(n\,0)" -vframes 1 <out.png>` for first frame; `ffmpeg -sseof -0.1 -i <video> -vframes 1 <out.png>` for last frame; `ffmpeg -ss <ts> -i <video> -vframes 1 <out.png>` for timestamp.
- Validate input exists and ffprobe says it's a video.
- Emit `FRAME: <absolute path>` (distinct from `MEDIA:` since this is a still image meant to feed back into Veo, not a deliverable).

**Patterns to follow:**
- ffmpeg single-frame extraction documented patterns
- `nano-banana-pro` argparse shape

**Test scenarios:**
- **First-frame extraction:** A test video produces a PNG that visually matches frame 0.
- **Last-frame extraction:** A test video produces a PNG matching the final frame.
- **Timestamp extraction:** Extracting at t=1.0 on a 2-second test video produces the expected mid-clip frame.
- **Timestamp out of range:** Requesting t=10 on a 2-second video fails with a clean error.
- **Missing input:** A nonexistent input fails before any ffmpeg call.
- **Non-video input:** Passing a PNG or audio file is rejected after ffprobe inspection.

**Verification:** Pytest unit tests pass. Manual: extracting the last frame from a Veo clip and passing it as `--input-image` to `generate_video.py` produces a visually continuous follow-on clip.

---

### U5. Add `sendVideo` to Channel interface and Slack implementation

**Goal:** Extend the channel abstraction with an optional `sendVideo` method and implement it on Slack via `files.uploadV2` (the same API already used for images).

**Requirements:** R6, R9

**Dependencies:** none (parallel with U1-U4)

**Files:**
- `src/types.ts` (modify — add `sendVideo?` to `Channel` interface)
- `src/channels/slack.ts` (modify — implement `sendVideo`, queue when disconnected)
- `src/channels/slack.test.ts` (modify — add `sendVideo` test coverage)

**Approach:**
- Add `sendVideo?(jid: string, videoPaths: string[], caption?: string): Promise<void>` to `Channel` in `src/types.ts` (matches the existing `sendImage?` shape).
- Slack implementation mirrors `sendImage` (`src/channels/slack.ts:260-283`): `files.uploadV2` accepts video files natively via `file_uploads`. Slack auto-detects the mime type from the filename; ensure paths end in `.mp4` (validation lives upstream in the IPC watcher).
- Outgoing queue: extend the existing `outgoingQueue` discriminated union with a `'video'` kind (`{ kind: 'video', jid, videoPaths, caption }`) and handle it in the existing reconnect-drain logic.
- OAuth scope: the existing `files:write` scope already covers video uploads. No new scope required; document this in the SKILL.md note.

**Patterns to follow:**
- `src/channels/slack.ts:260-283` — `sendImage` implementation
- `src/types.ts:104-109` — existing `sendImage?` optional method shape

**Test scenarios:**
- **Happy path:** `sendVideo` with one path calls `files.uploadV2` with the expected `channel_id`, `initial_comment`, and `file_uploads` shape.
- **Multiple paths:** Passing 3 video paths produces a single `files.uploadV2` call with 3 entries in `file_uploads` (matches image album behavior).
- **Disconnected queueing:** Calling `sendVideo` while disconnected pushes `{ kind: 'video', ... }` onto `outgoingQueue` and does not throw; subsequent reconnect drains and uploads.
- **Caption omitted:** `sendVideo` without caption omits `initial_comment` cleanly.
- **Integration:** Existing `slack.test.ts` queue-drain test extended to cover the new video kind.

**Verification:** `npm test` passes including the new Slack video tests. Manual smoke: a `.mp4` placed in a registered group's workspace is uploaded to the linked Slack channel via direct test invocation.

---

### U6. Orchestrator wiring — `routeOutboundVideo`, IPC namespace, MCP tool

**Goal:** Wire the outbound video path end-to-end from the agent-side MCP tool through the IPC watcher to the channel's `sendVideo`.

**Requirements:** R6, R9

**Dependencies:** U5 (needs Channel.sendVideo)

**Files:**
- `src/router.ts` (modify — add `routeOutboundVideo`)
- `src/ipc.ts` (modify — add `videos/` directory processing, `processVideoIpcFile` helper, update `IpcDeps` to include `sendVideo`)
- `src/ipc.test.ts` (modify — add video IPC tests mirroring image tests)
- `container/agent-runner/src/ipc-mcp-stdio.ts` (modify — add `send_video` MCP tool)
- `src/index.ts` (modify — pass `routeOutboundVideo` to `startIpcWatcher` as `sendVideo`)

**Approach:**
- `routeOutboundVideo` in `src/router.ts` mirrors `routeOutboundImage` (`src/router.ts:54-68`): find channel, check `sendVideo` exists, call it; fall back to text message with caption when channel doesn't support video.
- IPC watcher: extend `processIpcFiles` in `src/ipc.ts` to also scan `<sourceGroup>/videos/`, mirroring the image block (`src/ipc.ts:150-192`). Reuse the same `.json` filename convention; skip `.ack.json` companions.
- `processVideoIpcFile`: copy `processImageIpcFile` (`src/ipc.ts:524-588`) — same authorization (isMain OR same group), same path-escape check against `groupRoot`, same `.mp4` extension validation, same ack-on-error.
- New `VideoIpcPayload` interface in `src/ipc.ts` matching `ImageIpcPayload`.
- MCP tool: add `send_video` to `container/agent-runner/src/ipc-mcp-stdio.ts` mirroring `send_image` (`container/agent-runner/src/ipc-mcp-stdio.ts:93-137`). Writes IPC file to a new `VIDEOS_DIR` constant. Path validation: enforce `.mp4` extension on top of the existing workspace-root check.
- `IpcDeps` in `src/ipc.ts:13-27` gains `sendVideo: (jid: string, paths: string[], caption?: string) => Promise<void>`.
- `src/index.ts` wires `routeOutboundVideo(channels, ...)` into the `startIpcWatcher` deps bundle.

**Execution note:** Start with an integration test that drops a JSON payload into a test `videos/` directory and asserts the channel's `sendVideo` is called with the expected absolute paths — this proves the full IPC→router→channel flow before touching the MCP tool.

**Patterns to follow:**
- `src/router.ts:54-68` — `routeOutboundImage`
- `src/ipc.ts:150-192` — image IPC scan block
- `src/ipc.ts:524-588` — `processImageIpcFile` (authorization, path escape, ack)
- `container/agent-runner/src/ipc-mcp-stdio.ts:93-137` — `send_image` MCP tool

**Test scenarios:**
- **Happy path (router):** `routeOutboundVideo` with a connected Slack channel calls `channel.sendVideo` with the expected jid, paths, caption.
- **Channel without sendVideo:** Falls back to `sendMessage(jid, caption ?? '[video]')` — mirrors the image fallback (`src/router.ts:66-67`).
- **No channel for JID:** Throws `No channel for JID: <jid>` — mirrors image behavior.
- **IPC authorization:** A non-main group's video payload targeting another group's chatJid is rejected with a warn log; no `sendVideo` call.
- **IPC path escape:** A payload with a `../` path is dropped with a warn log; remaining valid paths in the same payload still process.
- **IPC missing file:** A payload referencing a path that doesn't exist on disk is skipped with a warn log; no `sendVideo` call for that path.
- **MCP send_video — basic:** Calling `send_video` with a single `.mp4` path writes a JSON file to `VIDEOS_DIR` with `type: 'video'`, `chatJid`, `paths`, `caption`.
- **MCP send_video — non-mp4 rejection:** Calling `send_video` with a `.png` path returns an `isError: true` response and writes no IPC file.
- **MCP send_video — workspace escape:** Calling `send_video` with `/etc/passwd` returns an error before writing any file (same validation as `send_image`).
- **MCP send_video — array:** Passing an array of up to 10 paths writes a single IPC file with all paths.

**Verification:** `npm test` passes including new IPC and router tests. Manual end-to-end: Edna calls `send_video` from inside a container, the IPC file appears, the watcher picks it up, Slack receives the video.

---

### U7. Edna's strategy guidance in `groups/main/CLAUDE.md`

**Goal:** Teach Edna when to pick `extend` vs `ffmpeg` concat vs first/last-frame interpolation, and how to handle reference videos.

**Requirements:** R10

**Dependencies:** U2, U3, U4, U6 (all the user-visible scripts must exist before documenting them)

**Files:**
- `groups/main/CLAUDE.md` (modify — append a new section)

**Approach:**
Add a "Video Generation" section after the existing "What You Can Do" block. Cover:

- The three scripts and what each does (one-liner each).
- Decision tree: ≤8s → `generate_video.py` alone; ≤148s with audio continuity → `generate_video.py` then `--extend-from`; >148s or mixed-character cuts → multiple independent generations + `stitch_video.py` with `--audio` for unified soundtrack; narrative bridges → `--last-frame` interpolation.
- Reference video handling: extract first/last/keyframe with `extract_frame.py`, then pass as `--input-image` to `generate_video.py`.
- Cost guardrails: default `--quality fast`, default ≤16s; explicit `--long` for chained renders.
- Delivery: after the script prints `MEDIA: <path>`, call the `send_video` MCP tool with that path.

**Patterns to follow:**
- `groups/main/CLAUDE.md` existing structure (read at session start, points to `soul.md`, lists capabilities in bullet form).
- The image flow Edna already knows — keep the prose tone consistent (Edna persona).

**Test scenarios:**
- Test expectation: none — prose documentation. Validation is the smoke test in U7's verification.

**Verification:** Edna receives a sample request ("make me a 20-second video of a cat walking through Paris with a continuous soundtrack") and chooses `generate_video.py` + `--extend-from` (since 20s < 148s and audio continuity matters). Recorded by manually testing in a dev container.

---

## Scope Boundaries

**In scope:** R1-R10 above. Slack-only outbound video. Veo 3.1 Fast/Standard/Lite. ffmpeg concat with optional unified audio. Frame extraction (first/last/timestamp).

**Out of scope:**
- Gemini Omni (not yet public via API)
- Music generation, TTS, audio-only generation
- Real-time / streaming video
- NLE features beyond frame extraction (trim, transcode, crop, color grade)
- Vertex AI path (Gemini API only)
- Persistent video gallery / management UI
- Inbound video understanding (Edna analyzing user-sent videos beyond frame extraction)

### Deferred to Follow-Up Work

- **WhatsApp video output.** Add `sendVideo` to the WhatsApp channel after Slack proves out. Same `MEDIA:` token, same IPC path; only the channel implementation differs.
- **Telegram video output.** Same shape as WhatsApp — separate follow-up.
- **Video reference via Veo's native operation handle.** If a user references an earlier Edna-generated clip (Veo retains operation handles for 2 days), wire `--extend-from` to accept the handle directly instead of requiring frame extraction. Needs a small handle-store in the group workspace.
- **Cost telemetry.** Log per-call duration × quality so ops can see spend per group. Not blocking initial ship.

---

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Veo 3.1 API rate limits surprise heavy users | Medium | Medium | Default `--quality fast`; surface SDK rate-limit errors clearly so Edna can back off |
| ffmpeg in container bloats image size | High | Low | Acceptable (~100MB); document in container README |
| Audio seams remain audible despite `extend` continuity | Medium | Medium | Document the `--audio` unified-track workflow; surface it as Edna's default for >1 clip |
| User passes a non-Veo video to `--extend-from` and Veo rejects it | Medium | Low | Validate up-front: `--extend-from` accepts an operation ID, not a file path; clean error if the ID isn't a valid handle |
| Slack upload fails silently when `files:write` scope missing | Low | High | Existing `checkRequiredScopes` at `src/channels/slack.ts:343-359` already covers this; no new scope needed |
| Long-running Veo poll exceeds container timeout (default 5min in `ContainerConfig.timeout`) | Medium | Medium | A 60s+ Veo render can blow the container budget; document that longer renders need explicit `containerConfig.timeout` bump or background scheduling |
| Cost overrun if Edna chains many `extend` calls in one session | Medium | High | `--long` flag is the choke point; cost guardrail at the CLI not the prompt means a runaway agent still can't exceed budget per call |

---

## Deferred Implementation Notes

- Exact Veo SDK call shape for `--extend-from` — depends on the `google-genai` version installed at implementation time. The SDK accepts a `video=` parameter referencing the prior operation; final API call is verified in U2.
- Exact ffmpeg flag for "strip per-clip audio + overlay unified track" — depends on whether `-c:v copy` works across the codec/resolution mix Veo produces. May need re-encode (`-c:v libx264 -crf 18`) for safety; verified in U3.
- Whether Veo's `last_frame` interpolation requires the start/end images to be at matching resolutions — verified empirically in U2 testing.
- Whether `files.uploadV2` returns a usable share URL we could log for Edna's reference — not blocking; verified in U5.

---

## Verification Plan

1. **Unit & integration tests** — `npm test` (TypeScript) and `uv run pytest container/skills/veo/scripts/test_*.py` (Python) both green.
2. **Container build** — `./container/build.sh` succeeds with ffmpeg present.
3. **End-to-end smoke (manual)** — In a dev container:
   - `generate_video.py --prompt "a single rose blooming" --filename rose.mp4` produces a playable 4-8s MP4.
   - `extract_frame.py --input rose.mp4 --mode last --filename rose-last.png` produces a valid PNG.
   - `generate_video.py --prompt "the rose wilts" --filename wilt.mp4 --input-image rose-last.png` produces a continuous follow-on clip.
   - `stitch_video.py --input rose.mp4 --input wilt.mp4 --filename combined.mp4` produces a concatenation.
   - `send_video combined.mp4` delivers the file to the configured Slack test channel.
4. **Cost guardrail check** — `generate_video.py --extend-from <id>` without `--long` exits with the expected error.

---

## Dependencies / Prerequisites

- Existing: `GEMINI_API_KEY` is already provisioned in container env (used by `nano-banana-pro`).
- Existing: Slack `files:write` scope (already required for image uploads).
- New: `ffmpeg` apt package in container (added in U1).
- New: `google-genai` SDK with Veo 3.1 model support — the existing `nano-banana-pro` script depends on `google-genai>=1.0.0` which already includes Veo support.
