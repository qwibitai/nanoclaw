#!/usr/bin/env python3
"""
News Briefing Management CLI
Allows the agent to manage categories, topics, sources, and style instructions
through simple commands in response to user requests.

Usage examples:
  python manage_briefing.py list
  python manage_briefing.py add-category politics --topics "election news" "legislation" --priority 3
  python manage_briefing.py remove-category culture
  python manage_briefing.py enable-category culture
  python manage_briefing.py disable-category culture
  python manage_briefing.py add-topic technology "quantum computing breakthroughs"
  python manage_briefing.py remove-topic technology "cybersecurity threats and developments"
  python manage_briefing.py add-source cybersecurity "threatpost.com"
  python manage_briefing.py remove-source cybersecurity "securityweek.com"
  python manage_briefing.py set-style economy_finance "Focus on actionable investment insights for retail investors. Flag any unusual market movements."
  python manage_briefing.py clear-style economy_finance
  python manage_briefing.py set-priority technology 2
  python manage_briefing.py set-max-articles 7
"""

import json
import sys
import argparse
from pathlib import Path
from datetime import datetime

CONFIG_PATH = Path(__file__).parent.parent / "config" / "user_preferences.json"

CATEGORY_ICONS = {
    "world_highlights": "🌍",
    "technology": "💻",
    "cybersecurity": "🔒",
    "economy_finance": "💰",
    "culture": "🎭",
    "custom_tracking": "🔍",
}

def load_config():
    with open(CONFIG_PATH, 'r') as f:
        return json.load(f)

def save_config(config):
    with open(CONFIG_PATH, 'w') as f:
        json.dump(config, f, indent=2)
    print(f"✓ Config saved to {CONFIG_PATH}")

def slugify(name):
    return name.lower().replace(" ", "_").replace("-", "_")

def get_icon(category_name):
    return CATEGORY_ICONS.get(category_name, "📌")


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_list(args):
    """Show all categories and current configuration"""
    config = load_config()
    categories = config["categories"]
    prefs = config["preferences"]

    print("\n📰 NEWS BRIEFING CONFIGURATION")
    print("=" * 60)
    print(f"Delivery: {config['delivery_time']} ({config['timezone']})")
    print(f"Enabled: {config['enabled']}")
    print(f"Max articles per category: {prefs['max_articles_per_category']}")
    print()

    # Sort by priority
    sorted_cats = sorted(categories.items(), key=lambda x: x[1].get("priority", 99))

    for name, cat in sorted_cats:
        icon = get_icon(name)
        status = "✅" if cat.get("enabled", True) else "⏸️ DISABLED"
        print(f"{icon} [{cat.get('priority', '?')}] {name}  {status}")
        print(f"   Topics ({len(cat.get('topics', []))}):")
        for t in cat.get("topics", []):
            print(f"     • {t}")
        sources = cat.get("sources", [])
        if sources:
            print(f"   Sources: {', '.join(sources)}")
        style = cat.get("style_instructions", "")
        if style:
            print(f"   Style: {style[:80]}{'...' if len(style) > 80 else ''}")
        print()


def cmd_add_category(args):
    """Add a new category"""
    config = load_config()
    key = slugify(args.name)

    if key in config["categories"]:
        print(f"⚠️  Category '{key}' already exists. Use add-topic or enable-category instead.")
        sys.exit(1)

    # Auto-assign next priority if not specified
    if args.priority:
        priority = args.priority
    else:
        existing = [c.get("priority", 99) for c in config["categories"].values()]
        priority = max(existing) + 1 if existing else 1

    config["categories"][key] = {
        "enabled": True,
        "priority": priority,
        "topics": args.topics or [],
        "sources": args.sources or [],
        "style_instructions": args.style or ""
    }

    # Re-sort priorities to fill any gap
    _normalize_priorities(config, bump_from=priority, except_key=key)

    save_config(config)
    print(f"✓ Added category '{key}' at priority {priority}")
    if args.topics:
        print(f"  Topics: {', '.join(args.topics)}")
    if args.sources:
        print(f"  Sources: {', '.join(args.sources)}")


def cmd_remove_category(args):
    """Remove a category entirely"""
    config = load_config()
    key = slugify(args.name)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    del config["categories"][key]
    save_config(config)
    print(f"✓ Removed category '{key}'")


def cmd_enable_category(args):
    """Enable a disabled category"""
    config = load_config()
    key = slugify(args.name)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    config["categories"][key]["enabled"] = True
    save_config(config)
    print(f"✓ Enabled category '{key}'")


def cmd_disable_category(args):
    """Disable a category without removing it"""
    config = load_config()
    key = slugify(args.name)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    config["categories"][key]["enabled"] = False
    save_config(config)
    print(f"✓ Disabled category '{key}' (use enable-category to restore)")


def cmd_add_topic(args):
    """Add a topic to a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found. Run 'list' to see available categories.")
        sys.exit(1)

    topic = args.topic
    topics = config["categories"][key].setdefault("topics", [])

    if topic in topics:
        print(f"⚠️  Topic already exists in '{key}'")
        sys.exit(0)

    topics.append(topic)
    save_config(config)
    print(f"✓ Added topic to '{key}': {topic}")


def cmd_remove_topic(args):
    """Remove a topic from a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    topic = args.topic
    topics = config["categories"][key].get("topics", [])

    # Try exact match first, then substring match
    if topic in topics:
        topics.remove(topic)
    else:
        matches = [t for t in topics if args.topic.lower() in t.lower()]
        if not matches:
            print(f"❌ Topic not found in '{key}': {topic}")
            print(f"   Existing topics: {topics}")
            sys.exit(1)
        if len(matches) > 1:
            print(f"❌ Ambiguous match. Be more specific. Matches: {matches}")
            sys.exit(1)
        topics.remove(matches[0])
        topic = matches[0]

    config["categories"][key]["topics"] = topics
    save_config(config)
    print(f"✓ Removed topic from '{key}': {topic}")


def cmd_add_source(args):
    """Add a source website to a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    # Normalize source (strip https://, trailing slashes)
    source = args.source.strip().rstrip("/")
    source = source.replace("https://", "").replace("http://", "")

    sources = config["categories"][key].setdefault("sources", [])

    if source in sources:
        print(f"⚠️  Source already in '{key}': {source}")
        sys.exit(0)

    sources.append(source)
    save_config(config)
    print(f"✓ Added source to '{key}': {source}")
    print(f"  Agents will now check this site first when researching {key}")


def cmd_remove_source(args):
    """Remove a source from a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    source = args.source.strip().rstrip("/")
    source = source.replace("https://", "").replace("http://", "")

    sources = config["categories"][key].get("sources", [])

    if source not in sources:
        print(f"❌ Source '{source}' not found in '{key}'")
        print(f"   Current sources: {sources}")
        sys.exit(1)

    sources.remove(source)
    config["categories"][key]["sources"] = sources
    save_config(config)
    print(f"✓ Removed source from '{key}': {source}")


def cmd_set_style(args):
    """Set style/focus instructions for a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    config["categories"][key]["style_instructions"] = args.instructions
    save_config(config)
    print(f"✓ Updated style for '{key}':")
    print(f"  {args.instructions}")
    print(f"  This will be injected into the research agent prompt for this category.")


def cmd_clear_style(args):
    """Clear style instructions from a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    config["categories"][key]["style_instructions"] = ""
    save_config(config)
    print(f"✓ Cleared style instructions for '{key}'")


def cmd_set_priority(args):
    """Change the priority (order) of a category"""
    config = load_config()
    key = slugify(args.category)

    if key not in config["categories"]:
        print(f"❌ Category '{key}' not found.")
        sys.exit(1)

    config["categories"][key]["priority"] = args.priority
    save_config(config)

    # Show new order
    sorted_cats = sorted(config["categories"].items(), key=lambda x: x[1].get("priority", 99))
    print(f"✓ Set '{key}' to priority {args.priority}. Current order:")
    for name, cat in sorted_cats:
        marker = " ◄" if name == key else ""
        status = "" if cat.get("enabled", True) else " (disabled)"
        print(f"  [{cat.get('priority', '?')}] {name}{status}{marker}")


def cmd_set_max_articles(args):
    """Set max articles per category"""
    config = load_config()
    config["preferences"]["max_articles_per_category"] = args.count
    save_config(config)
    print(f"✓ Max articles per category set to {args.count}")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _normalize_priorities(config, bump_from=None, except_key=None):
    """Bump priorities to make room for a new entry at bump_from"""
    if bump_from is None:
        return
    for key, cat in config["categories"].items():
        if key == except_key:
            continue
        if cat.get("priority", 99) >= bump_from:
            cat["priority"] += 1


# ── Argument Parser ───────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(
        description="Manage news briefing categories, topics, sources, and style"
    )
    sub = parser.add_subparsers(dest="command")

    sub.add_parser("list", help="Show current configuration")

    p = sub.add_parser("add-category", help="Add a new category")
    p.add_argument("name", help="Category name (e.g. 'politics', 'health')")
    p.add_argument("--topics", nargs="+", default=[], help="Initial topic strings")
    p.add_argument("--sources", nargs="+", default=[], help="Priority source domains")
    p.add_argument("--priority", type=int, default=None, help="Priority order (lower = earlier)")
    p.add_argument("--style", default="", help="Style/focus instructions")

    p = sub.add_parser("remove-category", help="Remove a category")
    p.add_argument("name")

    p = sub.add_parser("enable-category", help="Re-enable a disabled category")
    p.add_argument("name")

    p = sub.add_parser("disable-category", help="Temporarily disable a category")
    p.add_argument("name")

    p = sub.add_parser("add-topic", help="Add a topic to a category")
    p.add_argument("category")
    p.add_argument("topic")

    p = sub.add_parser("remove-topic", help="Remove a topic from a category")
    p.add_argument("category")
    p.add_argument("topic")

    p = sub.add_parser("add-source", help="Add a priority source to a category")
    p.add_argument("category")
    p.add_argument("source", help="Domain or URL (e.g. krebsonsecurity.com)")

    p = sub.add_parser("remove-source", help="Remove a source from a category")
    p.add_argument("category")
    p.add_argument("source")

    p = sub.add_parser("set-style", help="Set style/focus instructions for a category")
    p.add_argument("category")
    p.add_argument("instructions", help="Free-text instructions injected into the agent prompt")

    p = sub.add_parser("clear-style", help="Clear style instructions for a category")
    p.add_argument("category")

    p = sub.add_parser("set-priority", help="Change category priority order")
    p.add_argument("category")
    p.add_argument("priority", type=int)

    p = sub.add_parser("set-max-articles", help="Set max articles per category per briefing")
    p.add_argument("count", type=int)

    return parser


COMMANDS = {
    "list": cmd_list,
    "add-category": cmd_add_category,
    "remove-category": cmd_remove_category,
    "enable-category": cmd_enable_category,
    "disable-category": cmd_disable_category,
    "add-topic": cmd_add_topic,
    "remove-topic": cmd_remove_topic,
    "add-source": cmd_add_source,
    "remove-source": cmd_remove_source,
    "set-style": cmd_set_style,
    "clear-style": cmd_clear_style,
    "set-priority": cmd_set_priority,
    "set-max-articles": cmd_set_max_articles,
}


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(0)

    handler = COMMANDS.get(args.command)
    if not handler:
        print(f"❌ Unknown command: {args.command}")
        sys.exit(1)

    handler(args)


if __name__ == "__main__":
    main()
