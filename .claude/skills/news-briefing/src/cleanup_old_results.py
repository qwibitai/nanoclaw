#!/usr/bin/env python3
"""
Cleanup script to remove old research result files
Run this before main.py to ensure only today's results are used
"""

import os
from datetime import datetime
from pathlib import Path

def cleanup_old_results():
    """Remove result files that are not from today"""
    results_dir = Path("/workspace/group/nanoclaw-skills/news-briefing/agents/results")
    today = datetime.now().strftime("%Y%m%d")

    if not results_dir.exists():
        print("No results directory found")
        return

    removed_count = 0
    kept_count = 0

    for file in results_dir.glob("result_*.json"):
        # Extract date from filename (format: result_research_category_YYYYMMDD.json)
        parts = file.stem.split('_')
        if len(parts) >= 4:
            file_date = parts[-1]  # Last part should be the date

            if file_date != today:
                print(f"Removing old file: {file.name}")
                file.unlink()
                removed_count += 1
            else:
                kept_count += 1

    print(f"✓ Cleanup complete: {removed_count} old files removed, {kept_count} current files kept")

if __name__ == "__main__":
    cleanup_old_results()
