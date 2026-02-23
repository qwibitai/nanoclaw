# Graph-Memory Plugin: Native Node.js Rewrite Plan

## Current Performance Issues

The Python subprocess approach adds ~200-300ms latency per query:
- Python startup: 100-200ms
- SQLite connect: 50ms
- Search: 20-50ms

For context: continuity plugin (native Node.js + sqlite-vec) achieves ~7ms latency.

## Proposed Architecture: Native Node.js Implementation

### Phase 1: Direct SQLite Access (Target: <50ms)

Replace `graph-search.py` subprocess with native `better-sqlite3` queries:

```javascript
// Current (slow)
const results = await _runGraphSearch(scriptPath, query, config);
// Spawns: python3 graph-search.py "query" --json

// Target (fast)
const results = nativeGraphSearch(db, query, config);
// Direct: db.prepare(...).all(...)
```

### Phase 2: Shared Connection Pool (Target: <20ms)

Keep persistent DB connection instead of opening/closing per query:

```javascript
// Plugin startup: open DB once
const db = new Database(dbPath);

// Per-query: use existing connection
const results = db.prepare(SEARCH_SQL).all(params);
```

### Phase 3: Caching Layer (Target: <5ms for cached)

LRU cache for frequent queries (already implemented, but could be improved):

```javascript
// Current: in-memory Map with TTL
// Target: Add cache warming for hot entities
```

## Implementation Details

### 1. Port `extract_entity_candidates()` to JavaScript

Current Python logic:
- Capitalized word extraction
- Multi-word phrase detection (2-3 words)
- Lowercase alias matching with word boundaries
- Possessive pattern handling

JS equivalent using regex:
```javascript
function extractEntityCandidates(query) {
    const candidates = [];
    const words = query.split(/\s+/);
    
    // Capitalized words
    for (const w of words) {
        const clean = w.replace(/[^\w]/g, '');
        if (clean && clean[0] === clean[0].toUpperCase() && clean.length > 1) {
            candidates.push(clean);
        }
    }
    
    // Multi-word combos
    for (let i = 0; i < words.length - 1; i++) {
        const w1 = words[i].replace(/[^\w]/g, '');
        const w2 = words[i+1].replace(/[^\w]/g, '');
        if (w1 && w2 && w1[0] === w1[0].toUpperCase()) {
            candidates.push(`${w1} ${w2}`);
        }
    }
    
    // Load aliases from DB for dynamic matching
    const aliases = db.prepare('SELECT alias FROM aliases').pluck().all();
    const queryLower = query.toLowerCase();
    for (const alias of aliases) {
        if (alias.includes(' ')) {
            if (queryLower.includes(alias.toLowerCase())) {
                candidates.push(alias);
            }
        } else if (alias.length >= 3) {
            const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
            if (pattern.test(queryLower)) {
                candidates.push(alias);
            }
        }
    }
    
    return [...new Set(candidates)]; // dedupe
}
```

### 2. Port `resolve_entity()` to JavaScript

```javascript
function resolveEntity(db, name) {
    // Try aliases table
    const aliasRow = db.prepare(
        'SELECT entity FROM aliases WHERE alias = ? COLLATE NOCASE'
    ).get(name);
    if (aliasRow) return aliasRow.entity;
    
    // Try direct entity match
    const entityRow = db.prepare(
        'SELECT DISTINCT entity FROM facts WHERE entity = ? COLLATE NOCASE'
    ).get(name);
    if (entityRow) return entityRow.entity;
    
    return null;
}
```

### 3. Port `graph_search()` core logic

```javascript
function nativeGraphSearch(db, query, config) {
    const candidates = extractEntityCandidates(query);
    const results = [];
    const seen = new Set();
    
    // Phase 1: Entity matching (score 95)
    for (const candidate of candidates) {
        const entity = resolveEntity(db, candidate);
        if (!entity) continue;
        
        const facts = db.prepare(
            'SELECT key, value, source, id as fact_id FROM facts WHERE entity = ?'
        ).all(entity);
        
        for (const fact of facts) {
            const key = `${entity}:${fact.key}`;
            if (seen.has(key)) continue;
            seen.add(key);
            
            results.push({
                path: fact.source || 'facts.db',
                score: 95,
                answer: `${entity}.${fact.key} = ${fact.value}`,
                entity: entity,
                fact_id: fact.fact_id,
                method: 'entity-match'
            });
        }
    }
    
    // Phase 2: FTS fallback (score 50) - if no entity matches
    if (results.length === 0) {
        const ftsResults = db.prepare(
            `SELECT f.entity, f.key, f.value, f.source, f.id as fact_id 
             FROM facts_fts fts
             JOIN facts f ON fts.rowid = f.id
             WHERE facts_fts MATCH ?
             LIMIT ?`
        ).all(query, config.maxResults);
        
        for (const row of ftsResults) {
            results.push({
                path: row.source || 'facts.db',
                score: 50,
                answer: `${row.entity}.${row.key} = ${row.value}`,
                entity: row.entity,
                fact_id: row.fact_id,
                method: 'fts'
            });
        }
    }
    
    return results;
}
```

### 4. SQL Schema Requirements

Ensure facts.db has:
```sql
-- Required indexes for fast lookups
CREATE INDEX idx_facts_entity ON facts(entity);
CREATE INDEX idx_facts_entity_key ON facts(entity, key);
CREATE INDEX idx_aliases_alias ON aliases(alias COLLATE NOCASE);

-- FTS5 for fallback search
CREATE VIRTUAL TABLE facts_fts USING fts5(entity, key, value, content=facts);
```

## Migration Plan

### Step 1: Add Native Implementation (Parallel)
- Keep Python subprocess as fallback
- Implement native search in `index.js`
- Add config flag: `useNativeSearch: true`

### Step 2: A/B Testing
- Run both in parallel, compare results
- Telemetry: native latency vs Python latency
- Verify result parity

### Step 3: Cutover
- Default to native
- Remove Python subprocess code
- Update documentation

## Estimated Timeline

- **Phase 1** (Direct SQLite): 2-3 hours dev, 1 hour testing
- **Phase 2** (Shared connection): 1 hour (mostly already done)
- **Phase 3** (Optimization): 1-2 hours
- **Total**: ~1 day of focused work

## Benefits

- **Latency**: 200-300ms → 20-50ms (10x faster)
- **Reliability**: No subprocess spawning failures
- **Simplicity**: Single language, easier debugging
- **Integration**: Direct access to activation/co-occurrence logic

## Risks

- **Feature parity**: Must ensure all Python features ported
- **Unicode handling**: JS regex vs Python regex edge cases
- **Concurrency**: better-sqlite3 is synchronous (fine for our use case)

## Decision

RECOMMEND: Proceed with Phase 1 implementation.
The performance gain justifies the effort, and the risk is low (can fall back to Python if issues arise).

---

*Document: 2026-02-21 | Author: Gandalf | Status: Proposed*
