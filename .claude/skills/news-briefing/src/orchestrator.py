#!/usr/bin/env python3
"""
News Briefing System - Main Orchestrator
Coordinates multi-agent research and PDF generation
"""

import json
import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Dict, List, Any
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
        """Load system memory (previous briefings, seen articles)"""
        memory_file = self.memory_dir / "briefing_memory.json"

        if not memory_file.exists():
            return {
                "last_briefing_date": None,
                "seen_articles": [],
                "topic_history": {},
                "user_feedback": []
            }

        with open(memory_file, 'r') as f:
            return json.load(f)

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

    def create_research_tasks(self, preferences: Dict) -> List[Dict[str, Any]]:
        """Create research tasks for agent swarm"""
        tasks = []

        for category_name, category_data in preferences["categories"].items():
            if not category_data.get("enabled", False):
                continue

            task = {
                "task_id": f"research_{category_name}_{datetime.now().strftime('%Y%m%d')}",
                "category": category_name,
                "priority": category_data.get("priority", 99),
                "topics": category_data.get("topics", []),
                "max_articles": preferences["preferences"].get("max_articles_per_category", 5),
                "agent_prompt": self._generate_agent_prompt(category_name, category_data)
            }
            tasks.append(task)

        # Sort by priority
        tasks.sort(key=lambda x: x["priority"])
        return tasks

    def _generate_agent_prompt(self, category: str, category_data: Dict) -> str:
        """Generate detailed prompt for research agent"""
        topics = category_data.get("topics", [])

        prompt = f"""You are a specialized news research agent focused on: {category.replace('_', ' ').title()}

Your mission: Research and summarize the most important developments in the following topics from the last 24 hours:

"""
        for i, topic in enumerate(topics, 1):
            prompt += f"{i}. {topic}\n"

        prompt += f"""

Requirements:
- Focus on NEWS from the last 24 hours (published within the last day)
- Find the top 3-5 most important stories for these topics
- For each story, provide:
  * Clear, concise headline
  * 2-3 sentence summary of what happened
  * Why it matters / impact
  * Source URL
  * Publication timestamp

- Prioritize:
  * Credible sources (major news outlets, official announcements, respected tech blogs)
  * Factual reporting over opinion pieces
  * Stories with broad impact or significance
  * NEW information (avoid old news)

- Use WebSearch to find recent articles
- If a story is particularly important, use WebFetch to get full details
- Format your response as JSON with this structure:

{{
  "category": "{category}",
  "research_date": "YYYY-MM-DD",
  "articles": [
    {{
      "title": "Article headline",
      "summary": "2-3 sentence summary",
      "impact": "Why this matters",
      "url": "source URL",
      "published": "YYYY-MM-DD HH:MM",
      "source": "Publication name",
      "relevance_score": 1-10
    }}
  ],
  "key_trends": ["trend 1", "trend 2"],
  "notable_absence": "Any expected news that didn't happen"
}}

Start your research now. Return ONLY the JSON, no other text.
"""
        return prompt

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
        # Track seen articles
        seen_hashes = memory.get("seen_articles", [])

        for section in briefing.get("sections", []):
            for article in section.get("articles", []):
                article_hash = self.generate_article_hash(
                    article.get("title", ""),
                    article.get("url", "")
                )
                if article_hash not in seen_hashes:
                    seen_hashes.append(article_hash)

        # Keep only last 7 days of seen articles (avoid memory bloat)
        memory["seen_articles"] = seen_hashes[-500:]  # Keep last 500 articles
        memory["last_briefing_date"] = briefing.get("metadata", {}).get("date", datetime.now().strftime("%Y-%m-%d"))

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

    # Create research tasks
    print("\n📝 Creating research tasks...")
    tasks = orchestrator.create_research_tasks(preferences)
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
