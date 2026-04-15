#!/usr/bin/env python3
"""
News Briefing System - Main Orchestrator
Coordinates multi-agent research and PDF generation
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any, Optional
import hashlib

class NewsBriefingOrchestrator:
    """Main orchestrator for the news briefing system"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.config_dir = self.base_dir / "config"
        self.memory_dir = self.base_dir / "memory"
        self.reports_dir = self.base_dir / "reports"
        self.agents_dir = self.base_dir / "agents"

        # Ensure directories exist
        for d in [self.memory_dir, self.reports_dir, self.agents_dir]:
            d.mkdir(parents=True, exist_ok=True)

    def load_user_preferences(self) -> Dict[str, Any]:
        """Load user preferences from config"""
        config_file = self.config_dir / "user_preferences.json"
        with open(config_file, 'r') as f:
            return json.load(f)

    def load_memory(self) -> Dict[str, Any]:
        """Load system memory (previous briefings, seen articles, ongoing situations)"""
        memory_file = self.memory_dir / "briefing_memory.json"

        if not memory_file.exists():
            return {
                "last_briefing_date": None,
                "seen_articles": {},
                "topic_history": {},
                "user_feedback": [],
                "ongoing_situations": {}
            }

        memory = json.load(open(memory_file, 'r'))

        # Migrate seen_articles from old list format to {hash: date} dict
        if isinstance(memory.get("seen_articles"), list):
            yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
            memory["seen_articles"] = {h: yesterday for h in memory["seen_articles"]}

        if "ongoing_situations" not in memory:
            memory["ongoing_situations"] = {}
        return memory

    def save_memory(self, memory: Dict[str, Any]):
        """Save system memory"""
        memory_file = self.memory_dir / "briefing_memory.json"
        with open(memory_file, 'w') as f:
            json.dump(memory, f, indent=2)

    def generate_article_hash(self, title: str, url: str = "") -> str:
        """Generate hash for deduplication"""
        content = f"{title.lower().strip()}|{url}"
        return hashlib.md5(content.encode()).hexdigest()

    def filter_seen_articles(self, articles: List[Dict], memory: Dict) -> List[Dict]:
        """Filter out articles we've already covered"""
        seen_hashes = set(memory.get("seen_articles", []))
        filtered = []

        for article in articles:
            article_hash = self.generate_article_hash(
                article.get("title", ""),
                article.get("url", "")
            )
            if article_hash not in seen_hashes:
                filtered.append(article)
                article["_hash"] = article_hash

        return filtered

    def create_research_tasks(self, preferences: Dict, memory: Optional[Dict] = None) -> List[Dict[str, Any]]:
        """Create research tasks for agent swarm"""
        tasks = []
        ongoing_situations = (memory or {}).get("ongoing_situations", {})

        for category_name, category_data in preferences["categories"].items():
            if not category_data.get("enabled", False):
                continue

            task = {
                "task_id": f"research_{category_name}_{datetime.now().strftime('%Y%m%d')}",
                "category": category_name,
                "priority": category_data.get("priority", 99),
                "topics": category_data.get("topics", []),
                "max_articles": preferences["preferences"].get("max_articles_per_category", 5),
                "agent_prompt": self._generate_agent_prompt(category_name, category_data, ongoing_situations)
            }
            tasks.append(task)

        # Sort by priority
        tasks.sort(key=lambda x: x["priority"])
        return tasks

    def _generate_agent_prompt(self, category: str, category_data: Dict, ongoing_situations: Dict = None) -> str:
        """Generate detailed prompt for research agent"""
        topics = category_data.get("topics", [])
        sources = category_data.get("sources", [])
        today = datetime.now().strftime("%Y-%m-%d")
        yesterday = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")

        prompt = f"""You are a specialized news research agent focused on: {category.replace('_', ' ').title()}

TODAY'S DATE: {today}
Your mission: Find the most important developments from the LAST 24 HOURS only (published {yesterday} or {today}).

Topics to research:
"""
        for i, topic in enumerate(topics, 1):
            prompt += f"{i}. {topic}\n"

        if sources:
            prompt += f"""
PRIORITY SOURCES — check these specific sites first using WebFetch:
"""
            for src in sources:
                prompt += f"- https://{src}\n"
            prompt += "\nAlso search broadly beyond these sources.\n"

        style = category_data.get("style_instructions", "").strip()
        if style:
            prompt += f"""
EDITORIAL FOCUS FOR THIS CATEGORY:
{style}

Apply this focus when selecting which articles to include and how to summarize them.
"""

        prompt += f"""
CRITICAL DATE REQUIREMENTS:
- ONLY include articles published on {today} or {yesterday}
- Use search queries with date filters: e.g., WebSearch("{topics[0] if topics else 'news'} after:{yesterday}")
- Reject any article that doesn't have a publication date of {yesterday} or {today}
- If you can't find enough recent articles, note the shortage — do NOT pad with older stories

Requirements per article:
- Clear, concise headline
- 2-3 sentence summary of what happened
- Why it matters / impact
- Source URL
- Publication timestamp (must be {yesterday} or {today})
- Relevance score 1-10
"""

        # Add ongoing situations context if relevant
        if ongoing_situations:
            prompt += f"""
ONGOING SITUATIONS TO WATCH:
These are developing stories tracked across multiple days. Check for updates today:
"""
            for key, situation in ongoing_situations.items():
                prompt += f"""- [{key}] {situation['title']}
  Current status: {situation.get('current_status', 'Unknown')}
  Last updated: {situation.get('last_updated', 'Unknown')}
"""
            prompt += """
For any of these situations you find updates on, include them in "situation_updates".
Also identify any NEW major ongoing situations that should be tracked going forward.
"""

        prompt += f"""
Return your response as JSON with this exact structure:

{{
  "category": "{category}",
  "research_date": "{today}",
  "articles": [
    {{
      "title": "Article headline",
      "summary": "2-3 sentence summary",
      "impact": "Why this matters",
      "url": "source URL",
      "published": "{today} HH:MM",
      "source": "Publication name",
      "relevance_score": 8
    }}
  ],
  "key_trends": ["trend 1", "trend 2"],
  "notable_absence": "Any expected news that didn't happen",
  "situation_updates": [
    {{
      "situation_key": "snake_case_key",
      "title": "Human-readable situation title",
      "is_new": false,
      "current_status": "One sentence describing the current state right now",
      "today_summary": "What specifically happened today in this situation",
      "severity": "high"
    }}
  ]
}}

Notes:
- situation_updates should only include situations you actually found news about today
- severity values: "high", "medium", "low"
- is_new: true only for brand-new ongoing situations not in the list above

Start your research now. Return ONLY the JSON, no other text.
"""
        return prompt

    def apply_situation_updates(self, existing_situations: Dict, updates: List[Dict]) -> Dict:
        """Apply situation updates from today's research to build current state"""
        situations = {k: dict(v) for k, v in existing_situations.items()}
        today = datetime.now().strftime("%Y-%m-%d")

        for update in updates:
            key = update.get("situation_key", "").strip()
            if not key:
                continue

            if key not in situations:
                situations[key] = {
                    "title": update.get("title", key.replace("_", " ").title()),
                    "current_status": update.get("current_status", ""),
                    "severity": update.get("severity", "medium"),
                    "first_seen": today,
                    "last_updated": today,
                    "events": []
                }

            # Update current status and severity
            if update.get("current_status"):
                situations[key]["current_status"] = update["current_status"]
            if update.get("severity"):
                situations[key]["severity"] = update["severity"]
            situations[key]["last_updated"] = today
            if update.get("title"):
                situations[key]["title"] = update["title"]

            # Add today's event if there's a summary and it's not a duplicate
            today_summary = update.get("today_summary", "").strip()
            if today_summary:
                events = situations[key].get("events", [])
                if not any(e.get("date") == today for e in events):
                    events.append({"date": today, "summary": today_summary})
                situations[key]["events"] = events[-10:]  # Keep last 10

        return situations

    def compile_briefing(self, research_results: List[Dict]) -> Dict[str, Any]:
        """Compile all research into a structured briefing"""
        briefing = {
            "date": datetime.now().strftime("%Y-%m-%d"),
            "generated_at": datetime.now().isoformat(),
            "sections": [],
            "total_articles": 0,
            "sources": set()
        }

        for result in research_results:
            section = {
                "category": result.get("category", "Unknown"),
                "articles": result.get("articles", []),
                "key_trends": result.get("key_trends", []),
                "notable_absence": result.get("notable_absence", "")
            }

            briefing["sections"].append(section)
            briefing["total_articles"] += len(section["articles"])

            for article in section["articles"]:
                briefing["sources"].add(article.get("source", "Unknown"))

        briefing["sources"] = list(briefing["sources"])
        return briefing

    def save_briefing(self, briefing: Dict[str, Any]) -> str:
        """Save briefing to file"""
        date_str = briefing["date"]
        filename = f"briefing_{date_str}.json"
        filepath = self.reports_dir / filename

        with open(filepath, 'w') as f:
            json.dump(briefing, f, indent=2)

        return str(filepath)

    def update_memory_with_briefing(self, briefing: Dict[str, Any], memory: Dict[str, Any]):
        """Update memory with new briefing data"""
        today = datetime.now().strftime("%Y-%m-%d")

        # seen_articles is now {hash: date} — prune entries older than 7 days
        seen = memory.get("seen_articles", {})
        if not isinstance(seen, dict):
            seen = {}
        cutoff = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d")
        seen = {h: d for h, d in seen.items() if d >= cutoff}

        for section in briefing.get("sections", []):
            for article in section.get("articles", []):
                article_hash = self.generate_article_hash(
                    article.get("title", ""),
                    article.get("url", "")
                )
                seen[article_hash] = today

        memory["seen_articles"] = seen
        memory["last_briefing_date"] = briefing.get("metadata", {}).get("date", datetime.now().strftime("%Y-%m-%d"))

        # Persist the updated ongoing situations from this briefing
        if "current_status" in briefing:
            memory["ongoing_situations"] = briefing["current_status"]

        # Track topic coverage
        topic_history = memory.get("topic_history", {})
        briefing_date = briefing.get("metadata", {}).get("date", datetime.now().strftime("%Y-%m-%d"))

        for section in briefing.get("sections", []):
            category = section["category"]
            if category not in topic_history:
                topic_history[category] = []

            topic_history[category].append({
                "date": briefing_date,
                "article_count": len(section["articles"]),
                "trends": section.get("key_trends", [])
            })

            # Keep last 30 days
            topic_history[category] = topic_history[category][-30:]

        memory["topic_history"] = topic_history


def main():
    """Main entry point"""
    orchestrator = NewsBriefingOrchestrator()

    print("🗞️  News Briefing System - Orchestrator")
    print("=" * 60)

    # Load configuration
    print("\n📋 Loading user preferences...")
    preferences = orchestrator.load_user_preferences()
    print(f"   ✓ Loaded {len(preferences['categories'])} categories")

    # Load memory
    print("\n🧠 Loading system memory...")
    memory = orchestrator.load_memory()
    last_briefing = memory.get("last_briefing_date", "Never")
    print(f"   ✓ Last briefing: {last_briefing}")
    print(f"   ✓ Tracking {len(memory.get('seen_articles', []))} seen articles")
    print(f"   ✓ Tracking {len(memory.get('ongoing_situations', {}))} ongoing situations")

    # Create research tasks
    print("\n📝 Creating research tasks...")
    tasks = orchestrator.create_research_tasks(preferences, memory)
    print(f"   ✓ Created {len(tasks)} research tasks")

    for task in tasks:
        print(f"      - {task['category']} (priority {task['priority']})")
        print(f"        Topics: {len(task['topics'])}")

    # Save task definitions for agents
    tasks_file = orchestrator.agents_dir / "research_tasks.json"
    with open(tasks_file, 'w') as f:
        json.dump(tasks, f, indent=2)

    print(f"\n✅ Orchestrator setup complete!")
    print(f"   Tasks file: {tasks_file}")
    print(f"\n💡 Next: Launch agent swarm to execute research tasks")

if __name__ == "__main__":
    main()
