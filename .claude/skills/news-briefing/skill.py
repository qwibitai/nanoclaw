#!/usr/bin/env python3
"""
News Briefing Skill - Entry point and CLI handler
Integrates with nanoclaw's skill system
"""

import sys
import os
from pathlib import Path

# Add src directory to path
SKILL_DIR = Path(__file__).parent
sys.path.insert(0, str(SKILL_DIR / "src"))

from src.main import NewsBriefingSystem
from src.topic_manager import TopicManager
from src.setup_scheduler import setup_daily_briefing


class NewsBriefingSkill:
    """Main skill class for nanoclaw integration"""

    def __init__(self):
        self.skill_dir = SKILL_DIR
        self.system = NewsBriefingSystem(str(self.skill_dir))
        self.topic_manager = TopicManager(str(self.skill_dir))

    def handle_command(self, args: list[str]) -> int:
        """Handle skill commands"""

        if not args:
            self.show_help()
            return 0

        command = args[0].lower()

        if command == "generate":
            return self.cmd_generate()

        elif command == "schedule":
            time = args[1] if len(args) > 1 else "07:00"
            return self.cmd_schedule(time)

        elif command == "topics":
            if len(args) < 2:
                print("Usage: /news-briefing topics <list|add|remove>")
                return 1
            return self.cmd_topics(args[1:])

        elif command == "config":
            action = args[1] if len(args) > 1 else "show"
            return self.cmd_config(action)

        elif command == "status":
            return self.cmd_status()

        elif command == "clear-memory":
            return self.cmd_clear_memory()

        else:
            print(f"❌ Unknown command: {command}")
            self.show_help()
            return 1

    def cmd_generate(self) -> int:
        """Generate and send briefing now"""
        print("🚀 Generating news briefing...")
        print()

        result = self.system.run_full_briefing()

        if result == "success":
            print()
            print("✅ Briefing generated and sent successfully!")
            return 0
        else:
            print()
            print("❌ Briefing generation failed")
            return 1

    def cmd_schedule(self, time: str) -> int:
        """Schedule daily briefings"""
        print(f"📅 Setting up daily briefing at {time}...")
        print()

        config = setup_daily_briefing(time)

        if config:
            print("✅ Schedule configured!")
            print()
            print("To activate, the scheduler needs to be set up via nanoclaw's schedule_task tool.")
            print(f"Cron expression: {config['schedule_value']}")
            return 0
        else:
            return 1

    def cmd_topics(self, args: list[str]) -> int:
        """Manage topics"""
        action = args[0].lower()

        if action == "list":
            self.topic_manager.list_topics()
            return 0

        elif action == "add":
            if len(args) < 3:
                print("Usage: /news-briefing topics add <category> <topic>")
                return 1
            category = args[1]
            topic = " ".join(args[2:])
            return 0 if self.topic_manager.add_topic(category, topic) else 1

        elif action == "remove":
            if len(args) < 2:
                print("Usage: /news-briefing topics remove <topic>")
                return 1
            topic = " ".join(args[1:])
            return 0 if self.topic_manager.remove_topic(topic) else 1

        else:
            print(f"❌ Unknown topics action: {action}")
            print("Available: list, add, remove")
            return 1

    def cmd_config(self, action: str) -> int:
        """View or edit configuration"""
        config_file = self.skill_dir / "config" / "user_preferences.json"

        if action == "show":
            print("📋 Configuration")
            print("=" * 60)
            print(f"Config file: {config_file}")
            print()
            self.topic_manager.list_topics()
            return 0

        elif action == "edit":
            print(f"📝 Edit configuration: {config_file}")
            print()
            print("You can edit the JSON file directly or use:")
            print("  /news-briefing topics add <category> <topic>")
            print("  /news-briefing topics remove <topic>")
            return 0

        else:
            print(f"❌ Unknown config action: {action}")
            return 1

    def cmd_status(self) -> int:
        """Show system status"""
        print("📊 News Briefing System Status")
        print("=" * 60)
        print()

        # Check last briefing
        reports_dir = self.skill_dir / "reports"
        briefings = sorted(reports_dir.glob("briefing_*.pdf"), reverse=True)

        if briefings:
            latest = briefings[0]
            size_kb = latest.stat().st_size / 1024
            print(f"📄 Last briefing: {latest.name}")
            print(f"📏 Size: {size_kb:.1f} KB")
            print(f"📅 Path: {latest}")
        else:
            print("📄 No briefings generated yet")

        print()

        # Check memory
        memory_file = self.skill_dir / "memory" / "briefing_memory.json"
        if memory_file.exists():
            import json
            with open(memory_file, 'r') as f:
                memory = json.load(f)

            seen_count = len(memory.get("seen_articles", []))
            last_date = memory.get("last_briefing_date", "Never")

            print(f"🧠 Memory: {seen_count} articles tracked")
            print(f"📆 Last run: {last_date}")
        else:
            print("🧠 Memory: Not initialized")

        print()
        return 0

    def cmd_clear_memory(self) -> int:
        """Clear seen articles memory"""
        memory_file = self.skill_dir / "memory" / "briefing_memory.json"

        if memory_file.exists():
            memory_file.unlink()
            print("✅ Memory cleared")
            print("   Next briefing will include all articles (no deduplication)")
            return 0
        else:
            print("⚠️  No memory file found")
            return 0

    def show_help(self):
        """Show help message"""
        print("📰 News Briefing Skill")
        print("=" * 60)
        print()
        print("Commands:")
        print("  /news-briefing generate              Generate briefing now")
        print("  /news-briefing schedule [HH:MM]      Schedule daily briefings")
        print("  /news-briefing topics list           List all topics")
        print("  /news-briefing topics add <cat> <t>  Add topic to category")
        print("  /news-briefing topics remove <t>     Remove topic")
        print("  /news-briefing config [show|edit]    View/edit configuration")
        print("  /news-briefing status                Show system status")
        print("  /news-briefing clear-memory          Clear seen articles")
        print()
        print("Examples:")
        print("  /news-briefing generate")
        print("  /news-briefing schedule 08:00")
        print("  /news-briefing topics add technology 'quantum computing'")
        print("  /news-briefing topics remove 'North Dakota banking'")
        print()


def main():
    """Entry point for skill execution"""
    skill = NewsBriefingSkill()

    # Get args (skip script name)
    args = sys.argv[1:]

    # Handle command
    exit_code = skill.handle_command(args)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
