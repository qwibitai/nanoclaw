#!/usr/bin/env python3
"""
Live News Briefing - Does actual web research
Run this from Claude Code to generate a real briefing with fresh articles.

This script:
1. Clears stale result files so research is always fresh
2. Outputs research tasks with today's date and importance-first queries
3. Andy reads the output, does WebSearches, saves results, then compiles
"""

import json
import sys
import shutil
from datetime import datetime, timedelta
from pathlib import Path
from typing import List, Dict, Any


BASE_DIR = Path("/workspace/group/nanoclaw-skills/news-briefing")
RESULTS_DIR = BASE_DIR / "agents" / "results"
CONFIG_PATH = BASE_DIR / "config" / "user_preferences.json"
MEMORY_PATH = BASE_DIR / "memory" / "briefing_memory.json"


def load_preferences() -> Dict[str, Any]:
    with open(CONFIG_PATH) as f:
        return json.load(f)


def load_ongoing_situations() -> Dict[str, Any]:
    if not MEMORY_PATH.exists():
        return {}
    with open(MEMORY_PATH) as f:
        memory = json.load(f)
    return memory.get("ongoing_situations", {})


def clear_stale_results():
    """Remove ALL existing result files so research is always fresh on each run"""
    if not RESULTS_DIR.exists():
        RESULTS_DIR.mkdir(parents=True, exist_ok=True)
        return
    removed = 0
    for f in RESULTS_DIR.glob("result_*.json"):
        f.unlink()
        removed += 1
    if removed:
        print(f"🗑️  Cleared {removed} old result file(s) — starting fresh research")


def main():
    today = datetime.now().strftime("%Y-%m-%d")
    yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

    # Always clear results so we don't compile stale cached data
    clear_stale_results()

    prefs = load_preferences()
    categories = {k: v for k, v in prefs["categories"].items() if v.get("enabled", True)}
    situations = load_ongoing_situations()

    print("=" * 70)
    print(f"📰 LIVE NEWS BRIEFING — {today}")
    print("=" * 70)
    print()

    if situations:
        print("## ONGOING TRACKED SITUATIONS")
        print("These are multi-day stories in memory. Apply these rules for ALL research below:")
        print("  1. Search for updates on EACH situation — include findings in situation_updates")
        print("  2. If an article is a recap/background of a tracked situation with NO new info, SKIP IT")
        print("  3. Only include an article about a tracked situation if it contains a genuine update")
        print()
        for key, s in situations.items():
            icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(s.get("severity", "medium"), "⚪")
            print(f"  {icon} [{key}] {s['title']}")
            print(f"     Status: {s.get('current_status', 'unknown')}")
            print(f"     Last updated: {s.get('last_updated', 'unknown')}")
        print()

    print("Research instructions for each category below.")
    print(f"Only include articles published on {today} or {yesterday}.")
    print()

    tasks = []

    for category_id, category_data in sorted(categories.items(), key=lambda x: x[1].get("priority", 99)):
        category_name = category_id.replace("_", " ").title()
        topics = category_data.get("topics", [])
        sources = category_data.get("sources", [])
        style = category_data.get("style_instructions", "").strip()
        max_articles = prefs["preferences"].get("max_articles_per_category", 5)

        print(f"## {category_name}")
        print(f"   Goal: Find the {max_articles} MOST IMPORTANT stories today — not just topic matches")
        print()

        # Query 1: Importance-first broad sweep (always first)
        broad_query = f"top breaking news {category_name.lower()} {today}"
        tasks.append({
            "category_id": category_id,
            "category_name": category_name,
            "type": "broad_sweep",
            "query": broad_query,
            "instruction": f"Find the most important {category_name} stories today regardless of specific topic. Cast a wide net."
        })
        print(f"   🌐 Broad sweep: {broad_query}")

        # Query 2: Most important/major events (catches things outside predefined topics)
        major_query = f"major {category_name.lower()} developments {today} breaking"
        tasks.append({
            "category_id": category_id,
            "category_name": category_name,
            "type": "major_events",
            "query": major_query,
            "instruction": "Find significant events that may not match predefined topics but are important."
        })
        print(f"   ⚡ Major events: {major_query}")

        # Queries 3+: Topic-specific (focused deep dives)
        for topic in topics:
            query = f"{topic} {today}"
            tasks.append({
                "category_id": category_id,
                "category_name": category_name,
                "type": "topic",
                "query": query,
                "instruction": f"Find recent articles specifically about: {topic}"
            })
            print(f"   🔍 Topic: {query}")

        # Priority sources (if any): fetch homepage/news feed
        if sources:
            print(f"   📌 Priority sources to check directly: {', '.join(sources)}")
            tasks.append({
                "category_id": category_id,
                "category_name": category_name,
                "type": "sources",
                "sources": sources,
                "instruction": f"WebFetch the latest headlines from these sources: {', '.join(['https://' + s for s in sources])}"
            })

        if style:
            print(f"   🎯 Editorial focus: {style}")

        print()

    print("=" * 70)
    print("INSTRUCTIONS FOR AGENT:")
    print("=" * 70)
    print(f"""
For EACH category:
1. Run the broad_sweep query first — identify the 2-3 most important stories
2. Run major_events query — catch anything significant not in the broad sweep
3. Run topic queries for depth on specific areas
4. If priority sources listed, WebFetch those to check for breaking news
5. Select the top {prefs['preferences'].get('max_articles_per_category', 5)} articles by IMPORTANCE (not just topic relevance)
6. Save results to: {RESULTS_DIR}/result_research_{{category_id}}_{today}.json

Result file format:
{{
  "category": "category_id",
  "research_date": "{today}",
  "articles": [
    {{
      "title": "headline",
      "summary": "2-3 sentence summary",
      "impact": "why it matters",
      "url": "source url",
      "published": "{today} HH:MM",
      "source": "Publication name",
      "relevance_score": 1-10
    }}
  ],
  "key_trends": ["trend1", "trend2"],
  "notable_absence": "anything expected that didn't happen",
  "situation_updates": [
    {{
      "situation_key": "existing_key_or_new_snake_case",
      "title": "Human-readable situation title",
      "is_new": false,
      "current_status": "One sentence on the situation right now",
      "today_summary": "What specifically happened today",
      "severity": "high"
    }}
  ]
}}

situation_updates rules:
- Include an entry for EVERY tracked situation you found news about today
- Set is_new: true only for brand-new situations not in the tracked list above
- severity: "high", "medium", or "low"
- Leave situation_updates as [] only if you found zero relevant news for any tracked situation

After saving all {len(categories)} result files, run:
  python {BASE_DIR}/main.py
""")

    # Output machine-readable tasks
    output = {
        "date": today,
        "categories": list(categories.keys()),
        "results_dir": str(RESULTS_DIR),
        "tasks": tasks
    }
    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
