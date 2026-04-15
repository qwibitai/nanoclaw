#!/usr/bin/env python3
"""
News Briefing Management CLI
Allows the agent to manage categories, topics, sources, style instructions,
and ongoing situations through simple commands.

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
  python manage_briefing.py set-style economy_finance "Focus on actionable investment insights."
  python manage_briefing.py clear-style economy_finance
  python manage_briefing.py set-priority technology 2
  python manage_briefing.py set-max-articles 7

  # Ongoing situations (current status panel)
  python manage_briefing.py list-situations
  python manage_briefing.py add-situation us_iran_war "U.S.-Iran War" --status "Ceasefire in effect" --severity high
  python manage_briefing.py update-situation us_iran_war --status "Talks ongoing" --event "UN envoys met in Geneva"
  python manage_briefing.py add-event us_iran_war "2026-04-10" "U.S. launched airstrikes on Iranian nuclear facilities"
  python manage_briefing.py remove-situation us_iran_war
  python manage_briefing.py summarize-reports 7
"""

import json
import sys
import argparse
from pathlib import Path
from datetime import datetime

CONFIG_PATH = Path(__file__).parent.parent / "config" / "user_preferences.json"
MEMORY_PATH = Path(__file__).parent.parent / "memory" / "briefing_memory.json"
REPORTS_PATH = Path(__file__).parent.parent / "reports"

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


# ── Memory helpers ─────────────────────────────────────────────────────────────

def load_memory():
    if not MEMORY_PATH.exists():
        return {"seen_articles": {}, "ongoing_situations": {}, "topic_history": {}}
    with open(MEMORY_PATH, 'r') as f:
        m = json.load(f)
    if "ongoing_situations" not in m:
        m["ongoing_situations"] = {}
    return m

def save_memory(memory):
    with open(MEMORY_PATH, 'w') as f:
        json.dump(memory, f, indent=2)
    print(f"✓ Memory saved to {MEMORY_PATH}")


# ── Situation commands ─────────────────────────────────────────────────────────

def cmd_list_situations(args):
    """List all tracked ongoing situations"""
    memory = load_memory()
    situations = memory.get("ongoing_situations", {})

    if not situations:
        print("No ongoing situations tracked yet.")
        print("Use 'add-situation' to add one, or 'summarize-reports' to review past briefings.")
        return

    severity_order = {"high": 0, "medium": 1, "low": 2}
    sorted_sits = sorted(situations.items(), key=lambda x: severity_order.get(x[1].get("severity", "medium"), 1))

    print(f"\n🔭 ONGOING SITUATIONS ({len(situations)} tracked)")
    print("=" * 60)
    for key, sit in sorted_sits:
        sev = sit.get("severity", "medium")
        icon = {"high": "🔴", "medium": "🟡", "low": "🟢"}.get(sev, "🟡")
        print(f"\n{icon} [{key}] {sit.get('title', key)}")
        print(f"   Status: {sit.get('current_status', 'Unknown')}")
        print(f"   Severity: {sev}  |  Last updated: {sit.get('last_updated', '?')}")
        events = sit.get("events", [])
        if events:
            print(f"   Events ({len(events)}):")
            for e in sorted(events, key=lambda x: x.get("date", ""), reverse=True)[:5]:
                print(f"     {e.get('date', '?')}  {e.get('summary', '')}")
    print()


def cmd_add_situation(args):
    """Add a new ongoing situation"""
    memory = load_memory()
    key = slugify(args.key)
    situations = memory.setdefault("ongoing_situations", {})

    if key in situations:
        print(f"⚠️  Situation '{key}' already exists. Use update-situation instead.")
        sys.exit(1)

    situations[key] = {
        "title": args.title,
        "current_status": args.status or "",
        "severity": args.severity or "medium",
        "first_seen": args.date or datetime.now().strftime("%Y-%m-%d"),
        "last_updated": args.date or datetime.now().strftime("%Y-%m-%d"),
        "events": []
    }

    if args.event:
        situations[key]["events"].append({
            "date": args.date or datetime.now().strftime("%Y-%m-%d"),
            "summary": args.event
        })

    save_memory(memory)
    print(f"✓ Added situation '{key}': {args.title}")
    print(f"  Status: {args.status}")
    print(f"  Severity: {situations[key]['severity']}")


def cmd_update_situation(args):
    """Update status or add a note to an existing situation"""
    memory = load_memory()
    key = slugify(args.key)
    situations = memory.get("ongoing_situations", {})

    if key not in situations:
        print(f"❌ Situation '{key}' not found. Use list-situations to see existing ones.")
        sys.exit(1)

    today = args.date or datetime.now().strftime("%Y-%m-%d")

    if args.status:
        situations[key]["current_status"] = args.status
        situations[key]["last_updated"] = today
        print(f"✓ Updated status: {args.status}")

    if args.severity:
        situations[key]["severity"] = args.severity
        print(f"✓ Updated severity: {args.severity}")

    if args.title:
        situations[key]["title"] = args.title
        print(f"✓ Updated title: {args.title}")

    if args.event:
        events = situations[key].setdefault("events", [])
        events.append({"date": today, "summary": args.event})
        situations[key]["events"] = events[-10:]
        situations[key]["last_updated"] = today
        print(f"✓ Added event ({today}): {args.event}")

    save_memory(memory)


def cmd_add_event(args):
    """Add a historical event to a situation"""
    memory = load_memory()
    key = slugify(args.key)
    situations = memory.get("ongoing_situations", {})

    if key not in situations:
        print(f"❌ Situation '{key}' not found.")
        sys.exit(1)

    events = situations[key].setdefault("events", [])
    events.append({"date": args.date, "summary": args.summary})
    # Sort by date
    events.sort(key=lambda e: e.get("date", ""))
    situations[key]["events"] = events[-10:]

    save_memory(memory)
    print(f"✓ Added event to '{key}' on {args.date}: {args.summary}")


def cmd_remove_situation(args):
    """Remove a tracked situation"""
    memory = load_memory()
    key = slugify(args.key)
    situations = memory.get("ongoing_situations", {})

    if key not in situations:
        print(f"❌ Situation '{key}' not found.")
        sys.exit(1)

    title = situations[key].get("title", key)
    del situations[key]
    save_memory(memory)
    print(f"✓ Removed situation '{key}' ({title})")


def cmd_summarize_reports(args):
    """Print a compact summary of recent briefings for seeding situations"""
    days = args.days or 7
    report_files = sorted(REPORTS_PATH.glob("briefing_*.json"), reverse=True)[:days]

    if not report_files:
        print("❌ No report files found.")
        return

    print(f"\n📚 SUMMARY OF LAST {len(report_files)} BRIEFINGS")
    print("(Use this to identify ongoing situations to track)")
    print("=" * 70)

    for report_file in reversed(report_files):  # oldest first
        try:
            with open(report_file, 'r') as f:
                report = json.load(f)
        except Exception:
            continue

        date = report.get("metadata", {}).get("date") or report_file.stem.replace("briefing_", "")
        sections = report.get("sections", [])

        print(f"\n📅 {date}")
        print("-" * 50)

        for section in sections:
            cat = section.get("category_title") or section.get("category", "")
            articles = section.get("articles", [])
            if not articles:
                continue
            print(f"  {cat}:")
            for a in articles[:3]:  # top 3 per category
                title = a.get("title", "")
                impact = a.get("impact", "")
                print(f"    • {title}")
                if impact:
                    print(f"      → {impact[:100]}")

    print()
    print("─" * 70)
    print("To add a situation based on the above:")
    print('  python manage_briefing.py add-situation KEY "Title" --status "Current state" --severity high')
    print('  python manage_briefing.py add-event KEY 2026-04-10 "What happened that day"')


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

    # Situation management
    sub.add_parser("list-situations", help="List all tracked ongoing situations")

    p = sub.add_parser("add-situation", help="Add a new ongoing situation to track")
    p.add_argument("key", help="Snake_case key (e.g. us_iran_war)")
    p.add_argument("title", help="Human-readable title")
    p.add_argument("--status", default="", help="Current one-sentence status")
    p.add_argument("--severity", choices=["high", "medium", "low"], default="medium")
    p.add_argument("--event", default="", help="Initial event summary")
    p.add_argument("--date", default=None, help="Date for first_seen/event (YYYY-MM-DD, default today)")

    p = sub.add_parser("update-situation", help="Update status or add a note to a situation")
    p.add_argument("key")
    p.add_argument("--status", default=None)
    p.add_argument("--severity", choices=["high", "medium", "low"], default=None)
    p.add_argument("--title", default=None)
    p.add_argument("--event", default=None, help="Add an event note for today")
    p.add_argument("--date", default=None, help="Date for the event (YYYY-MM-DD, default today)")

    p = sub.add_parser("add-event", help="Add a historical event entry to a situation")
    p.add_argument("key")
    p.add_argument("date", help="Date of the event (YYYY-MM-DD)")
    p.add_argument("summary", help="What happened")

    p = sub.add_parser("remove-situation", help="Stop tracking a situation")
    p.add_argument("key")

    p = sub.add_parser("summarize-reports", help="Print compact summary of recent briefings to help seed situations")
    p.add_argument("days", type=int, nargs="?", default=7, help="How many past reports to summarize (default 7)")

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
    "list-situations": cmd_list_situations,
    "add-situation": cmd_add_situation,
    "update-situation": cmd_update_situation,
    "add-event": cmd_add_event,
    "remove-situation": cmd_remove_situation,
    "summarize-reports": cmd_summarize_reports,
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
