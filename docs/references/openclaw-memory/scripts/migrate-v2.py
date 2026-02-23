#!/usr/bin/env python3
"""
Migrate facts.db from v1 schema to v2.

v2 adds:
  - facts.activation (REAL DEFAULT 0.0)
  - facts.importance (REAL DEFAULT 0.5)
  - co_occurrences table
  - aliases table
  - relations table + FTS

Safe to run multiple times (all operations use IF NOT EXISTS / try-except).

Usage:
  python3 scripts/migrate-v2.py [path-to-facts.db]
  python3 scripts/migrate-v2.py  # defaults to ~/.openclaw/data/facts.db
"""

import sqlite3
import sys
from pathlib import Path


def get_db_path():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    default = Path.home() / ".openclaw" / "data" / "facts.db"
    if default.exists():
        return default
    alt = Path.home() / "clawd" / "memory" / "facts.db"
    if alt.exists():
        return alt
    print("ERROR: No facts.db found. Pass path as argument.")
    sys.exit(1)


def migrate(db_path: Path):
    print(f"Migrating: {db_path}")
    conn = sqlite3.connect(str(db_path))
    cur = conn.cursor()

    # --- Add columns to facts ---
    for col, definition in [
        ("decay_score", "REAL"),
        ("activation", "REAL DEFAULT 0.0"),
        ("importance", "REAL DEFAULT 0.5"),
    ]:
        try:
            cur.execute(f"ALTER TABLE facts ADD COLUMN {col} {definition}")
            print(f"  + facts.{col}")
        except sqlite3.OperationalError as e:
            if "duplicate" in str(e).lower():
                print(f"  = facts.{col} (already exists)")
            else:
                raise

    # --- Create co_occurrences ---
    cur.execute("""
        CREATE TABLE IF NOT EXISTS co_occurrences (
            fact_a INTEGER NOT NULL,
            fact_b INTEGER NOT NULL,
            weight REAL DEFAULT 1.0,
            last_wired TEXT,
            PRIMARY KEY (fact_a, fact_b),
            FOREIGN KEY (fact_a) REFERENCES facts(id),
            FOREIGN KEY (fact_b) REFERENCES facts(id)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_co_occ_a ON co_occurrences(fact_a)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_co_occ_b ON co_occurrences(fact_b)")
    print("  + co_occurrences table")

    # --- Create aliases ---
    cur.execute("""
        CREATE TABLE IF NOT EXISTS aliases (
            alias TEXT NOT NULL COLLATE NOCASE,
            entity TEXT NOT NULL COLLATE NOCASE,
            PRIMARY KEY (alias, entity)
        )
    """)
    print("  + aliases table")

    # --- Create relations ---
    cur.execute("""
        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,
            predicate TEXT NOT NULL,
            object TEXT NOT NULL,
            source TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations(predicate)")
    print("  + relations table")

    # --- Create relations_fts ---
    cur.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS relations_fts USING fts5(
            subject, predicate, object,
            content=relations,
            content_rowid=id
        )
    """)
    print("  + relations_fts")

    conn.commit()

    # --- Report ---
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).fetchall()]
    facts_count = cur.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    co_count = cur.execute("SELECT COUNT(*) FROM co_occurrences").fetchone()[0]
    alias_count = cur.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
    rel_count = cur.execute("SELECT COUNT(*) FROM relations").fetchone()[0]

    print(f"\n  Tables: {tables}")
    print(f"  Facts: {facts_count}")
    print(f"  Co-occurrences: {co_count}")
    print(f"  Aliases: {alias_count}")
    print(f"  Relations: {rel_count}")
    print("\nMigration complete. ✅")

    conn.close()


if __name__ == "__main__":
    migrate(get_db_path())
