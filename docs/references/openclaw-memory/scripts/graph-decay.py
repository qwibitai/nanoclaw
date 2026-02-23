#!/usr/bin/env python3
"""
graph-decay.py — Daily activation decay for the facts graph memory.

Facts that haven't been accessed recently lose "heat" over time, so
frequently-used facts stay prominent and stale ones fade.

Decay model:
  - Decay is applied to a computed `activation` score (not stored permanently).
  - We track a `decay_score` column (added if missing) = float 0.0–1.0.
  - Each day, decay_score *= DECAY_RATE (default 0.95).
  - When a fact is accessed, decay_score is reset to 1.0.
  - Permanent facts are exempt from decay.

Run: python3 ~/clawd/scripts/graph-decay.py
"""

import sqlite3
from pathlib import Path
from datetime import datetime, timezone

DB_PATH = Path.home() / "clawd/memory/facts.db"
DECAY_RATE = 0.95          # per-day multiplier (5% decay/day)
FLOOR = 0.01               # minimum score before a fact is considered "cold"
COLD_THRESHOLD = 0.10      # score below which fact is flagged as cold

def ensure_decay_column(db: sqlite3.Connection):
    """Add decay_score column if it doesn't exist yet."""
    cols = [c[1] for c in db.execute("PRAGMA table_info(facts)").fetchall()]
    if "decay_score" not in cols:
        db.execute("ALTER TABLE facts ADD COLUMN decay_score REAL DEFAULT 1.0")
        db.commit()
        return True
    return False

def run_decay(db: sqlite3.Connection):
    """Apply daily decay to all non-permanent facts."""
    # Initialize any NULLs to 1.0 first
    db.execute("""
        UPDATE facts
        SET decay_score = 1.0
        WHERE decay_score IS NULL AND permanent = 0
    """)

    # Apply decay
    db.execute(f"""
        UPDATE facts
        SET decay_score = MAX({FLOOR}, decay_score * {DECAY_RATE})
        WHERE permanent = 0 OR permanent IS NULL
    """)
    db.commit()

def get_stats(db: sqlite3.Connection):
    total = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    permanent = db.execute("SELECT COUNT(*) FROM facts WHERE permanent = 1").fetchone()[0]
    decayed = db.execute("SELECT COUNT(*) FROM facts WHERE permanent = 0").fetchone()[0]
    cold = db.execute(
        f"SELECT COUNT(*) FROM facts WHERE permanent = 0 AND decay_score < {COLD_THRESHOLD}"
    ).fetchone()[0]
    avg_score = db.execute(
        "SELECT AVG(decay_score) FROM facts WHERE permanent = 0"
    ).fetchone()[0] or 0.0
    min_score = db.execute(
        "SELECT MIN(decay_score) FROM facts WHERE permanent = 0"
    ).fetchone()[0] or 0.0
    hot = db.execute(
        "SELECT COUNT(*) FROM facts WHERE permanent = 0 AND decay_score >= 0.90"
    ).fetchone()[0]

    # Top cold facts
    cold_facts = db.execute(f"""
        SELECT entity, key, decay_score, last_accessed
        FROM facts WHERE permanent = 0 AND decay_score < {COLD_THRESHOLD}
        ORDER BY decay_score ASC LIMIT 5
    """).fetchall()

    return {
        "total": total,
        "permanent": permanent,
        "decayed": decayed,
        "cold": cold,
        "hot": hot,
        "avg_score": avg_score,
        "min_score": min_score,
        "cold_facts": cold_facts,
    }

def main():
    if not DB_PATH.exists():
        print(f"ERROR: facts.db not found at {DB_PATH}")
        return 1

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row

    added_col = ensure_decay_column(db)
    if added_col:
        print("  [init] Added decay_score column to facts table")

    run_decay(db)
    stats = get_stats(db)
    db.close()

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"Graph decay run @ {now}")
    print(f"  Facts total:     {stats['total']}")
    print(f"  Permanent:       {stats['permanent']} (exempt from decay)")
    print(f"  Decayed:         {stats['decayed']} (×{DECAY_RATE}/day)")
    print(f"  Hot (≥0.90):     {stats['hot']}")
    print(f"  Cold (<{COLD_THRESHOLD}):      {stats['cold']}")
    print(f"  Avg score:       {stats['avg_score']:.3f}")
    print(f"  Min score:       {stats['min_score']:.3f}")

    if stats["cold_facts"]:
        print(f"  Coldest facts:")
        for f in stats["cold_facts"]:
            accessed = f[3] or "never"
            print(f"    - {f[0]}.{f[1]} = {f[2]:.3f} (last: {accessed})")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
