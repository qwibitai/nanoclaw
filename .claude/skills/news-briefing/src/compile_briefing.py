#!/usr/bin/env python3
"""
Briefing Compiler - Compiles research results into final briefing
Includes deduplication and memory management
"""

import json
import sys
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Any
import hashlib

sys.path.append(str(Path(__file__).parent))
from orchestrator import NewsBriefingOrchestrator


class BriefingCompiler:
    """Compiles research results into final briefing with deduplication"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.results_dir = self.base_dir / "agents" / "results"
        self.reports_dir = self.base_dir / "reports"
        self.orchestrator = NewsBriefingOrchestrator(base_dir)

        self.reports_dir.mkdir(parents=True, exist_ok=True)

    def load_all_research_results(self) -> List[Dict[str, Any]]:
        """Load all research result files"""
        results = []

        result_files = sorted(self.results_dir.glob("result_*.json"))

        for result_file in result_files:
            try:
                with open(result_file, 'r') as f:
                    data = json.load(f)
                    results.append(data)
            except Exception as e:
                print(f"   ⚠️  Error loading {result_file.name}: {e}")

        return results

    def deduplicate_articles(self, results: List[Dict[str, Any]], memory: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Remove duplicate articles using memory system"""
        deduplicated_results = []
        seen_hashes = set(memory.get("seen_articles", []))
        new_seen_hashes = []
        total_before = 0
        total_after = 0

        for result in results:
            articles = result.get("articles", [])
            total_before += len(articles)

            unique_articles = []

            for article in articles:
                # Generate hash for deduplication
                article_hash = self.orchestrator.generate_article_hash(
                    article.get("title", ""),
                    article.get("url", "")
                )

                if article_hash not in seen_hashes:
                    unique_articles.append(article)
                    seen_hashes.add(article_hash)
                    new_seen_hashes.append(article_hash)

            total_after += len(unique_articles)

            # Create deduplicated result
            deduplicated_result = result.copy()
            deduplicated_result["articles"] = unique_articles
            deduplicated_result["original_count"] = len(articles)
            deduplicated_result["deduplicated_count"] = len(unique_articles)
            deduplicated_results.append(deduplicated_result)

        print(f"   📊 Deduplication: {total_before} articles → {total_after} unique ({total_before - total_after} duplicates removed)")

        # Update memory with new articles
        memory["seen_articles"] = list(seen_hashes)[-500:]  # Keep last 500

        return deduplicated_results

    def compile_final_briefing(self, results: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Compile all results into final briefing structure"""
        briefing = {
            "metadata": {
                "date": datetime.now().strftime("%Y-%m-%d"),
                "generated_at": datetime.now().isoformat(),
                "version": "1.0"
            },
            "summary": {
                "total_categories": len(results),
                "total_articles": sum(len(r.get("articles", [])) for r in results),
                "sources": []
            },
            "sections": []
        }

        all_sources = set()

        for result in results:
            articles = result.get("articles", [])

            # Collect sources
            for article in articles:
                source = article.get("source", "Unknown")
                all_sources.add(source)

            # Create section
            section = {
                "category": result.get("category", "unknown"),
                "category_title": self._format_category_title(result.get("category", "unknown")),
                "article_count": len(articles),
                "articles": sorted(articles, key=lambda x: x.get("relevance_score", 0), reverse=True),
                "key_trends": result.get("key_trends", []),
                "notable_absence": result.get("notable_absence", "")
            }

            briefing["sections"].append(section)

        briefing["summary"]["sources"] = sorted(list(all_sources))

        # Sort sections by priority (world → tech → finance → custom)
        priority_order = {
            "world_highlights": 1,
            "technology": 2,
            "economy_finance": 3,
            "custom_tracking": 4
        }

        briefing["sections"].sort(key=lambda x: priority_order.get(x["category"], 99))

        return briefing

    def _format_category_title(self, category: str) -> str:
        """Format category name for display"""
        titles = {
            "world_highlights": "🌍 World Highlights",
            "technology": "💻 Technology",
            "economy_finance": "💰 Economy & Finance",
            "custom_tracking": "🔍 Custom Tracking"
        }
        return titles.get(category, category.replace("_", " ").title())

    def save_briefing(self, briefing: Dict[str, Any]) -> str:
        """Save compiled briefing to file"""
        date_str = briefing["metadata"]["date"]
        filename = f"briefing_{date_str}.json"
        filepath = self.reports_dir / filename

        with open(filepath, 'w') as f:
            json.dump(briefing, f, indent=2)

        return str(filepath)

    def print_briefing_summary(self, briefing: Dict[str, Any]):
        """Print a nice summary of the briefing"""
        metadata = briefing["metadata"]
        summary = briefing["summary"]

        print(f"\n{'='*60}")
        print(f"📰 DAILY NEWS BRIEFING - {metadata['date']}")
        print(f"{'='*60}")

        print(f"\n📊 Summary:")
        print(f"   • Categories: {summary['total_categories']}")
        print(f"   • Articles: {summary['total_articles']}")
        print(f"   • Sources: {len(summary['sources'])}")

        print(f"\n📑 Sections:")
        for section in briefing["sections"]:
            print(f"\n   {section['category_title']}")
            print(f"   └─ {section['article_count']} articles")
            if section.get("key_trends"):
                print(f"      Trends: {', '.join(section['key_trends'][:2])}")


def main():
    """Main entry point"""
    compiler = BriefingCompiler()

    print("📋 Briefing Compiler - News Briefing System")
    print("=" * 60)

    # Load memory
    print("\n🧠 Loading system memory...")
    memory = compiler.orchestrator.load_memory()
    seen_count = len(memory.get("seen_articles", []))
    print(f"   ✓ Tracking {seen_count} previously seen articles")

    # Load research results
    print("\n📥 Loading research results...")
    results = compiler.load_all_research_results()
    print(f"   ✓ Loaded {len(results)} research result files")

    # Deduplicate
    print("\n🔍 Deduplicating articles...")
    deduplicated_results = compiler.deduplicate_articles(results, memory)

    # Compile briefing
    print("\n⚙️  Compiling final briefing...")
    briefing = compiler.compile_final_briefing(deduplicated_results)

    # Save briefing
    print("\n💾 Saving briefing...")
    briefing_file = compiler.save_briefing(briefing)
    print(f"   ✓ Saved to: {briefing_file}")

    # Update memory
    print("\n🧠 Updating memory...")
    compiler.orchestrator.update_memory_with_briefing(briefing, memory)
    compiler.orchestrator.save_memory(memory)
    print(f"   ✓ Memory updated")

    # Print summary
    compiler.print_briefing_summary(briefing)

    print(f"\n✅ Briefing compilation complete!")
    print(f"   Next: Generate PDF from {briefing_file}")


if __name__ == "__main__":
    main()
