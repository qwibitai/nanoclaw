#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "google-genai>=1.0.0",
# ]
# ///
"""
Generate videos using Google's Veo 3.1 (Gemini API).

Modes:
    Text-to-video:
        uv run generate_video.py --prompt "..." --filename out.mp4

    Reference images (up to 3 — Ingredients to Video):
        uv run generate_video.py --prompt "..." --filename out.mp4 -i a.png -i b.png

    First/last-frame interpolation:
        uv run generate_video.py --prompt "..." --filename out.mp4 \\
            -i first.png --last-frame last.png

    Extend a prior Veo clip:
        uv run generate_video.py --prompt "..." --filename out.mp4 \\
            --extend-from operations/<name> --long
"""

from __future__ import annotations

import argparse
import mimetypes
import os
import sys
import time
from pathlib import Path

DEFAULT_DURATION_CAP_SECONDS = 16
POLL_INTERVAL_SECONDS = 10
MAX_POLL_SECONDS_DEFAULT = 600  # 10 minutes — Veo standard renders typically <5min

QUALITY_TO_MODEL = {
    "fast": "veo-3.1-fast-generate-preview",
    "standard": "veo-3.1-generate-preview",
    "lite": "veo-3.1-lite-generate-preview",
}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate videos via Google Veo 3.1 (Gemini API)."
    )
    parser.add_argument("--prompt", "-p", required=True, help="Text prompt for the video.")
    parser.add_argument(
        "--filename",
        "-f",
        required=True,
        help="Output MP4 path. Created if its parent directory exists.",
    )
    parser.add_argument(
        "--input-image",
        "-i",
        action="append",
        dest="input_images",
        metavar="IMAGE",
        help=(
            "Reference image path. Repeat up to 3 times for Ingredients to Video. "
            "When used with --last-frame, exactly 1 input-image is required (first/last "
            "interpolation mode)."
        ),
    )
    parser.add_argument(
        "--last-frame",
        dest="last_frame",
        metavar="IMAGE",
        help="End-frame image for first/last-frame interpolation. Requires exactly 1 --input-image.",
    )
    parser.add_argument(
        "--duration",
        type=int,
        choices=[4, 6, 8],
        default=8,
        help="Clip duration in seconds. Default: 8.",
    )
    parser.add_argument(
        "--resolution",
        choices=["720p", "1080p", "4k"],
        default="720p",
        help="Output resolution. 4K requires --quality standard and --duration 8.",
    )
    parser.add_argument(
        "--quality",
        choices=list(QUALITY_TO_MODEL.keys()),
        default="fast",
        help="Model variant. Default: fast.",
    )
    parser.add_argument(
        "--aspect-ratio",
        dest="aspect_ratio",
        choices=["16:9", "9:16"],
        default="16:9",
        help="Aspect ratio. Default: 16:9.",
    )
    parser.add_argument(
        "--extend-from",
        dest="extend_from",
        metavar="OPERATION_NAME",
        help=(
            "Operation name of a prior Veo generation (e.g., 'operations/abc123'). Re-fetches "
            "that operation's video and conditions this generation on it. Not supported with "
            "--quality lite. Implicit duration is +7s per extension, so requires --long."
        ),
    )
    parser.add_argument(
        "--long",
        action="store_true",
        help=(
            f"Opt past the {DEFAULT_DURATION_CAP_SECONDS}s default cap. Required when --extend-from "
            "is set."
        ),
    )
    parser.add_argument(
        "--api-key",
        "-k",
        help="Gemini API key. Defaults to GEMINI_API_KEY env var.",
    )
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=POLL_INTERVAL_SECONDS,
        help="Seconds between polls. Default: %(default)s.",
    )
    parser.add_argument(
        "--max-poll-seconds",
        type=float,
        default=MAX_POLL_SECONDS_DEFAULT,
        help=(
            "Hard cap on total polling time. The operation aborts and exits 1 "
            "if Veo has not completed by this point. Default: %(default)ss."
        ),
    )
    return parser


def get_api_key(provided: str | None) -> str | None:
    if provided:
        return provided
    return os.environ.get("GEMINI_API_KEY")


def validate_args(args: argparse.Namespace) -> tuple[bool, str | None]:
    """Validate flag combinations. Returns (ok, error_message)."""
    images = args.input_images or []

    if len(images) > 3:
        return False, f"Too many --input-image entries ({len(images)}); maximum is 3."

    if args.last_frame:
        if len(images) != 1:
            return (
                False,
                "--last-frame requires exactly 1 --input-image (first/last interpolation mode).",
            )

    # Cost guardrail. Chained extension implies total duration > one call's 8s, so require --long.
    if args.extend_from and not args.long:
        return (
            False,
            "--extend-from chains durations past the "
            f"{DEFAULT_DURATION_CAP_SECONDS}s default cap. Re-run with --long to opt in.",
        )

    # --long lets the script know the user has acknowledged a higher-cost render.
    # For single calls it has no effect, but we still allow it.

    if args.quality == "lite" and args.extend_from:
        return False, "--quality lite does not support --extend-from. Use fast or standard."

    if args.resolution == "4k":
        if args.quality != "standard":
            return False, "--resolution 4k requires --quality standard."
        if args.duration != 8:
            return False, "--resolution 4k requires --duration 8."

    for img_path in images:
        if not Path(img_path).is_file():
            return False, f"Input image not found: {img_path}"

    if args.last_frame and not Path(args.last_frame).is_file():
        return False, f"Last-frame image not found: {args.last_frame}"

    return True, None


def load_image_bytes(path: str) -> tuple[bytes, str]:
    """Return (bytes, mime_type) for an image file."""
    data = Path(path).read_bytes()
    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith("image/"):
        mime = "image/png"  # safe default; Veo accepts PNG
    return data, mime


def run(args: argparse.Namespace) -> int:
    api_key = get_api_key(args.api_key)
    if not api_key:
        print(
            "Error: No API key provided. Pass --api-key or set GEMINI_API_KEY.",
            file=sys.stderr,
        )
        return 1

    ok, err = validate_args(args)
    if not ok:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    # Import lazily so argparse errors don't pay the SDK import cost.
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    model = QUALITY_TO_MODEL[args.quality]

    images = args.input_images or []

    # Build the config kwargs. We only set fields the user explicitly asked for so
    # the SDK applies its own defaults when appropriate.
    config_kwargs: dict = {
        "aspect_ratio": args.aspect_ratio,
        "resolution": args.resolution,
        "duration_seconds": args.duration,
        "number_of_videos": 1,
    }

    # Determine mode and build top-level + config inputs.
    first_image_obj = None
    last_image_obj = None
    reference_image_objs: list = []

    if args.last_frame:
        # First/last-frame interpolation mode: exactly 1 input-image as start, last-frame as end.
        data, mime = load_image_bytes(images[0])
        first_image_obj = types.Image(image_bytes=data, mime_type=mime)
        data, mime = load_image_bytes(args.last_frame)
        last_image_obj = types.Image(image_bytes=data, mime_type=mime)
        config_kwargs["last_frame"] = last_image_obj
    elif images:
        # Ingredients to Video: pack all input-images as reference_images.
        for p in images:
            data, mime = load_image_bytes(p)
            img = types.Image(image_bytes=data, mime_type=mime)
            reference_image_objs.append(
                types.VideoGenerationReferenceImage(image=img, reference_type="asset")
            )
        config_kwargs["reference_images"] = reference_image_objs

    config = types.GenerateVideosConfig(**config_kwargs)

    # Extension mode: fetch prior operation's video and pass as top-level video=.
    prior_video = None
    if args.extend_from:
        print(f"Fetching prior operation: {args.extend_from}", file=sys.stderr)
        try:
            prior_op = client.operations.get(args.extend_from)
        except Exception as exc:  # noqa: BLE001
            print(
                f"Error: failed to fetch prior operation '{args.extend_from}': {exc}",
                file=sys.stderr,
            )
            return 1
        try:
            prior_video = prior_op.response.generated_videos[0].video
        except (AttributeError, IndexError) as exc:
            print(
                f"Error: prior operation has no usable video result: {exc}",
                file=sys.stderr,
            )
            return 1

    call_kwargs: dict = {"model": model, "prompt": args.prompt, "config": config}
    if first_image_obj is not None:
        call_kwargs["image"] = first_image_obj
    if prior_video is not None:
        call_kwargs["video"] = prior_video

    print(f"Submitting Veo generation (model={model}, duration={args.duration}s)...", file=sys.stderr)
    try:
        operation = client.models.generate_videos(**call_kwargs)
    except Exception as exc:  # noqa: BLE001
        print(f"Error: generate_videos call failed: {exc}", file=sys.stderr)
        return 1

    op_name = getattr(operation, "name", "<unknown>")
    print(f"Operation: {op_name}", file=sys.stderr)

    elapsed = 0.0
    while not getattr(operation, "done", False):
        if elapsed >= args.max_poll_seconds:
            print(
                f"Error: Veo operation did not complete within "
                f"--max-poll-seconds={args.max_poll_seconds:.0f}s. "
                f"Operation name '{op_name}' may still be retrievable for up to 2 days; "
                f"re-run with --extend-from or use a fresh prompt.",
                file=sys.stderr,
            )
            return 1
        time.sleep(args.poll_interval)
        elapsed += args.poll_interval
        try:
            operation = client.operations.get(operation)
        except Exception as exc:  # noqa: BLE001
            print(f"Error: poll failed at {elapsed:.0f}s: {exc}", file=sys.stderr)
            return 1
        print(f"Polling... ({elapsed:.0f}s elapsed)", file=sys.stderr)

    # Success path: pull the first video, save to --filename.
    try:
        video_obj = operation.response.generated_videos[0].video
    except (AttributeError, IndexError) as exc:
        print(f"Error: no video in operation response: {exc}", file=sys.stderr)
        return 1

    output_path = Path(args.filename).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        # The SDK's Video object exposes .save(path) which writes the MP4 bytes.
        video_obj.save(str(output_path))
    except Exception as exc:  # noqa: BLE001
        print(f"Error: failed to save video: {exc}", file=sys.stderr)
        return 1

    print(f"MEDIA: {output_path}")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
