#!/usr/bin/env python3
"""
Auto-extract facts, relations, and aliases from daily journal files
and other unindexed memory files into the knowledge graph (facts.db).

Extraction strategies:
1. Tagged entries: [milestone|i=0.9], [decision|i=0.8], etc. → event entities
2. Structured data: URLs, ports, credentials, tool names → facts
3. Relationships: "deployed X on Y", "uses Z", "switched to W" → relations
4. Named entities: project names, tools, people → aliases

Usage:
  python3 scripts/graph-ingest-daily.py                    # Process all unindexed files
  python3 scripts/graph-ingest-daily.py --dry-run           # Show what would be added
  python3 scripts/graph-ingest-daily.py --file memory/2026-02-18.md  # Process one file
  python3 scripts/graph-ingest-daily.py --stats             # Show current graph stats
"""

import sqlite3
import re
import sys
import argparse
import json
from pathlib import Path
from datetime import datetime

DB_PATH = Path("/path/to/workspace/memory/facts.db")
MEMORY_DIR = Path("/path/to/workspace/memory")

# ─── Pattern definitions ───────────────────────────────────────────

# Tagged entries: ## Section Header [tag|i=0.X]
TAGGED_ENTRY_RE = re.compile(
    r'^##\s+(.+?)\s+\[(\w+)\|i=([\d.]+)\]\s*$', re.MULTILINE
)

# URLs with context
URL_RE = re.compile(r'(?:https?://[^\s\)>\]]+)')

# Port assignments: port XXXX, :XXXX, runs on port
PORT_RE = re.compile(r'(?:port|:)\s*(\d{4,5})\b')

# Key-value patterns from bullet points: **Key**: Value or - **Key** — Value
KV_BULLET_RE = re.compile(r'^\s*[-*]\s+\*\*(.+?)\*\*[:\s—]+(.+)$', re.MULTILINE)

# Technology/tool mentions
TECH_PATTERNS = {
    'Next.js': ['Next.js', 'next.js', 'nextjs'],
    'PostgreSQL': ['PostgreSQL', 'postgres', 'Postgres'],
    'SQLite': ['SQLite', 'sqlite'],
    'Docker': ['Docker', 'docker'],
    'Caddy': ['Caddy', 'caddy'],
    'Traefik': ['Traefik', 'traefik'],
    'XState': ['XState', 'xstate'],
    'Ghost': ['Ghost CMS', 'Ghost 5'],
    'Ollama': ['Ollama', 'ollama'],
    'Komodo': ['Komodo'],
    'Postiz': ['Postiz'],
    'Wix': ['Wix API', 'Wix'],
    'OpenClaw': ['OpenClaw', 'openclaw', 'clawdbot'],
    'ClawSmith': ['ClawSmith', 'clawsmith'],
    'React': ['React', 'react'],
    'Python': ['Python', 'python3'],
    'Swift': ['Swift', 'SwiftUI'],
    'Drizzle': ['Drizzle ORM', 'Drizzle'],
    'Tailscale': ['Tailscale', 'tailscale'],
    'fail2ban': ['fail2ban'],
    'n8n': ['n8n'],
    'Figma': ['Figma', 'figma'],
    'ElevenLabs': ['ElevenLabs'],
    'Canva': ['Canva'],
    'CalDAV': ['CalDAV', 'vdirsyncer', 'khal'],
}

# Known project names for relation extraction
PROJECT_NAMES = {
    'Adult in Training', 'Microdose Tracker', 'ClawSmith', 'Project Keystone',
    'Keystone', 'Content Pipeline', 'Memory Architecture', 'ClawForge',
}

# Agent names
AGENT_NAMES = {
    'Gandalf', 'Toby', 'Pete', 'Pixel', 'Ram Dass', 'Social Steven',
    'Ernest', 'Beta-tester', 'DevOps',
}

# Infrastructure entities
INFRA_NAMES = {
    'aiserver', 'Home Assistant', 'Postiz', 'Komodo', 'Ghost', 'Ollama',
    'n8n', 'Traefik', 'Tailscale', 'Docker', 'Caddy',
}


def get_indexed_sources(db: sqlite3.Connection) -> set:
    """Get all source files already in the graph"""
    facts_sources = set(
        r[0] for r in db.execute(
            "SELECT DISTINCT source FROM facts WHERE source IS NOT NULL"
        ).fetchall()
    )
    rel_sources = set(
        r[0] for r in db.execute(
            "SELECT DISTINCT source FROM relations WHERE source IS NOT NULL"
        ).fetchall()
    )
    return facts_sources | rel_sources


def parse_tagged_entries(content: str, source_file: str) -> list:
    """Extract tagged journal entries as event entities"""
    results = {'facts': [], 'relations': [], 'aliases': []}
    
    # Find all tagged headers
    for match in TAGGED_ENTRY_RE.finditer(content):
        title = match.group(1).strip()
        tag = match.group(2)  # milestone, decision, lesson, task, context
        importance = float(match.group(3))
        
        # Skip low-importance context entries
        if importance < 0.4:
            continue
        
        # Create an event entity name from the title
        # Shorten long titles
        entity_name = title[:80] if len(title) > 80 else title
        
        # Extract the section content (until next ## or end)
        start = match.end()
        next_section = re.search(r'^##\s', content[start:], re.MULTILINE)
        section_end = start + next_section.start() if next_section else len(content)
        section_content = content[start:section_end].strip()
        
        # Extract date from filename
        date_match = re.search(r'(\d{4}-\d{2}-\d{2})', source_file)
        date_str = date_match.group(1) if date_match else 'unknown'
        
        # Create fact for the event
        results['facts'].append({
            'entity': entity_name,
            'key': 'type',
            'value': tag,
            'source': source_file,
        })
        results['facts'].append({
            'entity': entity_name,
            'key': 'date',
            'value': date_str,
            'source': source_file,
        })
        results['facts'].append({
            'entity': entity_name,
            'key': 'importance',
            'value': str(importance),
            'source': source_file,
        })
        
        # Extract a summary (first non-empty line of content)
        summary_lines = [l.strip('- ').strip() for l in section_content.split('\n') 
                        if l.strip() and not l.strip().startswith('#')]
        if summary_lines:
            summary = summary_lines[0][:200]
            results['facts'].append({
                'entity': entity_name,
                'key': 'summary',
                'value': summary,
                'source': source_file,
            })
        
        # Extract URLs mentioned in the section
        urls = URL_RE.findall(section_content)
        for url in urls[:3]:  # Max 3 URLs per section
            results['facts'].append({
                'entity': entity_name,
                'key': 'url',
                'value': url,
                'source': source_file,
            })
        
        # Detect project references and create relations
        for proj in PROJECT_NAMES:
            if proj.lower() in section_content.lower() or proj.lower() in title.lower():
                results['relations'].append({
                    'subject': entity_name,
                    'predicate': 'related_to',
                    'object': proj,
                    'source': source_file,
                })
        
        # Detect technology mentions and create relations
        for tech, patterns in TECH_PATTERNS.items():
            for pat in patterns:
                if pat in section_content or pat in title:
                    results['relations'].append({
                        'subject': entity_name,
                        'predicate': 'involves',
                        'object': tech,
                        'source': source_file,
                    })
                    break
        
        # Detect agent mentions
        for agent in AGENT_NAMES:
            if agent.lower() in section_content.lower():
                results['relations'].append({
                    'subject': entity_name,
                    'predicate': 'involves_agent',
                    'object': agent,
                    'source': source_file,
                })
    
    return results


def parse_structured_data(content: str, source_file: str) -> dict:
    """Extract structured key-value data from bullet points"""
    results = {'facts': [], 'relations': [], 'aliases': []}
    
    # Extract key-value pairs from bullets
    for match in KV_BULLET_RE.finditer(content):
        key = match.group(1).strip()
        value = match.group(2).strip()
        
        # Skip very long values (probably descriptions, not facts)
        if len(value) > 300:
            continue
        
        # Detect specific patterns
        key_lower = key.lower()
        
        # URL/endpoint detection
        if any(k in key_lower for k in ['url', 'endpoint', 'link', 'domain', 'site']):
            url_match = URL_RE.search(value)
            if url_match:
                # Try to find parent section as entity
                entity = _find_parent_section(content, match.start())
                if entity:
                    results['facts'].append({
                        'entity': entity,
                        'key': key_lower.replace(' ', '_'),
                        'value': url_match.group(0),
                        'source': source_file,
                    })
        
        # Port detection
        if 'port' in key_lower or 'port' in value.lower():
            port_match = PORT_RE.search(value)
            if port_match:
                entity = _find_parent_section(content, match.start())
                if entity:
                    results['facts'].append({
                        'entity': entity,
                        'key': 'port',
                        'value': port_match.group(1),
                        'source': source_file,
                    })
        
        # Status detection
        if any(k in key_lower for k in ['status', 'state', 'result']):
            entity = _find_parent_section(content, match.start())
            if entity:
                results['facts'].append({
                    'entity': entity,
                    'key': 'status',
                    'value': value[:100],
                    'source': source_file,
                })
        
        # Cron job IDs
        if 'cron' in key_lower or 'job id' in key_lower:
            entity = _find_parent_section(content, match.start())
            if entity:
                results['facts'].append({
                    'entity': entity,
                    'key': 'cron_job_id',
                    'value': value[:100],
                    'source': source_file,
                })
    
    return results


def parse_untagged_sections(content: str, source_file: str) -> dict:
    """Extract facts from ## sections that don't have tags (older daily files)"""
    results = {'facts': [], 'relations': [], 'aliases': []}
    
    # Find ## headers without tags
    untagged_re = re.compile(r'^##\s+(.+?)(?:\s+\[.*\])?\s*$', re.MULTILINE)
    
    date_match = re.search(r'(\d{4}-\d{2}-\d{2})', source_file)
    date_str = date_match.group(1) if date_match else 'unknown'
    
    for match in untagged_re.finditer(content):
        title = match.group(1).strip()
        
        # Skip if it's a tagged entry (already handled)
        if TAGGED_ENTRY_RE.match(match.group(0).strip()):
            continue
        
        # Skip generic headers
        skip_headers = {'conversation summary', 'key dates', 'home', 'quick checks',
                       'rules', 'notes', 'summary', 'context'}
        if title.lower() in skip_headers:
            continue
        
        # Get section content
        start = match.end()
        next_section = re.search(r'^##\s', content[start:], re.MULTILINE)
        section_end = start + next_section.start() if next_section else len(content)
        section_content = content[start:section_end].strip()
        
        # Only create entities for sections with substance (>50 chars)
        if len(section_content) < 50:
            continue
        
        entity_name = title[:80]
        
        # Create event fact
        results['facts'].append({
            'entity': entity_name,
            'key': 'type',
            'value': 'event',
            'source': source_file,
        })
        results['facts'].append({
            'entity': entity_name,
            'key': 'date',
            'value': date_str,
            'source': source_file,
        })
        
        # Extract first meaningful line as summary
        summary_lines = [l.strip('- ').strip() for l in section_content.split('\n')
                        if l.strip() and not l.strip().startswith('#') 
                        and not l.strip().startswith('|')]
        if summary_lines:
            summary = summary_lines[0][:200]
            results['facts'].append({
                'entity': entity_name,
                'key': 'summary',
                'value': summary,
                'source': source_file,
            })
        
        # Detect project/tech/agent relations (same as tagged)
        for proj in PROJECT_NAMES:
            if proj.lower() in section_content.lower() or proj.lower() in title.lower():
                results['relations'].append({
                    'subject': entity_name,
                    'predicate': 'related_to',
                    'object': proj,
                    'source': source_file,
                })
        
        for tech, patterns in TECH_PATTERNS.items():
            for pat in patterns:
                if pat in section_content or pat in title:
                    results['relations'].append({
                        'subject': entity_name,
                        'predicate': 'involves',
                        'object': tech,
                        'source': source_file,
                    })
                    break
        
        for agent in AGENT_NAMES:
            if agent.lower() in section_content.lower():
                results['relations'].append({
                    'subject': entity_name,
                    'predicate': 'involves_agent',
                    'object': agent,
                    'source': source_file,
                })
    
    return results


def _find_parent_section(content: str, pos: int) -> str | None:
    """Find the nearest ## header above a position"""
    before = content[:pos]
    headers = re.findall(r'^##\s+(.+?)(?:\s+\[.*\])?\s*$', before, re.MULTILINE)
    if headers:
        return headers[-1].strip()[:80]
    # Try # header
    headers = re.findall(r'^#\s+(.+)$', before, re.MULTILINE)
    if headers:
        return headers[-1].strip()[:80]
    return None


def merge_results(*result_dicts) -> dict:
    """Merge multiple extraction results, deduplicating"""
    merged = {'facts': [], 'relations': [], 'aliases': []}
    seen_facts = set()
    seen_relations = set()
    seen_aliases = set()
    
    for r in result_dicts:
        for f in r.get('facts', []):
            key = (f['entity'], f['key'], f['value'])
            if key not in seen_facts:
                seen_facts.add(key)
                merged['facts'].append(f)
        
        for rel in r.get('relations', []):
            key = (rel['subject'], rel['predicate'], rel['object'])
            if key not in seen_relations:
                seen_relations.add(key)
                merged['relations'].append(rel)
        
        for a in r.get('aliases', []):
            key = (a['alias'], a['entity'])
            if key not in seen_aliases:
                seen_aliases.add(key)
                merged['aliases'].append(a)
    
    return merged


def process_file(filepath: Path, source_name: str) -> dict:
    """Process a single file and return extracted graph data"""
    try:
        content = filepath.read_text(encoding='utf-8')
    except UnicodeDecodeError:
        content = filepath.read_text(encoding='utf-8', errors='replace')
    
    tagged = parse_tagged_entries(content, source_name)
    structured = parse_structured_data(content, source_name)
    untagged = parse_untagged_sections(content, source_name)
    
    return merge_results(tagged, structured, untagged)


def _infer_category(entity: str, key: str, value: str) -> str:
    """Infer a category for a fact based on entity/key/value content"""
    entity_lower = entity.lower()
    key_lower = key.lower()
    value_lower = value.lower()
    
    # Check for known patterns
    if any(p in entity_lower for p in ['seo', 'blog', 'post', 'content', 'social media', 'pipeline']):
        return 'event'
    if any(p in entity_lower for p in ['clawsmith', 'keystone', 'microdose', 'adult in training', 'clawforge']):
        return 'project'
    if key_lower in ('birthday', 'phone', 'email', 'address', 'birthplace'):
        return 'contact'
    if key_lower in ('port', 'url', 'endpoint', 'runs_on', 'stack', 'cron_job_id'):
        return 'infrastructure'
    if key_lower == 'status':
        return 'event'
    if key_lower == 'type' and value_lower in ('milestone', 'decision', 'lesson', 'task', 'context', 'event'):
        return 'event'
    if key_lower in ('date', 'importance', 'summary'):
        return 'event'
    if any(p in entity_lower for p in ['decision', 'lesson', 'config', 'bug', 'fix']):
        return 'decision'
    if any(p in entity_lower for p in ['deploy', 'server', 'docker', 'port', 'gpu', 'browser', 'ollama']):
        return 'infrastructure'
    if any(p in entity_lower for p in ['agent', 'toby', 'pete', 'pixel', 'gandalf', 'ram dass', 'ernest', 'devops']):
        return 'identity'
    
    return 'event'  # Default for daily journal entries


def insert_results(db: sqlite3.Connection, results: dict, dry_run: bool = False) -> dict:
    """Insert extracted data into the database. Returns counts."""
    counts = {'facts_new': 0, 'facts_skip': 0, 'relations_new': 0, 
              'relations_skip': 0, 'aliases_new': 0, 'aliases_skip': 0}
    
    for f in results['facts']:
        category = _infer_category(f['entity'], f['key'], f['value'])
        if dry_run:
            existing = db.execute(
                "SELECT 1 FROM facts WHERE entity=? AND key=? AND value=?",
                (f['entity'], f['key'], f['value'])
            ).fetchone()
            if existing:
                counts['facts_skip'] += 1
            else:
                counts['facts_new'] += 1
        else:
            try:
                cur = db.execute(
                    "INSERT OR IGNORE INTO facts (entity, key, value, category, source) VALUES (?, ?, ?, ?, ?)",
                    (f['entity'], f['key'], f['value'], category, f['source'])
                )
                if cur.rowcount > 0:
                    # Also insert into FTS
                    db.execute(
                        "INSERT INTO facts_fts(rowid, entity, key, value) VALUES (?, ?, ?, ?)",
                        (cur.lastrowid, f['entity'], f['key'], f['value'])
                    )
                    counts['facts_new'] += 1
                else:
                    counts['facts_skip'] += 1
            except sqlite3.IntegrityError:
                counts['facts_skip'] += 1
    
    for r in results['relations']:
        if dry_run:
            existing = db.execute(
                "SELECT 1 FROM relations WHERE subject=? AND predicate=? AND object=?",
                (r['subject'], r['predicate'], r['object'])
            ).fetchone()
            if existing:
                counts['relations_skip'] += 1
            else:
                counts['relations_new'] += 1
        else:
            try:
                db.execute(
                    "INSERT OR IGNORE INTO relations (subject, predicate, object, source) VALUES (?, ?, ?, ?)",
                    (r['subject'], r['predicate'], r['object'], r['source'])
                )
                counts['relations_new'] += 1
            except sqlite3.IntegrityError:
                counts['relations_skip'] += 1
    
    for a in results['aliases']:
        if dry_run:
            existing = db.execute(
                "SELECT 1 FROM aliases WHERE alias=? AND entity=?",
                (a['alias'], a['entity'])
            ).fetchone()
            if existing:
                counts['aliases_skip'] += 1
            else:
                counts['aliases_new'] += 1
        else:
            try:
                db.execute(
                    "INSERT OR IGNORE INTO aliases (alias, entity) VALUES (?, ?)",
                    (a['alias'], a['entity'])
                )
                counts['aliases_new'] += 1
            except sqlite3.IntegrityError:
                counts['aliases_skip'] += 1
    
    if not dry_run:
        db.commit()
    
    return counts


def get_unindexed_files(db: sqlite3.Connection) -> list[Path]:
    """Find memory files not yet indexed in the graph"""
    indexed = get_indexed_sources(db)
    
    all_files = sorted(MEMORY_DIR.glob('*.md'))
    unindexed = []
    
    for f in all_files:
        basename = f.name
        stem = f.stem
        
        # Check various ways it might be referenced in sources
        is_indexed = any(
            basename in s or stem in s 
            for s in indexed
        )
        
        if not is_indexed:
            unindexed.append(f)
    
    return unindexed


def print_stats(db: sqlite3.Connection):
    """Print current graph statistics"""
    facts_count = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    rels_count = db.execute("SELECT COUNT(*) FROM relations").fetchone()[0]
    aliases_count = db.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
    
    entities = db.execute("SELECT COUNT(DISTINCT entity) FROM facts").fetchone()[0]
    sources = db.execute(
        "SELECT DISTINCT source FROM facts WHERE source IS NOT NULL "
        "UNION SELECT DISTINCT source FROM relations WHERE source IS NOT NULL"
    ).fetchall()
    
    print(f"📊 Knowledge Graph Stats")
    print(f"   Facts:     {facts_count}")
    print(f"   Relations: {rels_count}")
    print(f"   Aliases:   {aliases_count}")
    print(f"   Entities:  {entities}")
    print(f"   Sources:   {len(sources)}")
    print()
    
    # Top entities by fact count
    print("   Top entities:")
    for r in db.execute(
        "SELECT entity, COUNT(*) c FROM facts GROUP BY entity ORDER BY c DESC LIMIT 10"
    ).fetchall():
        print(f"     {r[0]}: {r[1]} facts")
    
    # Unindexed files
    unindexed = get_unindexed_files(db)
    print(f"\n   Unindexed memory files: {len(unindexed)}")
    for f in unindexed[:10]:
        print(f"     ❌ {f.name}")
    if len(unindexed) > 10:
        print(f"     ... and {len(unindexed) - 10} more")


def main():
    parser = argparse.ArgumentParser(description="Ingest daily files into knowledge graph")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be added")
    parser.add_argument("--file", type=str, help="Process a specific file")
    parser.add_argument("--stats", action="store_true", help="Show graph statistics")
    parser.add_argument("--all", action="store_true", help="Process ALL unindexed files (not just daily)")
    args = parser.parse_args()
    
    db = sqlite3.connect(str(DB_PATH))
    db.execute("PRAGMA journal_mode=WAL")
    
    if args.stats:
        print_stats(db)
        db.close()
        return
    
    # Snapshot counts before
    before_facts = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    before_rels = db.execute("SELECT COUNT(*) FROM relations").fetchone()[0]
    before_aliases = db.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
    
    if args.file:
        filepath = Path(args.file)
        if not filepath.is_absolute():
            filepath = Path("/path/to/workspace") / filepath
        if not filepath.exists():
            print(f"❌ File not found: {filepath}")
            sys.exit(1)
        files_to_process = [filepath]
    else:
        files_to_process = get_unindexed_files(db)
        if not args.all:
            # By default, only process daily files (YYYY-MM-DD*.md pattern)
            files_to_process = [
                f for f in files_to_process 
                if re.match(r'\d{4}-\d{2}-\d{2}', f.stem)
            ]
    
    if not files_to_process:
        print("✅ All files already indexed!")
        db.close()
        return
    
    print(f"{'🔍 DRY RUN — ' if args.dry_run else ''}Processing {len(files_to_process)} files...\n")
    
    total_counts = {'facts_new': 0, 'facts_skip': 0, 'relations_new': 0,
                    'relations_skip': 0, 'aliases_new': 0, 'aliases_skip': 0}
    
    for filepath in sorted(files_to_process):
        source_name = filepath.name
        results = process_file(filepath, source_name)
        
        total_items = len(results['facts']) + len(results['relations']) + len(results['aliases'])
        if total_items == 0:
            continue
        
        counts = insert_results(db, results, dry_run=args.dry_run)
        
        # Accumulate
        for k in total_counts:
            total_counts[k] += counts[k]
        
        new_items = counts['facts_new'] + counts['relations_new'] + counts['aliases_new']
        if new_items > 0 or args.dry_run:
            print(f"  📄 {source_name}: +{counts['facts_new']}f +{counts['relations_new']}r +{counts['aliases_new']}a")
    
    # Summary
    print(f"\n{'═' * 50}")
    prefix = "Would add" if args.dry_run else "Added"
    print(f"  {prefix}: {total_counts['facts_new']} facts, {total_counts['relations_new']} relations, {total_counts['aliases_new']} aliases")
    
    if not args.dry_run:
        after_facts = db.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
        after_rels = db.execute("SELECT COUNT(*) FROM relations").fetchone()[0]
        after_aliases = db.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
        print(f"  Graph: {after_facts} facts ({after_facts - before_facts:+d}), "
              f"{after_rels} relations ({after_rels - before_rels:+d}), "
              f"{after_aliases} aliases ({after_aliases - before_aliases:+d})")
    
    db.close()


if __name__ == "__main__":
    main()
