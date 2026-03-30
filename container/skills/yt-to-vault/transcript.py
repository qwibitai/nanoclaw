#!/usr/bin/env python3
"""Fetch and clean YouTube transcript via yt-dlp."""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")


def parse_args(argv):
    args = argv[1:]
    url = None
    lang = "en"
    timestamps = False
    i = 0
    while i < len(args):
        if args[i] in ("--lang",) and i + 1 < len(args):
            lang = args[i + 1]
            i += 2
        elif args[i] == "--timestamps":
            timestamps = True
            i += 1
        else:
            url = args[i]
            i += 1
    if not url:
        print("Usage: transcript.py <youtube_url_or_id> [--lang LANG] [--timestamps]", file=sys.stderr)
        print("Example: transcript.py https://youtube.com/watch?v=abc123 --lang en", file=sys.stderr)
        sys.exit(1)
    # Accept bare video IDs (11 chars, no slashes)
    if "/" not in url and len(url) <= 15:
        url = f"https://youtube.com/watch?v={url}"
    return url, lang, timestamps


def parse_vtt(vtt_text, include_timestamps):
    """Parse WebVTT content into clean text, deduplicating adjacent repeated lines."""
    lines = vtt_text.splitlines()
    blocks = []
    current_time = None
    current_lines = []

    for line in lines:
        line = line.strip()
        if not line or line.startswith("WEBVTT") or line.startswith("Kind:") or line.startswith("Language:"):
            if current_lines:
                blocks.append((current_time, current_lines))
                current_time = None
                current_lines = []
            continue
        # Timestamp line
        if "-->" in line:
            if current_lines:
                blocks.append((current_time, current_lines))
                current_lines = []
            current_time = line.split("-->")[0].strip()
            continue
        # Strip VTT tags like <00:00:01.000>, <c>, </c>
        cleaned = re.sub(r"<[^>]+>", "", line).strip()
        if cleaned:
            current_lines.append(cleaned)

    if current_lines:
        blocks.append((current_time, current_lines))

    # Deduplicate: YouTube auto-captions use a rolling window where each block
    # shares lines with the previous block. Only emit lines that are new.
    output = []
    prev_lines = set()
    for timestamp, text_lines in blocks:
        new_lines = [l for l in text_lines if l not in prev_lines]
        prev_lines = set(text_lines)
        if not new_lines:
            continue
        text = " ".join(new_lines)
        if include_timestamps and timestamp:
            ts = timestamp.split(".")[0]
            output.append(f"[{ts}] {text}")
        else:
            output.append(text)

    return "\n".join(output)


def get_video_title(url, tmpdir):
    """Fetch video title via yt-dlp --dump-json."""
    try:
        result = subprocess.run(
            ["yt-dlp", "--dump-json", "--no-download", "--no-warnings", "--quiet", url],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            info = json.loads(result.stdout.strip().splitlines()[0])
            return info.get("title", "")
    except Exception:
        pass
    return ""


def main():
    url, lang, timestamps = parse_args(sys.argv)

    if not shutil.which("yt-dlp"):
        print("Error: yt-dlp not found. Install with: pip install yt-dlp", file=sys.stderr)
        sys.exit(1)

    with tempfile.TemporaryDirectory() as tmpdir:
        out_template = os.path.join(tmpdir, "%(id)s")

        print(f"Fetching transcript for: {url}", file=sys.stderr)
        print(f"Language: {lang}", file=sys.stderr)

        # Try auto-generated captions first, fall back to manual
        for auto in (True, False):
            cmd = [
                "yt-dlp",
                "--skip-download",
                "--no-warnings",
                "--quiet",
                "--sub-lang", lang,
                "--sub-format", "vtt",
                "--output", out_template,
            ]
            if auto:
                cmd.append("--write-auto-sub")
            else:
                cmd.append("--write-sub")
            cmd.append(url)

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

            # Find any .vtt file written
            vtt_files = [f for f in os.listdir(tmpdir) if f.endswith(".vtt")]
            if vtt_files:
                break

        if not vtt_files:
            # Check if it's a language issue
            print(
                f"No transcript found for language '{lang}'.\n"
                "Try a different language code with --lang (e.g. --lang en, --lang es).\n"
                "Some videos have no captions at all.",
                file=sys.stderr,
            )
            sys.exit(1)

        vtt_path = os.path.join(tmpdir, vtt_files[0])
        with open(vtt_path, encoding="utf-8", errors="replace") as f:
            vtt_text = f.read()

        title = get_video_title(url, tmpdir)
        transcript = parse_vtt(vtt_text, timestamps)

        if title:
            print(f"# {title}\n")
        print(f"Source: {url}\n")
        print("---\n")
        print(transcript)


if __name__ == "__main__":
    main()
