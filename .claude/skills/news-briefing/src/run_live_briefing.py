#!/usr/bin/env python3
"""
Live News Briefing - Does actual web research
Run this from Claude Code to generate a real briefing with fresh articles
"""

import json
import hashlib
import sys
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any

# This script is meant to be called BY Claude Code agent
# It provides the research tasks that need WebSearch

def load_preferences() -> Dict[str, Any]:
    """Load user preferences"""
    prefs_file = Path("/workspace/group/nanoclaw-skills/news-briefing/config/user_preferences.json")
    with open(prefs_file) as f:
        return json.load(f)

def generate_article_id(title: str, url: str) -> str:
    """Generate unique ID for article"""
    unique_string = f"{title}{url}"
    return hashlib.md5(unique_string.encode()).hexdigest()

def main():
    """Display research tasks for Claude to execute"""
    prefs = load_preferences()

    print("=" * 70)
    print("📰 LIVE NEWS BRIEFING - RESEARCH REQUIRED")
    print("=" * 70)
    print()
    print("This briefing system requires WebSearch access.")
    print("Please execute the following research tasks:")
    print()

    tasks = []

    for category_id, category_data in prefs["categories"].items():
        if not category_data.get("enabled", True):
            continue

        category_name = category_id.replace("_", " ").title()
        topics = category_data.get("topics", [])

        print(f"## {category_name}")
        print(f"   Category ID: {category_id}")
        print(f"   Topics: {', '.join(topics)}")
        print()

        for topic in topics[:2]:  # Top 2 topics per category
            query = f"{topic} news March 2026"
            task = {
                "category_id": category_id,
                "category_name": category_name,
                "topic": topic,
                "query": query,
                "articles_needed": 2
            }
            tasks.append(task)
            print(f"   📡 Query: {query}")

        print()

    print("=" * 70)
    print(f"Total research tasks: {len(tasks)}")
    print("=" * 70)
    print()

    # Output in JSON for Claude to process
    output = {
        "research_tasks": tasks,
        "instructions": {
            "tool": "WebSearch",
            "per_task": "Find 2-3 recent articles, extract title/summary/source/URL",
            "save_location": "agents/results/",
            "format": "See LIVE_RESEARCH_INSTRUCTIONS.md"
        }
    }

    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    main()
