#!/usr/bin/env python3
"""
Extend facts.db with a lightweight knowledge graph layer.
Adds:
  - relations table (subject → predicate → object triples)
  - aliases table (alternate names for entities)
  - graph_search() function for traversal queries
  
Run once to create schema, then again to seed from existing data.
"""

import sqlite3
import sys
from pathlib import Path

DB_PATH = Path("/path/to/workspace/memory/facts.db")

def create_schema(db: sqlite3.Connection):
    """Add graph tables to existing facts.db"""
    
    db.executescript("""
        -- Entity relationships as triples
        CREATE TABLE IF NOT EXISTS relations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            subject TEXT NOT NULL,        -- entity name (e.g., "Partner")
            predicate TEXT NOT NULL,      -- relationship type (e.g., "partner_of")
            object TEXT NOT NULL,         -- target entity or value (e.g., "User")
            weight REAL DEFAULT 1.0,      -- relationship strength (for ranking)
            source TEXT,                  -- where this came from (e.g., "USER.md")
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(subject, predicate, object)
        );
        
        -- Entity aliases for fuzzy matching
        CREATE TABLE IF NOT EXISTS aliases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alias TEXT NOT NULL COLLATE NOCASE,   -- alternate name
            entity TEXT NOT NULL,                  -- canonical entity name
            UNIQUE(alias, entity)
        );
        
        -- FTS5 for relation search
        CREATE VIRTUAL TABLE IF NOT EXISTS relations_fts USING fts5(
            subject, predicate, object,
            content=relations, content_rowid=id
        );
        
        -- Index for fast lookups
        CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject);
        CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object);
        CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations(predicate);
        CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_aliases_entity ON aliases(entity);
    """)
    
    # Create FTS triggers for auto-sync
    db.executescript("""
        CREATE TRIGGER IF NOT EXISTS relations_ai AFTER INSERT ON relations BEGIN
            INSERT INTO relations_fts(rowid, subject, predicate, object)
            VALUES (new.id, new.subject, new.predicate, new.object);
        END;
        
        CREATE TRIGGER IF NOT EXISTS relations_ad AFTER DELETE ON relations BEGIN
            INSERT INTO relations_fts(relations_fts, rowid, subject, predicate, object)
            VALUES ('delete', old.id, old.subject, old.predicate, old.object);
        END;
        
        CREATE TRIGGER IF NOT EXISTS relations_au AFTER UPDATE ON relations BEGIN
            INSERT INTO relations_fts(relations_fts, rowid, subject, predicate, object)
            VALUES ('delete', old.id, old.subject, old.predicate, old.object);
            INSERT INTO relations_fts(rowid, subject, predicate, object)
            VALUES (new.id, new.subject, new.predicate, new.object);
        END;
    """)
    
    print("✅ Schema created: relations, aliases, relations_fts")


def seed_aliases(db: sqlite3.Connection):
    """Seed aliases from known entity names"""
    
    aliases = [
        # People - nicknames and alternate names
        ("Mama", "Mama"),
        ("Heidi", "Mama"),
        ("Heidi UserLastName-Becker", "Mama"),
        ("Heidi Karin UserLastName-Becker", "Mama"),
        ("Mama Heidi", "Mama"),
        ("Mom", "Mama"),
        ("Mutter", "Mama"),
        
        ("JoJo", "JoJo"),
        ("Johanna", "JoJo"),
        ("Johanna UserLastName", "JoJo"),
        
        ("Flo", "Flo"),
        ("Florian", "Flo"),
        ("Florian Weitz", "Flo"),
        
        ("Partner", "Partner"),
        ("Partner Name", "Partner"),
        
        ("Louisa", "Louisa"),
        ("Louisa Weitz", "Louisa"),
        
        ("Alexa", "Alexa"),
        ("Alexa von Hören", "Alexa"),
        
        ("Dan", "Dan Verakis"),
        ("Dan Verakis", "Dan Verakis"),
        ("Daniel Verakis", "Dan Verakis"),
        
        ("Jim G", "Jim Gardner"),
        ("Jim Gardner", "Jim Gardner"),
        ("James Gardner", "Jim Gardner"),
        
        ("Jim E", "Jim Ephraim"),
        ("Jim Ephraim", "Jim Ephraim"),
        
        ("User", "User"),
        ("Your Name", "User"),
        
        ("Hendrik", "Hendrik"),
        
        # Pets
        ("Judy", "Judy"),
        ("Waffles", "Waffles"),
        ("Pancakes", "Pancakes"),
        
        # Projects
        ("Keystone", "Project Keystone"),
        ("Project Keystone", "Project Keystone"),
        ("Process Engine", "Project Keystone"),
        
        ("ClawSmith", "ClawSmith"),
        ("Clawsmith", "ClawSmith"),
        
        ("MDT", "Microdose Tracker"),
        ("Microdose Tracker", "Microdose Tracker"),
        ("microdose-tracker", "Microdose Tracker"),
        
        ("AIT", "Adult in Training"),
        ("Adult in Training", "Adult in Training"),
        ("adultintraining", "Adult in Training"),
        
        # Infrastructure
        ("aiserver", "aiserver"),
        ("the server", "aiserver"),
        ("homelab", "aiserver"),
        
        ("HA", "Home Assistant"),
        ("Home Assistant", "Home Assistant"),
        ("HomeAssistant", "Home Assistant"),
        
        ("Postiz", "Postiz"),
        ("Komodo", "Komodo"),
        ("n8n", "n8n"),
        ("Ghost", "Ghost"),
        ("Ollama", "Ollama"),
    ]
    
    count = 0
    for alias, entity in aliases:
        try:
            db.execute("INSERT OR IGNORE INTO aliases (alias, entity) VALUES (?, ?)",
                       (alias, entity))
            count += 1
        except sqlite3.IntegrityError:
            pass
    
    db.commit()
    actual = db.execute("SELECT COUNT(*) FROM aliases").fetchone()[0]
    print(f"✅ Seeded aliases: {actual} total ({count} attempted)")


def seed_relations(db: sqlite3.Connection):
    """Seed relationship triples from known facts"""
    
    relations = [
        # Family relationships
        ("Partner", "partner_of", "User", "USER.md"),
        ("User", "partner_of", "Partner", "USER.md"),
        ("Mama", "mother_of", "User", "USER.md"),
        ("User", "child_of", "Mama", "USER.md"),
        ("JoJo", "daughter_of", "User", "USER.md"),
        ("User", "parent_of", "JoJo", "USER.md"),
        ("Louisa", "stepdaughter_of", "User", "USER.md"),
        ("User", "stepparent_of", "Louisa", "USER.md"),
        ("Flo", "stepson_of", "User", "USER.md"),
        ("User", "stepparent_of", "Flo", "USER.md"),
        ("Alexa", "sister_of", "User", "USER.md"),
        ("User", "sibling_of", "Alexa", "USER.md"),
        ("Hendrik", "married_to", "Alexa", "USER.md"),
        ("Alexa", "married_to", "Hendrik", "USER.md"),
        
        # Friends
        ("Dan Verakis", "friend_of", "User", "USER.md"),
        ("Jim Gardner", "friend_of", "User", "USER.md"),
        ("Jim Ephraim", "friend_of", "User", "USER.md"),
        
        # Pets
        ("Judy", "pet_of", "User", "USER.md"),
        ("Waffles", "pet_of", "User", "USER.md"),
        ("Pancakes", "pet_of", "User", "USER.md"),
        
        # Projects → owner
        ("User", "owns", "Project Keystone", "MEMORY.md"),
        ("User", "owns", "ClawSmith", "MEMORY.md"),
        ("User", "owns", "Microdose Tracker", "MEMORY.md"),
        ("User", "owns", "Adult in Training", "MEMORY.md"),
        
        # Projects → tech stack
        ("Project Keystone", "uses", "XState v5", "project-keystone.md"),
        ("Project Keystone", "uses", "SQLite", "project-keystone.md"),
        ("Project Keystone", "uses", "json-rules-engine", "project-keystone.md"),
        ("Project Keystone", "uses", "Express", "project-keystone.md"),
        ("Project Keystone", "uses", "bpmn-js", "project-keystone.md"),
        ("Project Keystone", "runs_on", "port 3055", "project-keystone.md"),
        
        ("ClawSmith", "uses", "Next.js 15", "project-clawsmith.md"),
        ("ClawSmith", "uses", "SQLite", "project-clawsmith.md"),
        ("ClawSmith", "uses", "Drizzle ORM", "project-clawsmith.md"),
        ("ClawSmith", "runs_on", "port 3010", "project-clawsmith.md"),
        
        ("Microdose Tracker", "uses", "Next.js 15", "project-microdose-tracker.md"),
        ("Microdose Tracker", "uses", "PostgreSQL", "project-microdose-tracker.md"),
        ("Microdose Tracker", "uses", "Drizzle ORM", "project-microdose-tracker.md"),
        ("Microdose Tracker", "runs_on", "164.68.104.112", "project-microdose-tracker.md"),
        
        ("Adult in Training", "hosted_on", "Wix", "project-adult-in-training.md"),
        ("Adult in Training", "domain", "adultintraining.us", "project-adult-in-training.md"),
        
        # Infrastructure
        ("aiserver", "hosts", "Ollama", "tools-infrastructure.md"),
        ("aiserver", "hosts", "n8n", "tools-infrastructure.md"),
        ("aiserver", "hosts", "Home Assistant", "tools-infrastructure.md"),
        ("aiserver", "hosts", "Postiz", "tools-infrastructure.md"),
        ("aiserver", "hosts", "Komodo", "tools-infrastructure.md"),
        ("aiserver", "hosts", "Ghost", "tools-infrastructure.md"),
        ("aiserver", "hosts", "ClawSmith", "tools-infrastructure.md"),
        ("aiserver", "hosts", "Project Keystone", "tools-infrastructure.md"),
        
        ("Postiz", "runs_on", "port 4007", "tools-infrastructure.md"),
        ("Komodo", "runs_on", "port 9120", "tools-infrastructure.md"),
        ("Home Assistant", "runs_on", "port 8123", "tools-home-assistant.md"),
        ("n8n", "runs_on", "n8n.home.example.com", "tools-n8n.md"),
        
        # Community
        ("User", "member_of", "ManKind Project", "USER.md"),
        ("User", "member_of", "All is One", "USER.md"),
        ("User", "certified_by", "Mindscape Psychedelic Institute", "USER.md"),
        
        # Locations
        ("User", "lives_in", "South Elgin, IL", "USER.md"),
        ("User", "from", "Minden, Germany", "USER.md"),
        ("Mama", "lives_in", "Minden, Germany", "family-contacts.md"),
        ("Alexa", "lives_in", "Gütersloh, Germany", "USER.md"),
        ("JoJo", "lives_in", "Lexington, KY", "family-contacts.md"),
        ("Partner", "from", "South Korea", "USER.md"),
        
        # Agent team
        ("Gandalf", "agent_role", "main assistant", "SOUL.md"),
        ("Toby", "agent_role", "senior developer", "MEMORY.md"),
        ("Pete", "agent_role", "project manager", "MEMORY.md"),
        ("Pixel", "agent_role", "QA/testing", "MEMORY.md"),
        ("Ram Dass", "agent_role", "spiritual advisor", "MEMORY.md"),
        ("Social Steven", "agent_role", "social media", "MEMORY.md"),
        ("Ernest", "agent_role", "copywriter", "MEMORY.md"),
    ]
    
    count = 0
    for subj, pred, obj, source in relations:
        try:
            db.execute(
                "INSERT OR IGNORE INTO relations (subject, predicate, object, source) VALUES (?, ?, ?, ?)",
                (subj, pred, obj, source)
            )
            count += 1
        except sqlite3.IntegrityError:
            pass
    
    db.commit()
    actual = db.execute("SELECT COUNT(*) FROM relations").fetchone()[0]
    print(f"✅ Seeded relations: {actual} total ({count} attempted)")


def verify(db: sqlite3.Connection):
    """Run a few test queries to verify the graph works"""
    
    print("\n── Test Queries ──────────────────────────────────────")
    
    # 1. Who is Partner? (resolve alias + get all facts + relations)
    print("\n🔍 'Who is Partner?'")
    entity = resolve_entity(db, "Partner")
    print(f"   Resolved: {entity}")
    facts = db.execute("SELECT key, value FROM facts WHERE entity = ?", (entity,)).fetchall()
    for k, v in facts:
        print(f"   fact: {k} = {v}")
    rels = db.execute("SELECT predicate, object FROM relations WHERE subject = ?", (entity,)).fetchall()
    for p, o in rels:
        print(f"   rel: {p} → {o}")
    
    # 2. What does User own?
    print("\n🔍 'What does User own?'")
    rels = db.execute("SELECT object FROM relations WHERE subject = 'User' AND predicate = 'owns'").fetchall()
    for r in rels:
        print(f"   → {r[0]}")
    
    # 3. What runs on aiserver?
    print("\n🔍 'What runs on aiserver?'")
    rels = db.execute("SELECT object FROM relations WHERE subject = 'aiserver' AND predicate = 'hosts'").fetchall()
    for r in rels:
        print(f"   → {r[0]}")
    
    # 4. Mama's phone (alias resolution → entity → fact)
    print("\n🔍 'Mama's phone' (alias → entity → fact)")
    entity = resolve_entity(db, "Mama")
    print(f"   Resolved 'Mama' → entity '{entity}'")
    # Check facts for phone
    phone = db.execute("SELECT value FROM facts WHERE entity = ? AND key LIKE '%phone%'", (entity,)).fetchone()
    if phone:
        print(f"   Phone: {phone[0]}")
    else:
        # Try family-contacts style — might be in a different entity name
        print("   No phone in facts.db — would need to check family-contacts.md")
    
    # 5. Graph traversal: User's family
    print("\n🔍 'User's family' (1-hop relationships)")
    family_preds = ('parent_of', 'child_of', 'stepparent_of', 'sibling_of', 'partner_of')
    for pred in family_preds:
        rels = db.execute("SELECT object FROM relations WHERE subject = 'User' AND predicate = ?", (pred,)).fetchall()
        for r in rels:
            print(f"   {pred} → {r[0]}")
    
    # 6. FTS search on relations
    print("\n🔍 FTS: 'Keystone XState'")
    results = db.execute("SELECT subject, predicate, object FROM relations_fts WHERE relations_fts MATCH 'Keystone AND XState'").fetchall()
    for r in results:
        print(f"   {r[0]} → {r[1]} → {r[2]}")


def resolve_entity(db: sqlite3.Connection, name: str) -> str:
    """Resolve an alias to canonical entity name"""
    row = db.execute("SELECT entity FROM aliases WHERE alias = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row[0]
    # Check if it's already a canonical entity in facts
    row = db.execute("SELECT DISTINCT entity FROM facts WHERE entity = ? COLLATE NOCASE", (name,)).fetchone()
    if row:
        return row[0]
    return name


def main():
    db = sqlite3.connect(str(DB_PATH))
    db.execute("PRAGMA journal_mode=WAL")
    
    print(f"📦 Database: {DB_PATH}")
    print(f"   Existing facts: {db.execute('SELECT COUNT(*) FROM facts').fetchone()[0]}")
    print()
    
    create_schema(db)
    seed_aliases(db)
    seed_relations(db)
    verify(db)
    
    db.close()
    print("\n✅ Graph prototype ready!")


if __name__ == "__main__":
    main()
