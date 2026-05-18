#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Extract a single frame from a video as a PNG, for use as a Veo reference image.

Usage:
    uv run extract_frame.py --input ref.mp4 --mode first --filename out.png
    uv run extract_frame.py --input ref.mp4 --mode last --filename out.png
    uv run extract_frame.py --input ref.mp4 --mode timestamp \\
        --timestamp 1.5 --filename out.png

Outputs `FRAME: <absolute path>` on stdout — distinct from generate_video's
`MEDIA:` token because a frame is intermediate input, not a deliverable.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
from pathlib import Path

# Single-frame extraction is fast (typically <2s). 60s leaves headroom for
# slow disks while preventing a corrupt input from hanging the agent.
FFMPEG_TIMEOUT_SECONDS = 60
FFPROBE_TIMEOUT_SECONDS = 10


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Extract a single frame from a video as a PNG."
    )
    parser.add_argument(
        "--input", "-i", required=True, help="Input video path (any ffmpeg-readable format)."
    )
    parser.add_argument(
        "--filename",
        "-f",
        required=True,
        help="Output PNG path. Parent directory is created if missing.",
    )
    parser.add_argument(
        "--mode",
        "-m",
        choices=["first", "last", "timestamp"],
        required=True,
        help="Which frame to extract.",
    )
    parser.add_argument(
        "--timestamp",
        "-t",
        type=float,
        help="Seconds offset for --mode timestamp (e.g., 1.5).",
    )
    parser.add_argument(
        "--ffmpeg",
        default="ffmpeg",
        help="ffmpeg binary (override for tests). Default: %(default)s",
    )
    parser.add_argument(
        "--ffprobe",
        default="ffprobe",
        help="ffprobe binary (override for tests). Default: %(default)s",
    )
    return parser


def validate_args(args: argparse.Namespace) -> tuple[bool, str | None]:
    if not Path(args.input).is_file():
        return False, f"Input not found: {args.input}"

    if args.mode == "timestamp" and args.timestamp is None:
        return False, "--mode timestamp requires --timestamp <seconds>."

    if args.timestamp is not None and args.timestamp < 0:
        return False, "--timestamp must be >= 0."

    return True, None


def probe_duration(input_path: str, ffprobe: str) -> float | None:
    """Return the input's duration in seconds, or None if probe fails."""
    cmd = [
        ffprobe,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input_path,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
            timeout=FFPROBE_TIMEOUT_SECONDS,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    try:
        return float(result.stdout.strip())
    except ValueError:
        return None


def build_command(args: argparse.Namespace, output: Path) -> list[str]:
    """Build the ffmpeg invocation for the chosen mode."""
    if args.mode == "first":
        # First frame: -frames:v 1 grabs frame 0 from the start.
        return [
            args.ffmpeg, "-y",
            "-i", str(Path(args.input).resolve()),
            "-frames:v", "1",
            str(output),
        ]
    if args.mode == "last":
        # -sseof seeks from end-of-file; -3 backs up 3s so a single frame
        # extraction reliably lands on or near the final frame.
        return [
            args.ffmpeg, "-y",
            "-sseof", "-3",
            "-i", str(Path(args.input).resolve()),
            "-update", "1",
            "-q:v", "1",
            str(output),
        ]
    # timestamp
    return [
        args.ffmpeg, "-y",
        "-ss", f"{args.timestamp}",
        "-i", str(Path(args.input).resolve()),
        "-frames:v", "1",
        str(output),
    ]


def run(args: argparse.Namespace) -> int:
    ok, err = validate_args(args)
    if not ok:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    # For timestamp mode, range-check against the input's duration when probe succeeds.
    if args.mode == "timestamp":
        duration = probe_duration(args.input, args.ffprobe)
        if duration is not None and args.timestamp > duration:
            print(
                f"Error: --timestamp {args.timestamp}s exceeds input duration {duration:.2f}s.",
                file=sys.stderr,
            )
            return 1

    output = Path(args.filename).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    cmd = build_command(args, output)
    print(f"Running: {' '.join(shlex.quote(c) for c in cmd)}", file=sys.stderr)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=FFMPEG_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        print(
            f"Error: ffmpeg timed out after {FFMPEG_TIMEOUT_SECONDS}s",
            file=sys.stderr,
        )
        return 1
    if result.returncode != 0:
        print(
            f"Error: ffmpeg exited with code {result.returncode}\n{result.stderr}",
            file=sys.stderr,
        )
        return 1

    print(f"FRAME: {output}")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
