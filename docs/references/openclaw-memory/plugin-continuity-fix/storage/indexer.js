/**
 * Indexer — Exchange pairing + SQLite-vec semantic embedding.
 *
 * Extracted from Clint's archiveIndexer.js (251 lines).
 * Replaces ChromaDB with SQLite-vec (same pattern as knowledgeSystem.js).
 *
 * Pairs user/agent exchanges from daily archives, generates 384-dim
 * embeddings via Xenova/all-MiniLM-L6-v2, and stores them in a SQLite
 * database for semantic retrieval.
 *
 * Requires: better-sqlite3, sqlite-vec, @chroma-core/default-embed
 */

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const fs = require('fs');
const path = require('path');

class Indexer {
    /**
     * @param {object} config - full plugin config (reads embedding section)
     * @param {string} dataDir - plugin data directory
     */
    constructor(config = {}, dataDir) {
        const ec = config.embedding || {};
        this.dbPath = path.join(dataDir, ec.dbFile || 'continuity.db');
        this.dimensions = ec.dimensions || 768;
        this.model = ec.model || 'nomic-embed-text-v1.5';
        this.indexLogPath = path.join(dataDir, 'index-log.json');

        this.db = null;
        this._embeddingFn = null;
        this._embeddingPipeline = null;
        this._initialized = false;
    }

    /**
     * Initialize: open DB, load sqlite-vec, create tables, init embedding model.
     * @returns {boolean} success
     */
    async initialize() {
        if (this._initialized) return true;

        try {
            // Ensure parent directory
            const dir = path.dirname(this.dbPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            // Open database and load sqlite-vec
            this.db = new Database(this.dbPath);
            sqliteVec.load(this.db);

            const vecVersion = this.db.prepare('SELECT vec_version()').get();
            console.log(`[Indexer] sqlite-vec loaded: ${vecVersion['vec_version()']}`);

            // WAL mode for concurrent read performance
            this.db.pragma('journal_mode = WAL');

            // Initialize embeddings FIRST — this may update this.dimensions
            // (e.g. llama.cpp returns 768d instead of default 384d)
            await this._initEmbeddings();

            // Create tables AFTER dimensions are known
            this._createTables();

            this._initialized = true;
            console.log('[Indexer] Initialized — SQLite-vec ready');
            return true;
        } catch (error) {
            console.error('[Indexer] Initialization failed:', error.message);
            return false;
        }
    }

    /**
     * Index a day's conversations from the archive.
     *
     * @param {string} date - YYYY-MM-DD
     * @param {Array} messages - messages from the archiver
     * @returns {{ indexed: number, date: string }}
     */
    async indexDay(date, messages) {
        if (!this._initialized) {
            throw new Error('Indexer not initialized. Call initialize() first.');
        }

        if (!messages || messages.length === 0) {
            return { indexed: 0, date };
        }

        // Pair exchanges
        const exchanges = this._pairExchanges(messages);

        const insertExchange = this.db.prepare(`
            INSERT OR REPLACE INTO exchanges
            (id, date, exchange_index, user_text, agent_text, combined, metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);

        // sqlite-vec virtual tables don't support INSERT OR REPLACE,
        // so delete first then insert
        const deleteVec = this.db.prepare(`DELETE FROM vec_exchanges WHERE id = ?`);
        const insertVec = this.db.prepare(`
            INSERT INTO vec_exchanges (id, embedding)
            VALUES (?, ?)
        `);

        let indexed = 0;

        for (let i = 0; i < exchanges.length; i++) {
            const exchange = exchanges[i];
            const combined = this._formatExchange(exchange, date);
            const id = `exchange_${date}_${i}`;

            try {
                const embedding = await this._embed(combined);
                if (!embedding) continue;

                const metadata = JSON.stringify({
                    timestamp: exchange.user?.timestamp || exchange.agent?.timestamp,
                    hasUser: !!exchange.user,
                    hasAgent: !!exchange.agent
                });

                const transaction = this.db.transaction(() => {
                    insertExchange.run(
                        id, date, i,
                        exchange.user?.text || '',
                        exchange.agent?.text || '',
                        combined,
                        metadata
                    );
                    deleteVec.run(id);
                    insertVec.run(id, new Float32Array(embedding));
                });
                transaction();

                indexed++;
            } catch (err) {
                console.warn(`[Indexer] Failed to index exchange ${id}:`, err.message);
            }
        }

        // Mark date as indexed
        this.markIndexed(date);

        console.log(`[Indexer] Indexed ${indexed} exchanges for ${date}`);
        return { indexed, date };
    }

    /**
     * Get the set of dates already indexed.
     * @returns {Set<string>}
     */
    getIndexedDates() {
        try {
            if (fs.existsSync(this.indexLogPath)) {
                const log = JSON.parse(fs.readFileSync(this.indexLogPath, 'utf8'));
                return new Set(log.dates || []);
            }
        } catch (err) {
            console.warn('[Indexer] Failed to read index log:', err.message);
        }
        return new Set();
    }

    /**
     * Record a date as indexed.
     * @param {string} date - YYYY-MM-DD
     */
    markIndexed(date) {
        try {
            let log = { dates: [], lastIndexed: null };
            if (fs.existsSync(this.indexLogPath)) {
                log = JSON.parse(fs.readFileSync(this.indexLogPath, 'utf8'));
            }
            if (!log.dates.includes(date)) {
                log.dates.push(date);
                log.dates.sort();
            }
            log.lastIndexed = new Date().toISOString();
            fs.writeFileSync(this.indexLogPath, JSON.stringify(log, null, 2), 'utf8');
        } catch (err) {
            console.warn('[Indexer] Failed to update index log:', err.message);
        }
    }

    /**
     * Get total indexed exchange count.
     * @returns {number}
     */
    getExchangeCount() {
        if (!this.db) return 0;
        try {
            const row = this.db.prepare('SELECT COUNT(*) as count FROM exchanges').get();
            return row?.count || 0;
        } catch {
            return 0;
        }
    }

    /**
     * Close the database connection.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
            this._initialized = false;
        }
    }

    // ---------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------

    _createTables() {
        // Main exchanges table
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS exchanges (
                id TEXT PRIMARY KEY,
                date TEXT NOT NULL,
                exchange_index INTEGER,
                user_text TEXT,
                agent_text TEXT,
                combined TEXT,
                metadata TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_exchanges_date ON exchanges(date);
        `);

        // Vector table — check if dimensions match, recreate if changed
        try {
            // Check existing vector table dimensions
            let needsRecreate = false;
            try {
                const info = this.db.prepare("SELECT * FROM vec_exchanges_info LIMIT 1").get();
                // vec0 info table has column count info; if dimensions changed we need to recreate
                const testRow = this.db.prepare("SELECT embedding FROM vec_exchanges LIMIT 1").get();
                if (testRow && testRow.embedding) {
                    const existingDims = new Float32Array(testRow.embedding.buffer || testRow.embedding).length;
                    if (existingDims !== this.dimensions) {
                        console.log(`[Indexer] Dimension change detected: ${existingDims} → ${this.dimensions}, recreating vector table`);
                        needsRecreate = true;
                    }
                }
            } catch (e) {
                // Table doesn't exist yet — will create below
            }

            if (needsRecreate) {
                this.db.exec('DROP TABLE IF EXISTS vec_exchanges');
                // Clear index log so all days get re-indexed with new dimensions
                if (fs.existsSync(this.indexLogPath)) {
                    fs.writeFileSync(this.indexLogPath, JSON.stringify({ dates: [], lastIndexed: null }, null, 2));
                    console.log('[Indexer] Cleared index log — full re-index needed');
                }
            }

            this.db.exec(`
                CREATE VIRTUAL TABLE IF NOT EXISTS vec_exchanges USING vec0(
                    id TEXT PRIMARY KEY,
                    embedding float[${this.dimensions}]
                )
            `);
        } catch (e) {
            if (!e.message.includes('already exists')) {
                throw e;
            }
        }

        console.log('[Indexer] Database tables ready');
    }

    /**
     * Initialize embedding model.
     * Priority: 1) llama.cpp server (GPU-accelerated, 768d)
     *           2) @chroma-core/default-embed (ONNX CPU, 384d)
     *           3) @huggingface/transformers pipeline (ONNX CPU, 384d)
     */
    async _initEmbeddings() {
        // 1) Try llama.cpp embedding server (nomic-embed-text-v1.5 on GPU)
        const llamaUrl = process.env.LLAMA_EMBED_URL || 'http://localhost:8082';
        try {
            const http = require('http');
            const modelName = this.model || 'nomic-embed-text-v1.5';
            const testPayload = JSON.stringify({ input: 'search_document: test', model: modelName });
            const result = await new Promise((resolve, reject) => {
                const url = new URL(`${llamaUrl}/v1/embeddings`);
                const req = http.request({
                    hostname: url.hostname,
                    port: url.port,
                    path: url.pathname,
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(testPayload) },
                    timeout: 5000,
                }, (res) => {
                    let body = '';
                    res.on('data', chunk => body += chunk);
                    res.on('end', () => {
                        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
                    });
                });
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.write(testPayload);
                req.end();
            });

            if (result?.data?.[0]?.embedding?.length > 0) {
                const dims = result.data[0].embedding.length;
                this.dimensions = dims;
                this._embeddingFn = {
                    generate: async (texts) => {
                        // Prepend task prefix for nomic-embed-text
                        const prefixed = texts.map(t => t.startsWith('search_') ? t : `search_document: ${t}`);
                        const payload = JSON.stringify({ input: prefixed, model: modelName });
                        return new Promise((resolve, reject) => {
                            const url = new URL(`${llamaUrl}/v1/embeddings`);
                            const req = http.request({
                                hostname: url.hostname,
                                port: url.port,
                                path: url.pathname,
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
                                timeout: 30000,
                            }, (res) => {
                                let body = '';
                                res.on('data', chunk => body += chunk);
                                res.on('end', () => {
                                    try {
                                        const data = JSON.parse(body);
                                        resolve((data.data || []).map(d => d.embedding));
                                    } catch (e) { reject(e); }
                                });
                            });
                            req.on('error', reject);
                            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                            req.write(payload);
                            req.end();
                        });
                    }
                };
                console.log(`[Indexer] llama.cpp embedding server ready (${dims} dimensions, ${llamaUrl})`);
                return;
            }
        } catch (err) {
            console.warn(`[Indexer] llama.cpp server not available (${llamaUrl}): ${err.message}`);
        }

        // 2) Fallback: @chroma-core/default-embed (ONNX)
        try {
            const { DefaultEmbeddingFunction } = require('@chroma-core/default-embed');
            this._embeddingFn = new DefaultEmbeddingFunction();

            // Warm up
            const test = await this._embeddingFn.generate(['test']);
            if (test && test[0] && test[0].length === this.dimensions) {
                console.log(`[Indexer] ONNX embedding model ready (${this.dimensions} dimensions) — fallback`);
                return;
            }
            console.warn(`[Indexer] Dimension mismatch: expected ${this.dimensions}, got ${test?.[0]?.length}`);
        } catch (err) {
            console.warn('[Indexer] @chroma-core/default-embed failed:', err.message);
        }

        // 3) Fallback: direct transformers.js
        try {
            const { pipeline } = require('@huggingface/transformers');
            this._embeddingPipeline = await pipeline('feature-extraction', this.model);
            this._embeddingFn = {
                generate: async (texts) => {
                    const results = [];
                    for (const text of texts) {
                        const output = await this._embeddingPipeline(text, { pooling: 'mean', normalize: true });
                        results.push(Array.from(output.data));
                    }
                    return results;
                }
            };
            console.log('[Indexer] Fallback transformers.js embedding model ready');
        } catch (fallbackErr) {
            console.error('[Indexer] All embedding models failed:', fallbackErr.message);
            throw new Error('No embedding model available. Install llama.cpp server, @chroma-core/default-embed, or @huggingface/transformers.');
        }
    }

    /**
     * Generate embedding for a single text.
     * @param {string} text
     * @returns {Float32Array|null}
     */
    async _embed(text) {
        if (!this._embeddingFn) return null;
        try {
            const results = await this._embeddingFn.generate([text]);
            return results?.[0] || null;
        } catch (err) {
            console.warn('[Indexer] Embedding generation failed:', err.message);
            return null;
        }
    }

    /**
     * Pair messages into user→agent exchanges.
     * @param {Array} messages - sorted by timestamp
     * @returns {Array<{ user: object|null, agent: object|null }>}
     */
    _pairExchanges(messages) {
        const exchanges = [];
        let currentExchange = { user: null, agent: null };

        for (const msg of messages) {
            if (msg.sender === 'user') {
                // If we already have a user message, push current and start new
                if (currentExchange.user) {
                    exchanges.push(currentExchange);
                    currentExchange = { user: null, agent: null };
                }
                currentExchange.user = msg;
            } else if (msg.sender === 'agent') {
                currentExchange.agent = msg;
                exchanges.push(currentExchange);
                currentExchange = { user: null, agent: null };
            }
        }

        // Push any remaining
        if (currentExchange.user || currentExchange.agent) {
            exchanges.push(currentExchange);
        }

        return exchanges;
    }

    /**
     * Format an exchange for embedding.
     * @param {object} exchange - { user, agent }
     * @param {string} date
     * @returns {string}
     */
    _formatExchange(exchange, date) {
        const time = exchange.user?.timestamp?.substring(11, 16) ||
                     exchange.agent?.timestamp?.substring(11, 16) || '00:00';
        const parts = [`[${date} ${time}]`];

        if (exchange.user?.text) {
            parts.push(`User: ${exchange.user.text}`);
        }
        if (exchange.agent?.text) {
            parts.push(`Agent: ${exchange.agent.text}`);
        }

        return parts.join('\n');
    }
}

module.exports = Indexer;
