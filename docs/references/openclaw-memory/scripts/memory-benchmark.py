#!/usr/bin/env python3
"""
Memory Search Benchmark for OpenClaw
=====================================
Tests recall quality of the memory search system by running queries
with known expected results and measuring top-K hit rate.

Inspired by: https://old.reddit.com/r/openclaw/comments/1r7nd4y/
              how_i_built_a_memory_system_that_actually_works/

Usage:
  python3 scripts/memory-benchmark.py                    # Run all queries
  python3 scripts/memory-benchmark.py --category PEOPLE  # Run one category
  python3 scripts/memory-benchmark.py --verbose          # Show per-query results
  python3 scripts/memory-benchmark.py --top-k 3          # Stricter (default: 6)
"""

import json
import subprocess
import sqlite3
import sys
import os
import argparse
from pathlib import Path
from datetime import datetime

# ─── Configuration ───────────────────────────────────────────────────────────

WORKSPACE = Path(os.environ.get("OPENCLAW_WORKSPACE", "/path/to/workspace"))
TOP_K_DEFAULT = 6  # Result passes if expected file appears in top K results

# ─── Benchmark Queries ───────────────────────────────────────────────────────
# Format: (query, expected_file_substring, category)
# expected_file_substring: partial path match (case-insensitive) against result paths
# A query PASSES if any result in top-K contains the expected substring

QUERIES = [
    # ── PEOPLE (10 queries) ──────────────────────────────────────────────
    ("When is Partner's birthday?", "family-contacts", "PEOPLE"),
    ("What is Mom's phone number?", "family-contacts", "PEOPLE"),
    ("Where does Daughter live?", "family-contacts", "PEOPLE"),
    ("When was Son born?", "family-contacts", "PEOPLE"),
    ("What is Sister's husband's name?", "USER.md", "PEOPLE"),
    ("Who is Friend A?", "USER.md", "PEOPLE"),
    ("Friend B email address", "USER.md", "PEOPLE"),
    ("Friend C phone number", "USER.md", "PEOPLE"),
    ("What pets does User have?", "USER.md", "PEOPLE"),
    ("Mom birthday", "family-contacts", "PEOPLE"),

    # ── TOOLS (10 queries) ───────────────────────────────────────────────
    ("Home Assistant API token", "tools-home-assistant", "TOOLS"),
    ("How many lights in Home Assistant?", "tools-home-assistant", "TOOLS"),
    ("Komodo server URL", "tools-infrastructure", "TOOLS"),
    ("Postiz URL and port", "tools-infrastructure", "TOOLS"),
    ("Wix blog publishing workflow", "tools-wix-api", "TOOLS"),
    ("n8n webhook URL", "tools-n8n", "TOOLS"),
    ("How to publish a blog post on Wix", "wix-blog", "TOOLS"),
    ("Wix image upload process", "tools-wix-api", "TOOLS"),
    ("Social media posting schedule", "tools-social-media", "TOOLS"),
    ("Ghost CMS setup", "tools-infrastructure", "TOOLS"),

    # ── PROJECTS (10 queries) ────────────────────────────────────────────
    ("What is Keystone?", "project-keystone", "PROJECTS"),
    ("Microdose Tracker tech stack", "project-microdose-tracker", "PROJECTS"),
    ("ClawSmith process model", "project-clawsmith", "PROJECTS"),
    ("Adult in Training coaching focus", "project-adult-in-training", "PROJECTS"),
    ("What port does Keystone run on?", "project-keystone", "PROJECTS"),
    ("Microdose Tracker production server IP", "project-microdose-tracker", "PROJECTS"),
    ("Content pipeline architecture", "social-media-workflow", "PROJECTS"),
    ("ClawSmith dispatcher script", "project-clawsmith", "PROJECTS"),
    ("Canva Connect API project", "project-canva-connect", "PROJECTS"),
    ("What is the BRE in Keystone?", "project-keystone", "PROJECTS"),

    # ── FACTS_DB (10 queries) ────────────────────────────────────────────
    # These test whether facts.db entities surface via memory search
    ("User's timezone", "USER.md", "FACTS"),
    ("Where is User from originally?", "USER.md", "FACTS"),
    ("What certification does User have?", "USER.md", "FACTS"),
    ("User's email address", "USER.md", "FACTS"),
    ("What is ManKind Project?", "USER.md", "FACTS"),
    ("Partner's birthplace", "family-contacts", "FACTS"),
    ("Gen Hoe Restaurant location", "USER.md", "FACTS"),
    ("What crypto does User hold?", "USER.md", "FACTS"),
    ("Lao and Thai Spicy Noodle rating", "USER.md", "FACTS"),
    ("What is User's SAP background?", "USER.md", "FACTS"),

    # ── OPERATIONAL (10 queries) ─────────────────────────────────────────
    ("What are the gating policies?", "gating-policies", "OPERATIONAL"),
    ("How to avoid config.patch disasters?", "gating-policies", "OPERATIONAL"),
    ("Current cron jobs running", "automations-cron", "OPERATIONAL"),
    ("Memory architecture layers", "ARCHITECTURE", "OPERATIONAL"),
    ("What is the heartbeat schedule?", "HEARTBEAT", "OPERATIONAL"),
    ("How does wake/sleep cycle work?", "AGENTS.md", "OPERATIONAL"),
    ("What model does Toby use?", "MEMORY.md", "OPERATIONAL"),
    ("OpenClaw systemd override settings", "active-context", "OPERATIONAL"),
    ("How to handle agent context overflow?", "gating-policies", "OPERATIONAL"),
    ("What is the cross-project analysis?", "cross-project-analysis", "OPERATIONAL"),

    # ── IDENTITY (5 queries) ─────────────────────────────────────────────
    ("Who am I?", "SOUL.md", "IDENTITY"),
    ("What are my core principles?", "SOUL.md", "IDENTITY"),
    ("What is my name?", "IDENTITY.md", "IDENTITY"),
    ("What do I care about?", "SOUL.md", "IDENTITY"),
    ("How should I communicate?", "SOUL.md", "IDENTITY"),

    # ── DAILY CONTEXT (5 queries) ────────────────────────────────────────
    ("What was the OOM crash about?", "2026-02-17", "DAILY"),
    ("When did we rename to Project Keystone?", "2026-02-16", "DAILY"),
    ("Sonnet 4.6 upgrade details", "2026-02-17", "DAILY"),
    ("BRE migration to rules engine", "2026-02-16", "DAILY"),
    ("BPMN visualization implementation", "2026-02-16", "DAILY"),
]


# ─── Memory Search via OpenClaw ──────────────────────────────────────────────

def search_memory(query: str, top_k: int = TOP_K_DEFAULT, method: str = "qmd") -> list[dict]:
    """
    Search memory using QMD or OpenClaw CLI.
    Returns list of {path, score} dicts.
    
    Methods:
      - qmd: QMD BM25 search across memory-dir + memory-root collections
      - vsearch: QMD vector similarity search
      - openclaw: openclaw memory search CLI (requires active session)
    """
    results = []

    if method in ("qmd", "vsearch"):
        search_cmd = "search" if method == "qmd" else "vsearch"
        # Search across relevant collections
        for collection in ["memory-dir", "memory-root"]:
            try:
                result = subprocess.run(
                    ["qmd", search_cmd, query, "-c", collection],
                    capture_output=True, text=True, timeout=15
                )
                if result.returncode == 0 and result.stdout.strip():
                    # Parse QMD output — format: "qmd://collection/path:line #hash\nTitle: ...\nScore: N%"
                    for block in result.stdout.split("\n\n"):
                        lines = block.strip().split("\n")
                        if not lines or not lines[0].startswith("qmd://"):
                            continue
                        # Extract path from qmd://collection/path:line
                        qmd_path = lines[0].split()[0]  # qmd://memory-dir/family-contacts.md:4
                        # Remove qmd://collection/ prefix and :line suffix
                        path_part = qmd_path.split("/", 3)[-1] if "/" in qmd_path else qmd_path
                        if ":" in path_part:
                            path_part = path_part.rsplit(":", 1)[0]
                        # Extract score
                        score = 0
                        for line in lines:
                            if line.startswith("Score:"):
                                score_str = line.split(":")[1].strip().rstrip("%")
                                try:
                                    score = int(score_str)
                                except ValueError:
                                    pass
                        # Map collection back to filesystem path
                        if collection == "memory-root":
                            full_path = f"{path_part}"
                        else:
                            full_path = f"memory/{path_part}"
                        results.append({"path": full_path, "score": score})
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass

        # Also search workspace root files (SOUL.md, USER.md, etc.)
        # These are in memory-root collection but let's also do a direct grep fallback
        # for files not in QMD collections
        root_files = ["SOUL.md", "USER.md", "AGENTS.md", "IDENTITY.md", "HEARTBEAT.md",
                       "MEMORY.md", "TOOLS.md"]
        query_lower = query.lower()
        for fname in root_files:
            fpath = WORKSPACE / fname
            if fpath.exists():
                try:
                    content = fpath.read_text(errors="ignore").lower()
                    # Simple keyword match as fallback for root files
                    words = query_lower.split()
                    matches = sum(1 for w in words if w in content)
                    if matches >= max(1, len(words) // 2):
                        # Check if already in results
                        if not any(fname.lower() in r["path"].lower() for r in results):
                            results.append({"path": fname, "score": matches * 10})
                except Exception:
                    pass

        # Sort by score descending, return top-K
        results.sort(key=lambda r: r.get("score", 0), reverse=True)
        return results[:top_k]

    elif method == "openclaw":
        try:
            result = subprocess.run(
                ["openclaw", "memory", "search", "--json", "--max-results", str(top_k), query],
                capture_output=True, text=True, timeout=30,
                cwd=str(WORKSPACE)
            )
            if result.returncode == 0 and result.stdout.strip():
                data = json.loads(result.stdout.strip())
                if isinstance(data, dict) and "results" in data:
                    return data["results"]
                elif isinstance(data, list):
                    return data
        except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
            pass

    elif method in ("graph", "hybrid"):
        import importlib.util
        spec = importlib.util.spec_from_file_location("graph_search", WORKSPACE / "scripts" / "graph-search.py")
        gs_mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gs_mod)

        db = sqlite3.connect(str(WORKSPACE / "memory" / "facts.db"))
        graph_results = gs_mod.graph_search(query, db, top_k)
        db.close()

        for r in graph_results:
            results.append({"path": r.get("path", "facts.db"), "score": r.get("score", 50)})

        if method == "hybrid":
            # Also run QMD BM25 and merge
            qmd_results = search_memory(query, top_k, method="qmd")
            existing_paths = {r["path"].lower() for r in results}
            for qr in qmd_results:
                if qr["path"].lower() not in existing_paths:
                    results.append(qr)

        results.sort(key=lambda r: r.get("score", 0), reverse=True)
        return results[:top_k]

    return results


def check_hit(results: list[dict], expected: str) -> bool:
    """Check if expected file substring appears in any result path."""
    expected_lower = expected.lower()
    for r in results:
        path = r.get("path", r.get("file", r.get("filePath", "")))
        if expected_lower in path.lower():
            return True
    return False


def get_result_paths(results: list[dict]) -> list[str]:
    """Extract file paths from results for display."""
    paths = []
    for r in results:
        path = r.get("path", r.get("file", r.get("filePath", "unknown")))
        # Shorten path for display
        if "/clawd/" in path:
            path = path.split("/clawd/")[-1]
        paths.append(path)
    return paths


# ─── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Memory Search Benchmark")
    parser.add_argument("--category", "-c", help="Run only this category")
    parser.add_argument("--verbose", "-v", action="store_true", help="Show per-query details")
    parser.add_argument("--top-k", "-k", type=int, default=TOP_K_DEFAULT, help=f"Top-K threshold (default: {TOP_K_DEFAULT})")
    parser.add_argument("--method", "-m", choices=["qmd", "vsearch", "openclaw", "graph", "hybrid"], default="qmd",
                        help="Search method (default: qmd). 'hybrid' = graph + qmd combined")
    parser.add_argument("--output", "-o", help="Save results to JSON file")
    args = parser.parse_args()

    categories = {}
    total_pass = 0
    total_fail = 0
    total_error = 0
    results_log = []

    queries = QUERIES
    if args.category:
        queries = [q for q in QUERIES if q[2].upper() == args.category.upper()]
        if not queries:
            valid = sorted(set(q[2] for q in QUERIES))
            print(f"Unknown category '{args.category}'. Valid: {', '.join(valid)}")
            sys.exit(1)

    print(f"╔══════════════════════════════════════════════════════════════╗")
    print(f"║  Memory Search Benchmark — {len(queries)} queries, top-{args.top_k}             ║")
    print(f"║  Method: {args.method:52s} ║")
    print(f"║  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}                                    ║")
    print(f"╚══════════════════════════════════════════════════════════════╝")
    print()

    for i, (query, expected, category) in enumerate(queries, 1):
        results = search_memory(query, args.top_k, method=args.method)
        hit = check_hit(results, expected) if results else False
        paths = get_result_paths(results)

        status = "✅" if hit else ("⚠️" if not results else "❌")

        if category not in categories:
            categories[category] = {"pass": 0, "fail": 0, "error": 0, "total": 0}
        categories[category]["total"] += 1

        if not results:
            total_error += 1
            categories[category]["error"] += 1
        elif hit:
            total_pass += 1
            categories[category]["pass"] += 1
        else:
            total_fail += 1
            categories[category]["fail"] += 1

        entry = {
            "query": query,
            "expected": expected,
            "category": category,
            "hit": hit,
            "results_count": len(results),
            "result_paths": paths,
        }
        results_log.append(entry)

        if args.verbose:
            print(f"  {status} [{category:11s}] {query}")
            if not hit:
                print(f"     Expected: {expected}")
                print(f"     Got: {paths[:3]}")
            print()
        else:
            # Progress indicator
            sys.stdout.write(f"\r  Running... {i}/{len(queries)}")
            sys.stdout.flush()

    if not args.verbose:
        print()  # newline after progress

    # ── Summary ──────────────────────────────────────────────────────────
    total = total_pass + total_fail + total_error
    pct = (total_pass / total * 100) if total > 0 else 0

    print()
    print(f"  ┌─────────────────┬───────┬───────────┐")
    print(f"  │ Category        │ Score │ Pct       │")
    print(f"  ├─────────────────┼───────┼───────────┤")
    for cat in sorted(categories.keys()):
        c = categories[cat]
        cat_pct = (c["pass"] / c["total"] * 100) if c["total"] > 0 else 0
        err = f" ({c['error']}⚠)" if c["error"] > 0 else ""
        print(f"  │ {cat:15s} │ {c['pass']:2d}/{c['total']:2d}  │ {cat_pct:5.1f}%{err:4s} │")
    print(f"  ├─────────────────┼───────┼───────────┤")
    print(f"  │ {'TOTAL':15s} │ {total_pass:2d}/{total:2d}  │ {pct:5.1f}%     │")
    print(f"  └─────────────────┴───────┴───────────┘")

    if total_error > 0:
        print(f"\n  ⚠️  {total_error} queries returned no results (search backend issue?)")

    # ── Failed queries ───────────────────────────────────────────────────
    failures = [r for r in results_log if not r["hit"] and r["results_count"] > 0]
    if failures and not args.verbose:
        print(f"\n  ❌ Failed queries ({len(failures)}):")
        for f in failures:
            print(f"     • {f['query']}")
            print(f"       Expected: {f['expected']} → Got: {f['result_paths'][:3]}")

    # ── Save results ─────────────────────────────────────────────────────
    if args.output:
        out = {
            "timestamp": datetime.now().isoformat(),
            "config": {"top_k": args.top_k, "total_queries": len(queries)},
            "summary": {
                "total": total,
                "pass": total_pass,
                "fail": total_fail,
                "error": total_error,
                "recall_pct": round(pct, 1),
            },
            "categories": categories,
            "queries": results_log,
        }
        Path(args.output).write_text(json.dumps(out, indent=2))
        print(f"\n  📄 Results saved to {args.output}")

    print()
    return 0 if pct >= 80 else 1


if __name__ == "__main__":
    sys.exit(main())
