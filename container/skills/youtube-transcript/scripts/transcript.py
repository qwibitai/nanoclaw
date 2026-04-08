#!/usr/bin/env python3
"""
transcript.py — Extract transcript from a YouTube video.

Usage:
    python3 transcript.py <url_or_id> [--lang en] [--save path/to/file.txt]

Output: Plain text transcript to stdout.
Exit codes: 0 = success, 1 = no transcript found, 2 = invalid input.
"""

import sys
import re
import argparse

def extract_video_id(url_or_id):
    """Extract video ID from URL or return as-is if already an ID."""
    patterns = [
        r'(?:youtube\.com/watch\?v=|youtu\.be/|youtube\.com/embed/)([a-zA-Z0-9_-]{11})',
        r'^([a-zA-Z0-9_-]{11})$'
    ]
    for pattern in patterns:
        match = re.search(pattern, url_or_id)
        if match:
            return match.group(1)
    return None

def fetch_transcript(video_id, lang='en'):
    """Fetch transcript using youtube-transcript-api."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        print("ERROR: youtube-transcript-api not installed. Run: pip3 install youtube-transcript-api", file=sys.stderr)
        sys.exit(2)

    api = YouTubeTranscriptApi()
    try:
        transcript = api.fetch(video_id, languages=[lang])
        return ' '.join(snippet.text for snippet in transcript.snippets)
    except Exception:
        # Try without language preference (auto-generated)
        try:
            transcript = api.fetch(video_id)
            return ' '.join(snippet.text for snippet in transcript.snippets)
        except Exception as e:
            print(f"ERROR: No transcript available for {video_id}: {e}", file=sys.stderr)
            sys.exit(1)

def main():
    parser = argparse.ArgumentParser(description='Extract YouTube transcript')
    parser.add_argument('video', help='YouTube URL or video ID')
    parser.add_argument('--lang', default='en', help='Preferred language (default: en)')
    parser.add_argument('--save', help='Save transcript to file')
    args = parser.parse_args()

    video_id = extract_video_id(args.video)
    if not video_id:
        print(f"ERROR: Cannot extract video ID from: {args.video}", file=sys.stderr)
        sys.exit(2)

    text = fetch_transcript(video_id, args.lang)

    if args.save:
        with open(args.save, 'w') as f:
            f.write(text)
        print(f"Saved to {args.save} ({len(text)} chars)", file=sys.stderr)
    else:
        print(text)

if __name__ == '__main__':
    main()
