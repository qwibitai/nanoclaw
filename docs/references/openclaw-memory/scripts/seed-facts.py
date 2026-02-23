#!/usr/bin/env python3
"""
Seed facts.db with your personal facts.
Edit the FACTS list below with your own data, then run:
    python3 scripts/seed-facts.py
"""

import sqlite3
import os

DB_PATH = os.environ.get("FACTS_DB", "memory/facts.db")

# ─── Edit these with your own facts ─────────────────────────────────────────
# Format: (entity, key, value, category, source, permanent)
# Categories: person, project, decision, convention, credential, preference, date, location

FACTS = [
    # People
    # ("Alice", "birthday", "March 15, 1990", "date", "USER.md", 1),
    # ("Alice", "relationship", "My partner", "person", "USER.md", 1),
    # ("Bob", "birthday", "June 3, 2015", "date", "USER.md", 1),
    # ("Bob", "relationship", "My daughter", "person", "USER.md", 1),

    # Preferences
    # ("user", "theme", "dark mode", "preference", "conversation", 1),
    # ("user", "communication_style", "Direct, no fluff", "preference", "USER.md", 1),
    # ("user", "timezone", "America/New_York", "preference", "USER.md", 1),

    # Projects
    # ("MyProject", "stack", "Next.js 15, PostgreSQL, Docker", "project", "codebase", 0),
    # ("MyProject", "url", "https://myproject.com", "project", "config", 0),

    # Decisions (permanent by default — they capture rationale)
    # ("decision", "SQLite over PostgreSQL for agent memory", "Local-first, no server dependency, FTS5 built-in", "decision", "2026-02-15", 1),
    # ("decision", "Hybrid memory over pure vector search", "80% of queries are structured lookups, vector is overkill", "decision", "2026-02-15", 1),

    # Conventions (rules your agent should always follow)
    # ("convention", "use trash not rm", "Recoverable deletes beat permanent ones", "convention", "AGENTS.md", 1),
    # ("convention", "always check timezone before stating time", "Run TZ command, never do mental math", "convention", "AGENTS.md", 1),
]

def seed():
    if not os.path.exists(DB_PATH):
        print(f"❌ {DB_PATH} not found. Run init-facts-db.py first.")
        return

    if not FACTS:
        print("⚠️  No facts to seed. Edit FACTS list in this file first.")
        return

    db = sqlite3.connect(DB_PATH)

    inserted = 0
    skipped = 0
    for entity, key, value, category, source, permanent in FACTS:
        # Check for duplicates
        existing = db.execute(
            "SELECT id FROM facts WHERE entity=? AND key=? AND value=?",
            (entity, key, value)
        ).fetchone()
        if existing:
            skipped += 1
            continue
        db.execute(
            "INSERT INTO facts (entity, key, value, category, source, permanent) VALUES (?, ?, ?, ?, ?, ?)",
            (entity, key, value, category, source, permanent)
        )
        inserted += 1

    db.commit()
    total = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    print(f"✅ Seeded {inserted} facts ({skipped} duplicates skipped). Total: {total}")
    db.close()

if __name__ == "__main__":
    seed()
