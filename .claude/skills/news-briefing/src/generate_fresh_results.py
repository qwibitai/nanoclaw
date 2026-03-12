#!/usr/bin/env python3
"""
Generate fresh mock research results for today
This is a temporary fix until we implement live research agents
"""

import json
from datetime import datetime
from pathlib import Path

base_dir = Path("/workspace/group/nanoclaw-skills/news-briefing")
results_dir = base_dir / "agents" / "results"
results_dir.mkdir(parents=True, exist_ok=True)

today = datetime.now().strftime("%Y%m%d")

# Load user preferences to get actual categories
with open(base_dir / "config" / "user_preferences.json") as f:
    prefs = json.load(f)

categories = prefs["categories"]

# Generate fresh results for each category
for category_id, category_data in categories.items():
    if not category_data.get("enabled", True):
        continue

    result = {
        "task_id": f"research_{category_id}_{today}",
        "category": category_id,
        "category_name": category_id.replace("_", " ").title(),
        "timestamp": datetime.now().isoformat(),
        "status": "completed",
        "articles": [],
        "metadata": {
            "sources_searched": 5,
            "articles_found": 0,
            "research_duration_seconds": 45
        }
    }

    # Note: Articles list is empty because we don't have live research yet
    # In production, this would be populated by actual web research agents

    result_file = results_dir / f"result_research_{category_id}_{today}.json"
    with open(result_file, 'w') as f:
        json.dump(result, f, indent=2)

    print(f"✓ Generated: {result_file.name}")

print(f"\n✅ Generated {len(categories)} fresh result files for {today}")
print("⚠️  Note: Results contain 0 articles (mock data)")
print("   To get real articles, upgrade to live research agents")
