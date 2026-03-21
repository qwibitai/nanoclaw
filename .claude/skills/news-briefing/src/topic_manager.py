#!/usr/bin/env python3
"""
Topic Manager - Manage user preferences and topics
"""

import json
from pathlib import Path
from typing import Dict, Any, List


class TopicManager:
    """Manages user preferences and topic configuration"""

    def __init__(self, base_dir: str = "/workspace/group/nanoclaw-skills/news-briefing"):
        self.base_dir = Path(base_dir)
        self.config_file = self.base_dir / "config" / "user_preferences.json"

    def load_preferences(self) -> Dict[str, Any]:
        """Load user preferences"""
        with open(self.config_file, 'r') as f:
            return json.load(f)

    def save_preferences(self, preferences: Dict[str, Any]):
        """Save user preferences"""
        with open(self.config_file, 'w') as f:
            json.dump(preferences, f, indent=2)

    def add_topic(self, category: str, topic: str) -> bool:
        """Add a topic to a category"""
        preferences = self.load_preferences()

        if category not in preferences["categories"]:
            print(f"❌ Category '{category}' not found!")
            print(f"   Available categories: {', '.join(preferences['categories'].keys())}")
            return False

        topics = preferences["categories"][category].get("topics", [])

        if topic in topics:
            print(f"⚠️  Topic already exists: {topic}")
            return False

        topics.append(topic)
        preferences["categories"][category]["topics"] = topics
        self.save_preferences(preferences)

        print(f"✅ Added topic to {category}: {topic}")
        return True

    def remove_topic(self, topic: str) -> bool:
        """Remove a topic from any category"""
        preferences = self.load_preferences()
        found = False

        for category_name, category_data in preferences["categories"].items():
            topics = category_data.get("topics", [])
            if topic in topics:
                topics.remove(topic)
                category_data["topics"] = topics
                print(f"✅ Removed topic from {category_name}: {topic}")
                found = True

        if found:
            self.save_preferences(preferences)
            return True
        else:
            print(f"❌ Topic not found: {topic}")
            return False

    def list_topics(self):
        """List all topics by category"""
        preferences = self.load_preferences()

        print("\n📋 Current Topics Configuration")
        print("=" * 60)

        for category_name, category_data in preferences["categories"].items():
            enabled = "✓" if category_data.get("enabled", False) else "✗"
            priority = category_data.get("priority", 99)

            print(f"\n{enabled} {category_name.upper()} (Priority: {priority})")
            print("-" * 60)

            topics = category_data.get("topics", [])
            for i, topic in enumerate(topics, 1):
                print(f"  {i}. {topic}")

        print()

    def enable_category(self, category: str) -> bool:
        """Enable a category"""
        preferences = self.load_preferences()

        if category not in preferences["categories"]:
            print(f"❌ Category '{category}' not found!")
            return False

        preferences["categories"][category]["enabled"] = True
        self.save_preferences(preferences)
        print(f"✅ Enabled category: {category}")
        return True

    def disable_category(self, category: str) -> bool:
        """Disable a category"""
        preferences = self.load_preferences()

        if category not in preferences["categories"]:
            print(f"❌ Category '{category}' not found!")
            return False

        preferences["categories"][category]["enabled"] = False
        self.save_preferences(preferences)
        print(f"✅ Disabled category: {category}")
        return True

    def set_delivery_time(self, time_str: str) -> bool:
        """Set delivery time (HH:MM format)"""
        try:
            # Validate format
            hour, minute = time_str.split(":")
            hour = int(hour)
            minute = int(minute)

            if not (0 <= hour <= 23) or not (0 <= minute <= 59):
                raise ValueError("Invalid time")

            preferences = self.load_preferences()
            preferences["delivery_time"] = time_str
            self.save_preferences(preferences)

            print(f"✅ Delivery time set to: {time_str}")
            return True

        except Exception as e:
            print(f"❌ Invalid time format: {time_str}")
            print("   Expected format: HH:MM (e.g., 07:00, 14:30)")
            return False


def main():
    """Main entry point for CLI"""
    import sys

    manager = TopicManager()

    if len(sys.argv) < 2:
        print("📋 Topic Manager - News Briefing System")
        print("=" * 60)
        print("\nUsage:")
        print("  python3 topic_manager.py list")
        print("  python3 topic_manager.py add <category> <topic>")
        print("  python3 topic_manager.py remove <topic>")
        print("  python3 topic_manager.py enable <category>")
        print("  python3 topic_manager.py disable <category>")
        print("  python3 topic_manager.py set-time <HH:MM>")
        print("\nExamples:")
        print("  python3 topic_manager.py add custom_tracking 'SpaceX launches'")
        print("  python3 topic_manager.py remove 'North Dakota state banking system'")
        print("  python3 topic_manager.py set-time 08:00")
        print()
        manager.list_topics()
        return

    command = sys.argv[1].lower()

    if command == "list":
        manager.list_topics()

    elif command == "add":
        if len(sys.argv) < 4:
            print("❌ Usage: add <category> <topic>")
            return
        category = sys.argv[2]
        topic = " ".join(sys.argv[3:])
        manager.add_topic(category, topic)

    elif command == "remove":
        if len(sys.argv) < 3:
            print("❌ Usage: remove <topic>")
            return
        topic = " ".join(sys.argv[2:])
        manager.remove_topic(topic)

    elif command == "enable":
        if len(sys.argv) < 3:
            print("❌ Usage: enable <category>")
            return
        category = sys.argv[2]
        manager.enable_category(category)

    elif command == "disable":
        if len(sys.argv) < 3:
            print("❌ Usage: disable <category>")
            return
        category = sys.argv[2]
        manager.disable_category(category)

    elif command == "set-time":
        if len(sys.argv) < 3:
            print("❌ Usage: set-time <HH:MM>")
            return
        time_str = sys.argv[2]
        manager.set_delivery_time(time_str)

    else:
        print(f"❌ Unknown command: {command}")
        print("   Available: list, add, remove, enable, disable, set-time")


if __name__ == "__main__":
    main()
