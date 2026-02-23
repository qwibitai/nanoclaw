#!/usr/bin/env python3
"""
Graph-augmented memory search.
Combines: alias resolution → facts.db → relations → FTS → source file mapping

Usage:
  python3 scripts/graph-search.py "When is someone's birthday?"
  python3 scripts/graph-search.py "What runs on aiserver?" --json
  python3 scripts/graph-search.py "Mama's phone number"
"""

import sqlite3
import json
import re
import sys
import argparse
from pathlib import Path

DB_PATH = Path("/home/coolmann/.openclaw/data/facts.db")


def resolve_entity(db: sqlite3.Connection, name: str) -> str | None:
    """Resolve alias to canonical entity name"""
    try:
        row = db.execute("SELECT entity FROM aliases WHERE alias = ? COLLATE NOCASE", (name,)).fetchone()
        if row:
            return row[0]
    except sqlite3.OperationalError:
        pass  # aliases table may not exist
    row = db.execute("SELECT DISTINCT entity FROM facts WHERE entity = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row[0]
    return None


def extract_entity_candidates(query: str) -> list[str]:
    """Extract potential entity names from a natural language query"""
    # Known entity patterns (capitalize words, check 1-3 word combos)
    words = query.split()
    candidates = []
    
    # Single capitalized words
    for w in words:
        clean = re.sub(r'[^\w]', '', w)
        if clean and clean[0].isupper() and len(clean) > 1:
            candidates.append(clean)
    
    # Two-word combos (e.g., "Jim Gardner", "Home Assistant")
    for i in range(len(words) - 1):
        w1 = re.sub(r'[^\w]', '', words[i])
        w2 = re.sub(r'[^\w]', '', words[i + 1])
        if w1 and w2 and w1[0].isupper():
            candidates.append(f"{w1} {w2}")
    
    # Three-word combos (e.g., "Dan Verakis", "Adult in Training", "Microdose Tracker")
    for i in range(len(words) - 2):
        w1 = re.sub(r'[^\w]', '', words[i])
        w2 = re.sub(r'[^\w]', '', words[i + 1])
        w3 = re.sub(r'[^\w]', '', words[i + 2])
        if w1 and w2 and w3:
            candidates.append(f"{w1} {w2} {w3}")
    
    # Also try common lowercase aliases (word-boundary matching to avoid "flo" in "overflow")
    lower_aliases = ["mama", "jojo", "flo", "aiserver", "homelab", "n8n", "keystone",
                     "clawsmith", "postiz", "komodo", "ghost", "ollama", "mdt", "ait",
                     "the server", "ha"]
    query_lower = query.lower()
    for alias in lower_aliases:
        if " " in alias:
            if alias in query_lower:
                candidates.append(alias)
        else:
            pattern = r'\b' + re.escape(alias) + r'\b'
            if re.search(pattern, query_lower):
                candidates.append(alias)
    
    # Possessive patterns: "someone's" → extract the entity name
    # BUT skip common contractions like "who's", "what's", "where's", "when's", "how's"
    CONTRACTION_SKIP = {"who", "what", "where", "when", "how", "it", "that", "there", "here"}
    for match in re.finditer(r"(\w+)'s\b", query):
        word = match.group(1).lower()
        if word not in CONTRACTION_SKIP:
            candidates.append(match.group(1))
    
    # Self-reference queries
    query_lower = query.lower()
    if any(p in query_lower for p in ["who am i", "my name", "what am i", "my principles",
                                       "what do i care", "how should i communicate"]):
        candidates.append("Gandalf")
    
    # Multi-word phrase matching against known aliases
    # Only match aliases with 2+ words OR single words that are proper nouns (capitalized in query)
    # Skip very short/generic aliases to avoid false matches
    SKIP_ALIASES = {"i", "me", "my name", "who am i", "ha", "the server"}
    try:
        db_path = DB_PATH
        if db_path.exists():
            _db = sqlite3.connect(str(db_path))
            # aliases table may not exist yet
            _has_aliases = _db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='aliases'").fetchone()
            if _has_aliases:
                all_aliases = [r[0] for r in _db.execute("SELECT DISTINCT alias FROM aliases").fetchall()]
            else:
                all_aliases = []
            _db.close()
            for alias in all_aliases:
                if alias.lower() in SKIP_ALIASES:
                    continue
                alias_lower = alias.lower()
                # Multi-word aliases: match if the full phrase appears
                if " " in alias and alias_lower in query_lower and alias not in candidates:
                    candidates.append(alias)
                # Single-word aliases (3+ chars): only match on word boundaries
                elif " " not in alias and len(alias) >= 3:
                    pattern = r'\b' + re.escape(alias_lower) + r'\b'
                    if re.search(pattern, query_lower) and alias not in candidates:
                        candidates.append(alias)
    except Exception:
        pass
    
    return candidates


def extract_intent(query: str) -> list[str]:
    """Extract likely fact keys from query intent"""
    query_lower = query.lower()
    intents = []
    
    patterns = {
        "birthday": ["birthday", "born", "birth", "birthdate", "when was .* born"],
        "phone": ["phone", "number", "call", "contact", "reach"],
        "email": ["email", "mail", "address.*@", "contact"],
        "address": ["address", "live", "lives", "where does .* live", "location"],
        "birthplace": ["birthplace", "born in", "where was .* born", "from", "origin"],
        "relationship": ["who is", "relationship", "partner", "wife", "husband", "girlfriend"],
        "url": ["url", "website", "domain", "site"],
        "stack": ["stack", "tech", "built with", "uses", "framework"],
        "runs_on": ["port", "runs on", "hosted", "server"],
        "role": ["role", "what does .* do", "job"],
        "full_name": ["full name", "real name", "name"],
    }
    
    for intent, keywords in patterns.items():
        for kw in keywords:
            if re.search(kw, query_lower):
                intents.append(intent)
                break
    
    return intents


def graph_search(query: str, db: sqlite3.Connection, top_k: int = 6) -> list[dict]:
    """
    Search the knowledge graph for answers.
    Returns list of {path, score, answer, entity, method} dicts.
    """
    results = []
    seen = set()
    
    candidates = extract_entity_candidates(query)
    intents = extract_intent(query)
    
    # Phase 1: Entity + Intent matching (highest confidence)
    for candidate in candidates:
        entity = resolve_entity(db, candidate)
        if not entity:
            continue
        
        if intents:
            for intent in intents:
                # Search facts
                rows = db.execute(
                    "SELECT key, value, source FROM facts WHERE entity = ? AND key LIKE ?",
                    (entity, f"%{intent}%")
                ).fetchall()
                for key, value, source in rows:
                    result_key = f"{entity}:{key}"
                    if result_key not in seen:
                        seen.add(result_key)
                        results.append({
                            "path": source or "facts.db",
                            "score": 95,
                            "answer": f"{entity}.{key} = {value}",
                            "entity": entity,
                            "method": "entity+intent"
                        })
                
                # Search relations
                rows = db.execute(
                    "SELECT predicate, object, source FROM relations WHERE subject = ? AND predicate LIKE ?",
                    (entity, f"%{intent}%")
                ).fetchall()
                for pred, obj, source in rows:
                    result_key = f"{entity}:{pred}:{obj}"
                    if result_key not in seen:
                        seen.add(result_key)
                        results.append({
                            "path": source or "facts.db",
                            "score": 90,
                            "answer": f"{entity} → {pred} → {obj}",
                            "entity": entity,
                            "method": "entity+intent+rel"
                        })
        
        # Phase 2: All facts for resolved entity (medium confidence)
        rows = db.execute(
            "SELECT key, value, source FROM facts WHERE entity = ?",
            (entity,)
        ).fetchall()
        for key, value, source in rows:
            result_key = f"{entity}:{key}"
            if result_key not in seen:
                seen.add(result_key)
                results.append({
                    "path": source or "facts.db",
                    "score": 70,
                    "answer": f"{entity}.{key} = {value}",
                    "entity": entity,
                    "method": "entity"
                })
        
        # Phase 2b: All relations for entity
        rows = db.execute(
            "SELECT predicate, object, source FROM relations WHERE subject = ?",
            (entity,)
        ).fetchall()
        for pred, obj, source in rows:
            result_key = f"{entity}:{pred}:{obj}"
            if result_key not in seen:
                seen.add(result_key)
                results.append({
                    "path": source or "facts.db",
                    "score": 65,
                    "answer": f"{entity} → {pred} → {obj}",
                    "entity": entity,
                    "method": "entity+rel"
                })
    
    # Phase 3: FTS on facts (lower confidence — no entity resolved)
    if not results:
        # Build FTS query from significant words
        stop_words = {"what", "is", "the", "a", "an", "of", "in", "on", "at", "to", "for",
                      "how", "when", "where", "who", "which", "does", "do", "did", "has",
                      "have", "about", "with", "my", "your", "this", "that", "are", "was"}
        words = [w for w in re.findall(r'\w+', query.lower()) if w not in stop_words and len(w) > 1]
        if words:
            fts_query = " OR ".join(words)
            try:
                rows = db.execute(
                    "SELECT entity, key, value FROM facts_fts WHERE facts_fts MATCH ?",
                    (fts_query,)
                ).fetchall()
                for entity, key, value in rows[:top_k]:
                    result_key = f"{entity}:{key}"
                    if result_key not in seen:
                        seen.add(result_key)
                        source = db.execute(
                            "SELECT source FROM facts WHERE entity = ? AND key = ?",
                            (entity, key)
                        ).fetchone()
                        results.append({
                            "path": (source[0] if source else "facts.db"),
                            "score": 50,
                            "answer": f"{entity}.{key} = {value}",
                            "entity": entity,
                            "method": "fts"
                        })
            except Exception:
                pass
    
    # Phase 4: FTS on relations
    if len(results) < top_k:
        words = [w for w in re.findall(r'\w+', query.lower()) 
                 if w not in {"what", "is", "the", "a", "an", "of", "in", "on", "at", "to", "for",
                              "how", "when", "where", "who", "which", "does", "do"} and len(w) > 1]
        if words:
            fts_query = " OR ".join(words)
            try:
                rows = db.execute(
                    "SELECT subject, predicate, object FROM relations_fts WHERE relations_fts MATCH ?",
                    (fts_query,)
                ).fetchall()
                for subj, pred, obj in rows[:top_k]:
                    result_key = f"rel:{subj}:{pred}:{obj}"
                    if result_key not in seen:
                        seen.add(result_key)
                        source = db.execute(
                            "SELECT source FROM relations WHERE subject = ? AND predicate = ? AND object = ?",
                            (subj, pred, obj)
                        ).fetchone()
                        results.append({
                            "path": (source[0] if source else "facts.db"),
                            "score": 40,
                            "answer": f"{subj} → {pred} → {obj}",
                            "entity": subj,
                            "method": "fts_rel"
                        })
            except Exception:
                pass
    
    # Sort by score, return top-K
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:top_k]


def main():
    parser = argparse.ArgumentParser(description="Graph-augmented memory search")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--json", action="store_true", help="JSON output")
    parser.add_argument("--top-k", "-k", type=int, default=6)
    args = parser.parse_args()
    
    db = sqlite3.connect(str(DB_PATH))
    results = graph_search(args.query, db, args.top_k)
    db.close()
    
    if args.json:
        print(json.dumps(results, indent=2))
    else:
        if not results:
            print("No results found.")
        else:
            for r in results:
                print(f"  [{r['score']:3d}] [{r['method']:18s}] {r['answer']}")
                print(f"        source: {r['path']}")


if __name__ == "__main__":
    main()
