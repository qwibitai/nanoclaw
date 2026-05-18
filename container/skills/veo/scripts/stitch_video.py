#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Stitch multiple MP4 clips into a single video using ffmpeg's concat demuxer.

Basic concat:
    uv run stitch_video.py --input a.mp4 --input b.mp4 --filename out.mp4

With unified audio overlay (strips per-clip audio, replaces with the given track):
    uv run stitch_video.py --input a.mp4 --input b.mp4 --filename out.mp4 \\
        --audio soundtrack.mp3

The unified-audio path mitigates Veo's per-clip audio seams. The output uses
ffmpeg's -shortest flag, so the result matches whichever of (video, audio) is
shorter — if the audio is shorter than the combined video, the video is
truncated to the audio's length; if the audio is longer, the audio is
truncated. Pre-pad your audio (or pre-trim) if you need a specific behavior.
"""

from __future__ import annotations

import argparse
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

VIDEO_SUFFIXES = {".mp4"}

# Hard cap on ffmpeg execution time. Veo clips are 4-8s each; concat with audio
# overlay re-encodes at fast preset and rarely exceeds 30s wall time even for
# the 148s max chain. 300s leaves wide headroom while preventing a hung ffmpeg
# from blocking the agent indefinitely.
FFMPEG_TIMEOUT_SECONDS = 300


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Concatenate MP4 clips, optionally overlaying a unified audio track."
    )
    parser.add_argument(
        "--input",
        "-i",
        action="append",
        dest="inputs",
        required=True,
        help="Input MP4 file. Repeat for each clip; at least 2 are required.",
    )
    parser.add_argument(
        "--filename",
        "-f",
        required=True,
        help="Output MP4 path. Parent directory is created if missing.",
    )
    parser.add_argument(
        "--audio",
        "-a",
        help=(
            "Optional unified audio track (mp3/wav/m4a). When set, per-clip audio "
            "is stripped and replaced with this track."
        ),
    )
    parser.add_argument(
        "--ffmpeg",
        default="ffmpeg",
        help="ffmpeg binary (override for tests). Default: %(default)s",
    )
    return parser


def _contains_concat_breaker(path: str) -> bool:
    """Reject paths containing characters that would corrupt ffmpeg's concat
    demuxer file list. The list is line-oriented, so any embedded newline lets
    a malicious filename inject an additional `file '...'` directive."""
    return "\n" in path or "\r" in path


def validate_inputs(args: argparse.Namespace) -> tuple[bool, str | None]:
    if not args.inputs or len(args.inputs) < 2:
        return False, "At least 2 --input clips are required."

    for p in args.inputs:
        if _contains_concat_breaker(p):
            return False, f"Input path contains newline or carriage return: {p!r}"
        path = Path(p)
        if not path.is_file():
            return False, f"Input not found: {p}"
        if path.suffix.lower() not in VIDEO_SUFFIXES:
            return False, f"Input must be .mp4: {p}"

    if args.audio:
        if _contains_concat_breaker(args.audio):
            return False, f"Audio path contains newline or carriage return: {args.audio!r}"
        if not Path(args.audio).is_file():
            return False, f"Audio not found: {args.audio}"

    return True, None


def write_concat_list(inputs: list[str], list_path: Path) -> None:
    """Write the ffmpeg concat-demuxer list file. Paths are absolute and quoted."""
    lines = []
    for p in inputs:
        abs_p = str(Path(p).resolve())
        # ffmpeg's concat demuxer uses single quotes; escape any single quotes in the path.
        escaped = abs_p.replace("'", "'\\''")
        lines.append(f"file '{escaped}'")
    list_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_command(args: argparse.Namespace, list_path: Path, output: Path) -> list[str]:
    """Build the ffmpeg command. Two shapes: concat-only vs concat+audio-overlay."""
    if args.audio:
        # Concat video stream only, then layer the unified audio track on top.
        # -shortest truncates the unified audio if it's longer than the video.
        # -filter_complex re-encodes; necessary because we're mixing streams.
        return [
            args.ffmpeg,
            "-y",  # overwrite output without prompting
            "-f", "concat",
            "-safe", "0",
            "-i", str(list_path),
            "-i", str(Path(args.audio).resolve()),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            str(output),
        ]

    # Plain concat: copy streams, no re-encode.
    return [
        args.ffmpeg,
        "-y",
        "-f", "concat",
        "-safe", "0",
        "-i", str(list_path),
        "-c", "copy",
        str(output),
    ]


def run(args: argparse.Namespace) -> int:
    ok, err = validate_inputs(args)
    if not ok:
        print(f"Error: {err}", file=sys.stderr)
        return 1

    output = Path(args.filename).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmp:
        list_path = Path(tmp) / "concat.txt"
        write_concat_list(args.inputs, list_path)
        cmd = build_command(args, list_path, output)

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

    print(f"MEDIA: {output}")
    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
