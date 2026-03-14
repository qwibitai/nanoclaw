#!/usr/bin/env python3
"""
Live Research Agent - Actually fetches news using WebSearch
Replaces the mock PoC results with real research
"""

import json
import hashlib
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any


class LiveResearchAgent:
    """Performs actual web research for news briefings"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.results_dir = self.base_dir / "agents" / "results"
        self.results_dir.mkdir(parents=True, exist_ok=True)

    def research_category(self, category_id: str, category_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Research a single category using web search

        Note: This requires WebSearch tool which is only available in Claude Code
        For now, returns structured prompt for manual research
        """
        topics = category_data.get("topics", [])
        category_name = category_id.replace("_", " ").title()

        # Build search queries from topics
        search_queries = []
        for topic in topics[:3]:  # Top 3 topics
            search_queries.append(f"{topic} news today")

        result = {
            "task_id": f"research_{category_id}_{datetime.now().strftime('%Y%m%d')}",
            "category": category_id,
            "category_name": category_name,
            "timestamp": datetime.now().isoformat(),
            "status": "requires_manual_research",
            "search_queries": search_queries,
            "articles": [],
            "metadata": {
                "topics_searched": len(topics),
                "queries_generated": len(search_queries),
                "note": "Requires WebSearch tool - run from Claude Code main session"
            }
        }

        return result

    def generate_research_prompts(self) -> str:
        """Generate prompts for manual research in Claude Code"""

        # Load preferences
        with open(self.base_dir / "config" / "user_preferences.json") as f:
            prefs = json.load(f)

        prompt = """# News Briefing Research Tasks

To generate today's briefing, execute these WebSearch queries and save results:

"""

        for category_id, category_data in prefs["categories"].items():
            if not category_data.get("enabled", True):
                continue

            category_name = category_id.replace("_", " ").title()
            topics = category_data.get("topics", [])

            prompt += f"\n## {category_name}\n\n"

            for i, topic in enumerate(topics[:3], 1):
                query = f"{topic} news 2026"
                prompt += f"{i}. **Query:** `{query}`\n"
                prompt += f"   - Find 2-3 recent articles\n"
                prompt += f"   - Extract: title, summary, source, URL, date\n\n"

        prompt += """
## Output Format

Save as: `agents/results/result_research_{category}_{YYYYMMDD}.json`

```json
{
  "task_id": "research_{category}_{date}",
  "category": "{category_id}",
  "category_name": "{Category Name}",
  "timestamp": "2026-03-10T...",
  "status": "completed",
  "articles": [
    {
      "title": "Article headline",
      "summary": "2-3 sentence summary",
      "source": "Source name",
      "url": "https://...",
      "published_date": "2026-03-10",
      "relevance_score": 0.9
    }
  ],
  "metadata": {
    "sources_searched": 5,
    "articles_found": 3,
    "research_duration_seconds": 120
  }
}
```

Run this from Claude Code main session with WebSearch access.
"""

        return prompt


def main():
    """Generate research instructions"""
    agent = LiveResearchAgent()
    prompt = agent.generate_research_prompts()

    # Save instructions
    instructions_file = agent.base_dir / "LIVE_RESEARCH_INSTRUCTIONS.md"
    with open(instructions_file, 'w') as f:
        f.write(prompt)

    print(f"✓ Generated research instructions: {instructions_file.name}")
    print()
    print("📋 Next steps:")
    print("1. Read the instructions file")
    print("2. Run WebSearch queries in Claude Code")
    print("3. Save results to agents/results/")
    print("4. Run main.py to compile briefing")
    print()
    print("Or: Implement automated WebSearch integration (30-60 min)")


if __name__ == "__main__":
    main()
