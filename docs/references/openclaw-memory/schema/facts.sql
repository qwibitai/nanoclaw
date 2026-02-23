-- facts.db schema — Structured memory for OpenClaw agents
-- SQLite + FTS5 for instant exact lookups and full-text search
-- v2: adds activation, importance, co_occurrences, aliases, relations

-- ==========================================================================
-- Core facts table
-- ==========================================================================
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity TEXT NOT NULL,          -- "Alice", "MyProject", "decision", "convention"
    key TEXT NOT NULL,             -- "birthday", "stack", "always use trash"
    value TEXT NOT NULL,           -- "March 15, 1990", "Next.js + PostgreSQL", "recoverable > gone"
    category TEXT NOT NULL,        -- person, project, decision, convention, credential, preference, date, location
    source TEXT,                   -- where this fact came from: "conversation 2026-02-14", "USER.md"
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_accessed TEXT,            -- updated on every retrieval (for TTL/decay)
    access_count INTEGER DEFAULT 0,-- how often this fact is retrieved
    permanent BOOLEAN DEFAULT 0,   -- 1 = never decays (birthdays, core decisions)
    decay_score REAL,              -- computed decay score for pruning
    activation REAL DEFAULT 0.0,   -- v2: how "hot" this fact is (bumped on retrieval)
    importance REAL DEFAULT 0.5    -- v2: baseline importance (0.0-1.0)
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_entity_key ON facts(entity, key);

-- ==========================================================================
-- Full-text search on facts
-- ==========================================================================
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    entity, key, value,
    content=facts,
    content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, entity, key, value)
    VALUES (new.id, new.entity, new.key, new.value);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, entity, key, value)
    VALUES('delete', old.id, old.entity, old.key, old.value);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, entity, key, value)
    VALUES('delete', old.id, old.entity, old.key, old.value);
    INSERT INTO facts_fts(rowid, entity, key, value)
    VALUES (new.id, new.entity, new.key, new.value);
END;

-- ==========================================================================
-- Co-occurrences: weighted graph edges between facts
-- Used for spreading activation (retrieve fact A → pull in related fact B)
-- ==========================================================================
CREATE TABLE IF NOT EXISTS co_occurrences (
    fact_a INTEGER NOT NULL,
    fact_b INTEGER NOT NULL,
    weight REAL DEFAULT 1.0,
    last_wired TEXT,
    PRIMARY KEY (fact_a, fact_b),
    FOREIGN KEY (fact_a) REFERENCES facts(id),
    FOREIGN KEY (fact_b) REFERENCES facts(id)
);

CREATE INDEX IF NOT EXISTS idx_co_occ_a ON co_occurrences(fact_a);
CREATE INDEX IF NOT EXISTS idx_co_occ_b ON co_occurrences(fact_b);

-- ==========================================================================
-- Aliases: map nicknames/shortnames to canonical entity names
-- e.g. "Mama" → "Heidi Kuhlmann-Becker", "JoJo" → "Johanna"
-- ==========================================================================
CREATE TABLE IF NOT EXISTS aliases (
    alias TEXT NOT NULL COLLATE NOCASE,
    entity TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (alias, entity)
);

-- ==========================================================================
-- Relations: subject-predicate-object triples for richer graph queries
-- e.g. ("Sascha", "lives_in", "South Elgin, IL")
-- ==========================================================================
CREATE TABLE IF NOT EXISTS relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject TEXT NOT NULL,
    predicate TEXT NOT NULL,
    object TEXT NOT NULL,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_relations_subject ON relations(subject);
CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations(predicate);

-- FTS on relations for natural language queries
CREATE VIRTUAL TABLE IF NOT EXISTS relations_fts USING fts5(
    subject, predicate, object,
    content=relations,
    content_rowid=id
);
