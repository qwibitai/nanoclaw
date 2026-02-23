#!/usr/bin/env python3
"""
Query facts.db from the command line.

Usage:
    python3 scripts/query-facts.py "birthday"           # FTS search
    python3 scripts/query-facts.py --entity Alice       # All facts about Alice
    python3 scripts/query-facts.py --entity Alice --key birthday  # Exact lookup
    python3 scripts/query-facts.py --category decision   # All decisions
    python3 scripts/query-facts.py --stats               # Database stats
"""

import sqlite3
import argparse
import os
import json

DB_PATH = os.environ.get("FACTS_DB", "memory/facts.db")

def main():
    parser = argparse.ArgumentParser(description="Query facts.db")
    parser.add_argument("query", nargs="?", help="Full-text search query")
    parser.add_argument("--entity", help="Filter by entity")
    parser.add_argument("--key", help="Filter by key (requires --entity)")
    parser.add_argument("--category", help="Filter by category")
    parser.add_argument("--stats", action="store_true", help="Show database statistics")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    if not os.path.exists(DB_PATH):
        print(f"❌ {DB_PATH} not found. Run init-facts-db.py first.")
        return

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    if args.stats:
        total = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
        permanent = db.execute("SELECT COUNT(*) FROM facts WHERE permanent=1").fetchone()[0]
        categories = db.execute(
            "SELECT category, COUNT(*) as c FROM facts GROUP BY category ORDER BY c DESC"
        ).fetchall()
        print(f"Total facts: {total} ({permanent} permanent)")
        print("\nBy category:")
        for row in categories:
            print(f"  {row['category']}: {row['c']}")
        return

    if args.entity and args.key:
        # Exact lookup
        row = db.execute(
            "SELECT * FROM facts WHERE entity=? AND key=?",
            (args.entity, args.key)
        ).fetchone()
        if row:
            if args.json:
                print(json.dumps(dict(row)))
            else:
                print(f"{row['entity']}.{row['key']} = {row['value']}")
                print(f"  category: {row['category']} | source: {row['source']} | permanent: {bool(row['permanent'])}")
        else:
            print("No match found.")
        return

    if args.entity:
        rows = db.execute("SELECT * FROM facts WHERE entity=?", (args.entity,)).fetchall()
    elif args.category:
        rows = db.execute("SELECT * FROM facts WHERE category=?", (args.category,)).fetchall()
    elif args.query:
        rows = db.execute(
            "SELECT f.* FROM facts_fts fts JOIN facts f ON f.id = fts.rowid WHERE facts_fts MATCH ? ORDER BY fts.rank",
            (args.query,)
        ).fetchall()
    else:
        parser.print_help()
        return

    if args.json:
        print(json.dumps([dict(r) for r in rows], indent=2))
    else:
        if not rows:
            print("No results.")
            return
        for row in rows:
            perm = " 📌" if row['permanent'] else ""
            print(f"  {row['entity']}.{row['key']} = {row['value']}{perm}")

    db.close()

if __name__ == "__main__":
    main()
