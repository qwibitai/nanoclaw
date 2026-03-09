#!/usr/bin/env python3
"""
Scheduler Setup - Configure automated daily briefings
"""

import json
from datetime import datetime

def setup_daily_briefing(delivery_time: str = "07:00"):
    """
    Set up scheduled task for daily briefing

    Args:
        delivery_time: Time in HH:MM format (24-hour, local time)
    """

    print("📅 News Briefing Scheduler Setup")
    print("=" * 60)

    # Parse time
    try:
        hour, minute = delivery_time.split(":")
        hour = int(hour)
        minute = int(minute)

        if not (0 <= hour <= 23) or not (0 <= minute <= 59):
            raise ValueError("Invalid time")

    except Exception as e:
        print(f"❌ Invalid time format: {delivery_time}")
        print("   Expected format: HH:MM (e.g., 07:00, 14:30)")
        return

    # Create cron expression
    cron_expression = f"{minute} {hour} * * *"

    print(f"\n⏰ Schedule Configuration:")
    print(f"   Delivery Time: {delivery_time} (local time)")
    print(f"   Cron Expression: {cron_expression}")
    print(f"   Frequency: Daily")
    print()

    # Task prompt
    prompt = """Generate and deliver the daily news briefing.

Execute the following steps:
1. Run the news briefing system: python3 /workspace/group/news-briefing-poc/main.py
2. If successful, the briefing will be automatically delivered via WhatsApp
3. If there are any errors, send an error notification via send_message

The system will:
- Research news across 4 categories using parallel agents
- Compile results with deduplication
- Generate a professional PDF report
- Deliver via WhatsApp

Context mode: group (to access conversation history and memory)
"""

    # Scheduler command (to be executed manually or via code)
    scheduler_config = {
        "prompt": prompt,
        "schedule_type": "cron",
        "schedule_value": cron_expression,
        "context_mode": "group"
    }

    print("📋 Scheduler Configuration:")
    print(json.dumps(scheduler_config, indent=2))
    print()

    print("✅ Configuration ready!")
    print()
    print("📝 To activate the schedule, use:")
    print(f'   mcp__nanoclaw__schedule_task with these parameters')
    print()
    print("   OR from Python:")
    print("   ```python")
    print("   # Use the schedule_task tool")
    print(f"   schedule_task(")
    print(f"       prompt='{prompt[:50]}...',")
    print(f"       schedule_type='cron',")
    print(f"       schedule_value='{cron_expression}',")
    print(f"       context_mode='group'")
    print("   )")
    print("   ```")
    print()

    return scheduler_config


if __name__ == "__main__":
    import sys

    # Get delivery time from command line or use default
    delivery_time = sys.argv[1] if len(sys.argv) > 1 else "07:00"

    config = setup_daily_briefing(delivery_time)
