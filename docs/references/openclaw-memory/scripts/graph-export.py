#!/usr/bin/env python3
"""Export knowledge graph from facts.db to JSON for the viewer."""

import sqlite3
import json
from pathlib import Path
from collections import defaultdict

DB_PATH = Path("/path/to/workspace/memory/facts.db")
OUT_PATH = Path("/path/to/workspace/memory/graph-data.json")

def main():
    db = sqlite3.connect(str(DB_PATH))
    
    # Get all entities from facts + relations
    entities = set()
    categories = {}
    
    # From facts
    for row in db.execute("SELECT DISTINCT entity, category FROM facts").fetchall():
        entities.add(row[0])
        categories[row[0]] = row[1]
    
    # From relations (subjects and objects that are also subjects)
    for row in db.execute("SELECT DISTINCT subject FROM relations").fetchall():
        entities.add(row[0])
    for row in db.execute("SELECT DISTINCT object FROM relations WHERE object IN (SELECT DISTINCT entity FROM facts UNION SELECT DISTINCT subject FROM relations)").fetchall():
        entities.add(row[0])
    
    # Build nodes
    nodes = []
    for entity in sorted(entities):
        cat = categories.get(entity, "other")
        nodes.append({"id": entity, "category": cat})
    
    # Build edges from relations
    edges = []
    entity_set = entities
    for row in db.execute("SELECT subject, predicate, object FROM relations").fetchall():
        subj, pred, obj = row
        # Only include edges where both endpoints are known entities
        if subj in entity_set and obj in entity_set:
            edges.append({"source": subj, "target": obj, "predicate": pred})
        elif subj in entity_set:
            # Object is a value, not an entity — skip for graph viz
            pass
    
    # Build facts per entity
    facts = defaultdict(list)
    for row in db.execute("SELECT entity, key, value FROM facts ORDER BY entity, key").fetchall():
        facts[row[0]].append({"key": row[1], "value": row[2]})
    
    data = {
        "nodes": nodes,
        "edges": edges,
        "facts": dict(facts),
        "stats": {
            "entities": len(nodes),
            "relations": len(edges),
            "facts": sum(len(v) for v in facts.values()),
            "aliases": db.execute("SELECT COUNT(*) FROM aliases").fetchone()[0],
        }
    }
    
    OUT_PATH.write_text(json.dumps(data, indent=2))
    print(f"✅ Exported: {len(nodes)} nodes, {len(edges)} edges, {sum(len(v) for v in facts.values())} facts")
    print(f"   → {OUT_PATH}")
    
    db.close()

if __name__ == "__main__":
    main()
