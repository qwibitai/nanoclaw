/**
 * openclaw-plugin-graph-memory — Knowledge Graph Memory Search v2
 *
 * Augments OpenClaw's memory pipeline with knowledge graph lookups.
 * v2 adds: activation-based scoring, co-occurrence learning, importance floors.
 *
 * Hook: before_agent_start (priority 5 — runs before continuity plugin)
 *
 * Flow:
 * 1. Extract user's last message
 * 2. Spawn graph-search.py with the query
 * 3. Parse JSON results (now includes fact IDs)
 * 4. Score results using relevance + activation
 * 5. Bump activation on retrieved facts
 * 6. Wire co-occurrences between facts retrieved together
 * 7. Pull in co-occurring facts via spreading activation
 * 8. Format as prependContext block
 */

const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS = {
    enabled: true,
    maxResults: 8,
    minScore: 50,
    timeoutMs: 500,           // Reduced from 2000ms for faster fallback
    activationBump: 0.5,
    activationWeight: 0.3,    // 30% of combined score from activation
    relevanceWeight: 0.7,     // 70% of combined score from search relevance
    coOccurrenceLimit: 4,     // max co-occurring facts to pull in
    coOccurrenceMinWeight: 2, // minimum co-occurrence weight to consider
    cacheSize: 10,            // LRU cache size for repeated queries
    cacheTTL: 60000,          // Cache TTL in ms (60 seconds)
    showEmptyResults: false,  // Set to true to show "[GRAPH MEMORY] No matching entities found"
};

// Simple LRU cache for query results
class QueryCache {
    constructor(maxSize = 10, ttlMs = 60000) {
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.cache = new Map();
    }
    
    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.timestamp > this.ttlMs) {
            this.cache.delete(key);
            return null;
        }
        // Move to end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.results;
    }
    
    set(key, results) {
        // Remove oldest if at capacity
        if (this.cache.size >= this.maxSize) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
        }
        this.cache.set(key, { results, timestamp: Date.now() });
    }
    
    clear() {
        this.cache.clear();
    }
}

// Async telemetry writer (non-blocking)
const telemetryQueue = [];
let telemetryFlushPending = false;

function writeTelemetry(data) {
    telemetryQueue.push(JSON.stringify(data) + '\n');
    if (!telemetryFlushPending) {
        telemetryFlushPending = true;
        setImmediate(() => {
            const batch = telemetryQueue.splice(0, telemetryQueue.length);
            telemetryFlushPending = false;
            if (batch.length > 0) {
                fs.appendFile('/tmp/openclaw/memory-telemetry.jsonl', batch.join(''), (err) => {
                    if (err) console.error('[graph-memory] telemetry write error:', err.message);
                });
            }
        });
    }
}

// ---------------------------------------------------------------------------
// SQLite helper — lightweight direct access for activation/co-occurrence
// ---------------------------------------------------------------------------

let _db = null;
let _dbPath = null;

function getDb(dbPath) {
    if (_db) return _db;
    try {
        // Use better-sqlite3 if available (synchronous, fast)
        let Database;
        try {
            Database = require('better-sqlite3');
        } catch {
            // Try common locations
            const locations = [
                path.join(process.env.HOME || '', '.openclaw/extensions/hebbian-hook/node_modules/better-sqlite3'),
                path.join(process.env.HOME || '', 'node_modules/better-sqlite3'),
            ];
            for (const loc of locations) {
                try { Database = require(loc); break; } catch {}
            }
        }
        if (!Database) {
            console.error('[graph-memory] better-sqlite3 not found — activation features disabled');
            return null;
        }
        _db = new Database(dbPath, { readonly: false });
        _db.pragma('journal_mode = WAL');
        _db.pragma('synchronous = NORMAL');
        _dbPath = dbPath;
        return _db;
    } catch (err) {
        console.error(`[graph-memory] SQLite open failed: ${err.message}`);
        return null;
    }
}

function closeDb() {
    if (_db) {
        try { _db.close(); } catch {}
        _db = null;
    }
}

// ---------------------------------------------------------------------------
// Activation & Co-occurrence operations
// ---------------------------------------------------------------------------

function bumpActivations(db, factIds, amount) {
    if (!db || factIds.length === 0) return;
    try {
        const now = new Date().toISOString();
        const stmt = db.prepare(
            'UPDATE facts SET activation = activation + ?, access_count = access_count + 1, last_accessed = ? WHERE id = ?'
        );
        const tx = db.transaction((ids) => {
            for (const id of ids) {
                stmt.run(amount, now, id);
            }
        });
        tx(factIds);
    } catch (err) {
        console.error(`[graph-memory] bumpActivations error: ${err.message}`);
    }
}

function wireCoOccurrences(db, factIds) {
    if (!db || factIds.length < 2) return;
    try {
        const now = new Date().toISOString();
        const stmt = db.prepare(`
            INSERT INTO co_occurrences (fact_a, fact_b, weight, last_wired)
            VALUES (?, ?, 1.0, ?)
            ON CONFLICT(fact_a, fact_b) DO UPDATE SET
                weight = weight + 1.0,
                last_wired = ?
        `);
        const tx = db.transaction((ids) => {
            for (let i = 0; i < ids.length; i++) {
                for (let j = i + 1; j < ids.length; j++) {
                    stmt.run(ids[i], ids[j], now, now);
                    stmt.run(ids[j], ids[i], now, now);
                }
            }
        });
        tx(factIds);
    } catch (err) {
        console.error(`[graph-memory] wireCoOccurrences error: ${err.message}`);
    }
}

function getCoOccurring(db, factIds, limit, minWeight) {
    if (!db || factIds.length === 0) return [];
    try {
        const placeholders = factIds.map(() => '?').join(',');
        const stmt = db.prepare(`
            SELECT co.fact_b as id, SUM(co.weight) as total_weight,
                   f.entity, f.key, f.value, f.category, f.activation, f.importance
            FROM co_occurrences co
            JOIN facts f ON f.id = co.fact_b
            WHERE co.fact_a IN (${placeholders})
              AND co.fact_b NOT IN (${placeholders})
              AND co.weight >= ?
            GROUP BY co.fact_b
            ORDER BY total_weight DESC
            LIMIT ?
        `);
        return stmt.all(...factIds, ...factIds, minWeight, limit);
    } catch (err) {
        console.error(`[graph-memory] getCoOccurring error: ${err.message}`);
        return [];
    }
}

function getActivations(db, factIds) {
    if (!db || factIds.length === 0) return {};
    try {
        const placeholders = factIds.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT id, activation FROM facts WHERE id IN (${placeholders})`
        ).all(...factIds);
        const map = {};
        for (const r of rows) map[r.id] = r.activation;
        return map;
    } catch (err) {
        console.error(`[graph-memory] getActivations error: ${err.message}`);
        return {};
    }
}

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

module.exports = {
    id: 'graph-memory',
    name: 'Knowledge Graph Memory Search v2',

    register(api) {
        const userConfig = api.pluginConfig || {};
        const config = { ...DEFAULTS, ...userConfig };

        if (!config.enabled) {
            api.logger?.info?.('graph-memory: disabled by config');
            return;
        }

        // Resolve paths
        const workspaceDir = process.env.OPENCLAW_WORKSPACE
            || process.env.MOLTBOT_WORKSPACE
            || path.join(process.env.HOME || '/home/coolmann', 'clawd');

        const dbPath = config.dbPath || path.join(workspaceDir, 'memory', 'facts.db');
        const scriptPath = config.scriptPath || path.join(workspaceDir, 'scripts', 'graph-search.py');

        // Verify files exist at startup
        if (!fs.existsSync(dbPath)) {
            api.logger?.warn?.(`graph-memory: facts.db not found at ${dbPath}`);
            return;
        }
        if (!fs.existsSync(scriptPath)) {
            api.logger?.warn?.(`graph-memory: graph-search.py not found at ${scriptPath}`);
            return;
        }

        // Open direct DB connection for activation/co-occurrence
        const db = getDb(dbPath);
        
        // Initialize query cache
        const queryCache = new QueryCache(config.cacheSize, config.cacheTTL);
        queryCache.clear(); // Clear any stale cache on startup
        
        if (db) {
            const stats = db.prepare('SELECT COUNT(*) as cnt FROM co_occurrences').get();
            api.logger?.info?.(`graph-memory v2: armed (db=${dbPath}, co-occurrences=${stats.cnt}, cache=${config.cacheSize})`);
        } else {
            api.logger?.info?.(`graph-memory: armed WITHOUT activation (db=${dbPath})`);
        }
        console.log('[plugins] Graph Memory v2 plugin registered — activation + co-occurrence + cache active');

        // -------------------------------------------------------------------
        // HOOK: before_agent_start — Inject graph search results
        // -------------------------------------------------------------------

        api.on('before_agent_start', async (event, ctx) => {
            try {
                const messages = event.messages || [];
                const lastUser = [...messages].reverse().find(m => m?.role === 'user');
                if (!lastUser) return { prependContext: '' };

                const userText = _extractText(lastUser);
                if (!userText || userText.length < 5) return { prependContext: '' };

                const cleanText = _stripContextBlocks(userText).trim();
                if (!cleanText || cleanText.length < 5) {
                    writeTelemetry({ timestamp: new Date().toISOString(), system: 'graph-memory', query: cleanText?.substring(0, 50) || '(empty)', resultCount: 0, injected: false, reason: 'too-short', rawLen: userText?.length || 0 });
                    return { prependContext: '' };
                }

                // Run graph search (returns results with fact_ids now)
                event._graphSearchStart = Date.now();
                
                // Check cache first
                const cacheKey = cleanText.substring(0, 100).toLowerCase();
                let results = queryCache.get(cacheKey);
                const cacheHit = !!results;
                
                if (!results) {
                    results = await _runGraphSearch(scriptPath, cleanText, config);
                    if (results && results.length > 0) {
                        queryCache.set(cacheKey, results);
                    }
                }

                if (!results || results.length === 0) {
                    writeTelemetry({ timestamp: new Date().toISOString(), system: 'graph-memory', query: cleanText.substring(0, 200), latencyMs: Date.now() - event._graphSearchStart, resultCount: 0, injected: false });
                    if (config.showEmptyResults) {
                        return { prependContext: '[GRAPH MEMORY] No matching entities found.' };
                    }
                    return { prependContext: '' };
                }

                // Filter: entity-matched (score >= 65) always pass;
                // FTS-only (score < 65) only if entity-matched exists
                const entityMatched = results.filter(r => r.score >= 65);
                const ftsOnly = results.filter(r => r.score < 65 && r.score >= config.minScore);
                const filtered = entityMatched.length > 0
                    ? [...entityMatched, ...ftsOnly]
                    : [];
                if (filtered.length === 0) {
                    writeTelemetry({ timestamp: new Date().toISOString(), system: 'graph-memory', query: cleanText.substring(0, 200), latencyMs: Date.now() - event._graphSearchStart, resultCount: 0, entityMatched: 0, ftsOnly: ftsOnly.length, injected: false, reason: 'no-entity-match' });
                    if (config.showEmptyResults) {
                        return { prependContext: '[GRAPH MEMORY] No high-confidence entity matches (score < 65).' };
                    }
                    return { prependContext: '' };
                }

                // Collect fact IDs for activation operations
                const factIds = filtered
                    .map(r => r.fact_id)
                    .filter(id => id != null && id > 0);

                // Get activation scores and apply combined scoring
                // IMPORTANT: Preserve tier separation - entity matches (score >= 65) 
                // always rank above FTS-only matches regardless of activation
                let scored = filtered;
                if (db && factIds.length > 0) {
                    const activations = getActivations(db, factIds);

                    // Normalize activations for scoring
                    const actValues = Object.values(activations);
                    const maxAct = Math.max(...actValues, 1);

                    scored = filtered.map(r => {
                        const act = activations[r.fact_id] || 1.0;
                        const normAct = Math.min(act / maxAct, 1.0);
                        const normRelevance = r.score / 100; // search score is 0-100
                        // Use tier-preserved scoring: entity matches get +100 boost
                        const tierBoost = r.score >= 65 ? 100 : 0;
                        const combinedScore = tierBoost + (normRelevance * config.relevanceWeight)
                                            + (normAct * config.activationWeight);
                        return { ...r, combinedScore, activation: act };
                    });

                    scored.sort((a, b) => b.combinedScore - a.combinedScore);
                } else {
                    // No DB: just sort by relevance score, but preserve tiers
                    scored = filtered.sort((a, b) => {
                        const tierDiff = (b.score >= 65 ? 1 : 0) - (a.score >= 65 ? 1 : 0);
                        if (tierDiff !== 0) return tierDiff;
                        return b.score - a.score;
                    });
                }

                const topResults = scored.slice(0, config.maxResults);
                const topFactIds = topResults
                    .map(r => r.fact_id)
                    .filter(id => id != null && id > 0);

                // Bump activations for retrieved facts
                if (db && topFactIds.length > 0) {
                    bumpActivations(db, topFactIds, config.activationBump);
                    wireCoOccurrences(db, topFactIds);
                }

                // Spreading activation: pull in co-occurring facts
                let coOccurring = [];
                if (db && topFactIds.length > 0) {
                    coOccurring = getCoOccurring(
                        db, topFactIds,
                        config.coOccurrenceLimit,
                        config.coOccurrenceMinWeight
                    );
                }

                // Format context block
                const lines = ['[GRAPH MEMORY]'];

                // Group main results by entity
                const byEntity = new Map();
                for (const r of topResults) {
                    const entity = r.entity || 'unknown';
                    if (!byEntity.has(entity)) byEntity.set(entity, []);
                    byEntity.get(entity).push(r);
                }

                for (const [entity, facts] of byEntity) {
                    const seen = new Set();
                    const uniqueFacts = facts.filter(f => {
                        if (seen.has(f.answer)) return false;
                        seen.add(f.answer);
                        return true;
                    });
                    for (const f of uniqueFacts) {
                        lines.push(`• ${f.answer}`);
                    }
                }

                // Add co-occurring facts (clearly marked)
                if (coOccurring.length > 0) {
                    for (const co of coOccurring) {
                        lines.push(`• ${co.entity}.${co.key} = ${co.value} [linked]`);
                    }
                    // Bump co-occurring facts too (lighter bump)
                    const coIds = coOccurring.map(c => c.id);
                    bumpActivations(db, coIds, config.activationBump * 0.3);
                }

                // Telemetry
                try {
                    const telemetry = {
                        timestamp: new Date().toISOString(),
                        system: 'graph-memory',
                        query: cleanText.substring(0, 200),
                        latencyMs: Date.now() - (event._graphSearchStart || Date.now()),
                        resultCount: topResults.length,
                        coOccurring: coOccurring.length,
                        topScore: topResults[0]?.combinedScore,
                        topEntity: topResults[0]?.entity,
                        entityMatched: entityMatched.length,
                        ftsOnly: ftsOnly.length,
                        cacheHit,
                        injected: true
                    };
                    writeTelemetry(telemetry);
                } catch (_telErr) { /* non-blocking */ }

                return { prependContext: lines.join('\n') };

            } catch (err) {
                console.error(`[graph-memory] before_agent_start failed: ${err.message}`);
                writeTelemetry({ timestamp: new Date().toISOString(), system: 'graph-memory', query: '(error)', resultCount: 0, injected: false, error: err.message.substring(0, 200) });
                return { prependContext: '' };
            }
        }, { priority: 5 });

        // -------------------------------------------------------------------
        // HOOK: gateway_stop — Close DB cleanly
        // -------------------------------------------------------------------

        api.on('gateway_stop', async () => {
            closeDb();
            api.logger?.info?.('graph-memory: DB closed');
        }, { priority: 90 });
    },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _extractText(message) {
    if (!message) return '';
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
        return message.content
            .filter(p => p.type === 'text')
            .map(p => p.text || '')
            .join(' ');
    }
    return '';
}

function _stripContextBlocks(text) {
    // Strategy: find the last metadata/context marker, take everything after it as user text.
    // Markers: ```\n (end of JSON block), "Speak from this memory naturally.", System: lines
    
    // DEBUG: Log raw input
    console.log(`[graph-memory:strip] RAW INPUT (${text.length} chars): "${text.substring(0, 100)}..."`);
    
    let result = text;
    
    // Approach: split on known end-of-metadata patterns and take the last segment
    // The user's actual message is always LAST, after all context blocks
    
    // Find the last closing ``` (not opening ```json or ```xml etc.)
    // Closing fences are ``` followed by newline, EOF, or whitespace — not a word char
    let lastCodeFence = -1;
    const fenceRegex = /```(?!\w)/g;
    let match;
    while ((match = fenceRegex.exec(result)) !== null) {
        lastCodeFence = match.index;
    }
    if (lastCodeFence !== -1) {
        const afterFence = result.substring(lastCodeFence + 3).trim();
        // Check if there's actual user content after the fence
        // Strip any remaining context lines
        const cleaned = afterFence
            .replace(/^Speak from this memory naturally\.[^\n]*\n?/gm, '')
            .replace(/^\[TOPIC NOTE\].*\n?/gm, '')
            .replace(/^System:.*\n?/gm, '')
            .replace(/^Entropy:.*\n?/gm, '')
            .replace(/^Principles:.*\n?/gm, '')
            .replace(/^\[STABILITY CONTEXT\][\s\S]*?(?=\n\n)/gm, '')
            .replace(/^\[CONTINUITY CONTEXT\][\s\S]*?(?=\n\n)/gm, '')
            .replace(/^\[GRAPH MEMORY\][\s\S]*?(?=\n\n)/gm, '')
            .trim();
        console.log(`[graph-memory:strip] After fence clean: "${cleaned.substring(0, 100)}..." (${cleaned.length} chars)`);
        console.log(`[graph-memory] strip: afterFence="${afterFence.substring(0, 80)}" cleaned="${cleaned.substring(0, 80)}" len=${cleaned.length}`);
        if (cleaned.length >= 3) {
            return cleaned;
        }
    }
    
    // Fallback: strip known blocks individually
    result = result
        .replace(/\[CONTINUITY CONTEXT\][\s\S]*?\n\n/g, '')
        .replace(/\[STABILITY CONTEXT\][\s\S]*?\n\n/g, '')
        .replace(/\[GRAPH MEMORY\][\s\S]*?\n\n/g, '')
        .replace(/\[TOPIC NOTE\].*?\n/g, '')
        .replace(/Conversation info \(untrusted metadata\):[\s\S]*?```\s*\n?/g, '')
        .replace(/Replied message \(untrusted[\s\S]*?```\s*\n?/g, '')
        .replace(/You remember these earlier[\s\S]*?Speak from this memory naturally\.[^\n]*\n?/g, '')
        .replace(/System:.*?\n/g, '')
        .replace(/Entropy:.*?\n/g, '')
        .replace(/Principles:.*?\n/g, '')
        .trim();
    
    return result;
}

function _runGraphSearch(scriptPath, query, config) {
    return new Promise((resolve, reject) => {
        const timeout = config.timeoutMs || 2000;

        const child = execFile(
            'python3',
            [scriptPath, query, '--json', '--top-k', String(config.maxResults || 8)],
            {
                timeout,
                maxBuffer: 1024 * 64,
                env: { ...process.env },
            },
            (error, stdout, stderr) => {
                if (error) {
                    if (error.killed) {
                        console.error(`[graph-memory] search timed out after ${timeout}ms`);
                        resolve([]);
                        return;
                    }
                    console.error(`[graph-memory] search error: ${error.message}`);
                    resolve([]);
                    return;
                }

                try {
                    const results = JSON.parse(stdout.trim());
                    resolve(Array.isArray(results) ? results : []);
                } catch (parseErr) {
                    console.error(`[graph-memory] JSON parse error: ${parseErr.message}`);
                    resolve([]);
                }
            }
        );
    });
}
