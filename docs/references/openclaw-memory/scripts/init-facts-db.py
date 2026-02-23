#!/usr/bin/env python3
"""Initialize the facts.db SQLite database with FTS5 support."""

import sqlite3
import os

DB_PATH = os.environ.get("FACTS_DB", "memory/facts.db")
SCHEMA_PATH = os.path.join(os.path.dirname(__file__), "..", "schema", "facts.sql")

def init():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    db = sqlite3.connect(DB_PATH)
    db.execute("PRAGMA journal_mode=WAL")

    with open(SCHEMA_PATH) as f:
        db.executescript(f.read())

    count = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    print(f"✅ facts.db ready at {DB_PATH} ({count} existing facts)")
    db.close()

if __name__ == "__main__":
    init()
