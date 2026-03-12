# News Briefing Skill

Daily AI-powered news briefing delivered to your WhatsApp. Parallel research agents gather news across configurable categories, deduplicate against history, compile a professional PDF, and send it on schedule.

---

## How It Works

```
User Config (user_preferences.json)
         │
    Orchestrator
    • Loads prefs & memory
    • Creates per-category research tasks
         │
  Parallel Research Agents
  ┌──────────┬──────────┬──────────┬──────────┐
  │  World   │   Tech   │ Finance  │  Custom  │
  └────┬─────┴────┬─────┴────┬─────┴────┬─────┘
       └──────────┴──────────┴──────────┘
                  │ JSON Results
           Briefing Compiler
           • Deduplicates vs memory
           • Compiles & structures
                  │
            PDF Generator
            • Renders HTML template
            • Converts via agent-browser
                  │
         WhatsApp Delivery (IPC)
```

---

## Project Structure

```
nanoclaw-skills/news-briefing/
├── config/
│   └── user_preferences.json    # Topics, schedule, settings
├── agents/
│   ├── research_tasks.json      # Generated research tasks
│   ├── execution_plan.json      # Agent execution plan
│   └── results/                 # Per-agent JSON results
├── memory/
│   └── briefing_memory.json     # Seen articles, topic history
├── templates/
│   └── briefing_template.html   # PDF styling & layout
├── reports/
│   ├── briefing_YYYY-MM-DD.json
│   ├── briefing_YYYY-MM-DD.html
│   └── briefing_YYYY-MM-DD.pdf
├── src/
│   ├── main.py                  # Entry point
│   ├── orchestrator.py          # Orchestration logic
│   ├── research_coordinator.py  # Agent coordination
│   ├── compile_briefing.py      # Compilation & deduplication
│   ├── generate_pdf.py          # PDF generation
│   ├── topic_manager.py         # Topic management CLI
│   ├── setup_scheduler.py       # Scheduler setup
│   ├── live_research.py         # Live research runner
│   ├── run_live_briefing.py     # Run a live briefing
│   ├── generate_fresh_results.py
│   ├── cleanup_old_results.py   # Remove stale daily results
│   └── send_briefing_now.sh     # Convenience script
└── README.md
```

---

## Running a Briefing

```bash
# Run immediately
python3 /workspace/group/nanoclaw-skills/news-briefing/src/main.py

# Or use the convenience script
bash /workspace/group/nanoclaw-skills/news-briefing/src/send_briefing_now.sh
```

First run takes ~60-70 seconds (parallel agents doing live web research).

---

## Managing Topics

```bash
cd /workspace/group/nanoclaw-skills/news-briefing/src

# List current topics
python3 topic_manager.py list

# Add a topic
python3 topic_manager.py add custom_tracking "SpaceX launches"

# Remove a topic
python3 topic_manager.py remove "North Dakota state banking system"

# Change delivery time
python3 topic_manager.py set-time 08:00

# Disable a category
python3 topic_manager.py disable economy_finance
```

---

## Configuration

`config/user_preferences.json`:

```json
{
  "delivery_time": "07:00",
  "timezone": "America/Los_Angeles",
  "enabled": true,
  "categories": {
    "world_highlights": {
      "enabled": true,
      "priority": 1,
      "topics": ["major world events", "geopolitical developments"]
    },
    "technology": {
      "enabled": true,
      "priority": 2,
      "topics": ["AI breakthroughs", "startup funding", "cybersecurity"]
    },
    "economy_finance": {
      "enabled": true,
      "priority": 3,
      "topics": ["stock market", "cryptocurrency", "Federal Reserve policy"]
    },
    "custom_tracking": {
      "enabled": true,
      "priority": 4,
      "topics": ["your topics here"]
    }
  },
  "preferences": {
    "max_articles_per_category": 5,
    "include_source_links": true,
    "summary_style": "concise"
  }
}
```

Categories are fully dynamic — add any category name with any priority, and the system picks it up automatically.

---

## Memory & Deduplication

Articles are hashed (MD5 of title + URL) and stored in `memory/briefing_memory.json`. Duplicates are filtered across days. The system keeps the last 500 hashes (~30 days of history). Stale daily result files are cleaned up automatically at the start of each run.

---

## Scheduling

The skill installs a daily cron task at your configured delivery time. To reschedule:

```bash
# Via topic manager
python3 topic_manager.py set-time 08:00

# Or edit config directly
# config/user_preferences.json -> "delivery_time": "08:00"
# Then reschedule: mcp__nanoclaw__schedule_task
```

---

## Troubleshooting

**No new articles** — All found articles were duplicates. Normal behavior; memory resets after 500 hashes.

**PDF generation fails** — Test agent-browser:
```bash
agent-browser open https://google.com
agent-browser close
```

**WhatsApp delivery fails** — Check IPC directory and logs:
```bash
ls /workspace/ipc/messages/
tail -50 /workspace/project/logs/nanoclaw.log | grep "Document sent"
```

**Agents timeout** — Reduce topics per category, or check WebSearch availability.

---

## Performance

- Research phase: ~45-60s (parallel agents)
- Compilation + PDF: ~7s
- Total: ~60-70s per briefing
- Cost: ~$0.40-0.45/briefing using Haiku (~$13/month)
