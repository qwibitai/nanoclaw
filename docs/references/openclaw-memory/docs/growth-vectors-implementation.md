# Growth Vectors: Implementation Roadmap

> Practical implementation of Code of the West's behavioral learning in our OpenClaw + facts.db + llama.cpp architecture.
>
> Prerequisites: Read `code-of-the-west-analysis.md`

## Phase 1: Foundation (Week 1) — CORRECTION DETECTION

### 1.1 Database Schema

```sql
-- Add to facts.db

-- Growth vectors: structured behavioral lessons
CREATE TABLE growth_vectors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trigger_pattern TEXT NOT NULL,      -- e.g., "propose gateway restart"
    trigger_embedding BLOB,             -- 768d float32 for similarity search
    lesson_text TEXT NOT NULL,          -- e.g., "Ask for explicit confirmation"
    principle TEXT,                     -- e.g., "reliability", "directness"
    source_exchange_id TEXT,            -- link to continuity conversation
    source_date TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    
    -- Maturation
    maturity_days INTEGER DEFAULT 0,
    is_metabolized BOOLEAN DEFAULT 0,
    
    -- Effectiveness tracking
    effectiveness_score REAL DEFAULT 1.0,
    injection_count INTEGER DEFAULT 0,
    last_injected_at TEXT,
    
    -- Activation (for decay)
    activation REAL DEFAULT 1.0,
    last_accessed TEXT
);

-- Vector outcomes: closed-loop feedback
CREATE TABLE vector_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vector_id INTEGER NOT NULL,
    injection_time TEXT DEFAULT (datetime('now')),
    query_text TEXT,                    -- what triggered the injection
    pre_entropy REAL,                   -- stability entropy before
    post_entropy REAL,                  -- stability entropy after
    user_feedback TEXT,                 -- explicit: "good", "bad", "neutral"
    helped BOOLEAN,                     -- derived from entropy delta + feedback
    FOREIGN KEY (vector_id) REFERENCES growth_vectors(id)
);

-- Indexes
CREATE INDEX idx_gv_trigger ON growth_vectors(trigger_pattern);
CREATE INDEX idx_gv_maturity ON growth_vectors(maturity_days, is_metabolized);
CREATE INDEX idx_gv_effectiveness ON growth_vectors(effectiveness_score);
CREATE INDEX idx_vo_vector ON vector_outcomes(vector_id);
```

### 1.2 Correction Detection (JavaScript)

Add to continuity plugin or new growth-vector plugin:

```javascript
// patterns.js - Correction detection patterns
const CORRECTION_PATTERNS = [
    // Direct corrections
    { regex: /\bno\b,?\s+(that's\s+)?(not\s+|incorrect|wrong)/i, weight: 1.0 },
    { regex: /\bstop\b\s+(doing|saying)/i, weight: 1.0 },
    { regex: /\bdon't\b\s+(do|say|restart|change)/i, weight: 0.9 },
    
    // Instructional corrections  
    { regex: /\byou\s+(should|need to|must)\s+/i, weight: 0.8 },
    { regex: /\bnext\s+time\b/i, weight: 0.8 },
    { regex: /\bplease\s+(don't|stop|always|never)/i, weight: 0.7 },
    
    // Preference corrections
    { regex: /\bi\s+(prefer|want|like|expect)\b/i, weight: 0.7 },
    { regex: /\bi'd\s+rather\b/i, weight: 0.7 },
    
    // Disappointment/feedback
    { regex: /\bthat\s+(wasn't|isn't)\s+(what I wanted|helpful|good)/i, weight: 0.8 },
    { regex: /\btoo\s+(much|long|verbose|short)\b/i, weight: 0.6 },
];

function detectCorrection(text) {
    const matches = [];
    for (const pattern of CORRECTION_PATTERNS) {
        const match = text.match(pattern.regex);
        if (match) {
            matches.push({
                pattern: pattern.regex.source,
                weight: pattern.weight,
                matched: match[0]
            });
        }
    }
    return matches;
}

// Extract lesson from correction context
function extractLesson(userMessage, agentMessage, correction) {
    // Simple heuristic: look for imperative statements after correction
    const text = userMessage;
    
    // Pattern: "Don't X" → "Always ask before X"
    const dontMatch = text.match(/don't\s+(\w+)/i);
    if (dontMatch) {
        return `Always ask for explicit confirmation before ${dontMatch[1]}ing`;
    }
    
    // Pattern: "You should X" → "X"
    const shouldMatch = text.match(/you\s+(?:should|need to)\s+(.+?)(?:\.|$)/i);
    if (shouldMatch) {
        return shouldMatch[1].trim();
    }
    
    // Fallback: Use the matched correction as lesson
    return correction.matched;
}

// Determine principle from lesson text
function inferPrinciple(lesson) {
    const principleKeywords = {
        'integrity': ['honest', 'truth', 'accurate', 'correct', 'mistake'],
        'directness': ['concise', 'brief', 'short', 'clear', 'simple'],
        'reliability': ['confirm', 'ask', 'check', 'verify', 'backup'],
        'privacy': ['secret', 'private', 'personal', 'confidential'],
        'curiosity': ['learn', 'explore', 'research', 'understand']
    };
    
    const lessonLower = lesson.toLowerCase();
    for (const [principle, keywords] of Object.entries(principleKeywords)) {
        if (keywords.some(kw => lessonLower.includes(kw))) {
            return principle;
        }
    }
    return 'general';
}
```

### 1.3 Manual Vector Creation (CLI)

```bash
# Script: scripts/add-growth-vector.js

#!/usr/bin/env node
const Database = require('better-sqlite3');
const { execSync } = require('child_process');

const db = new Database(process.env.FACTS_DB || '/home/coolmann/.openclaw/data/facts.db');

function addVector(trigger, lesson, principle) {
    // Generate embedding for trigger pattern
    const embedding = execSync(
        `curl -s http://localhost:8082/v1/embeddings -H "Content-Type: application/json" -d '{"input": "search_document: ${trigger}", "model": "nomic-embed-text-v1.5"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['data'][0]['embedding'])"`,
        { encoding: 'utf8' }
    );
    
    const stmt = db.prepare(`
        INSERT INTO growth_vectors (trigger_pattern, trigger_embedding, lesson_text, principle)
        VALUES (?, ?, ?, ?)
    `);
    
    const buffer = Buffer.from(JSON.parse(embedding).map(f => 
        Buffer.allocUnsafe(4).writeFloatLE(f, 0)
    ).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0)));
    
    const result = stmt.run(trigger, buffer, lesson, principle);
    console.log(`Created vector ${result.lastInsertRowid}: ${trigger} → ${lesson}`);
}

// CLI usage
const [trigger, lesson, principle] = process.argv.slice(2);
if (trigger && lesson) {
    addVector(trigger, lesson, principle || 'general');
} else {
    console.log('Usage: node add-growth-vector.js "trigger pattern" "lesson text" [principle]');
}
```

### 1.4 Basic Injection Hook

```javascript
// In new plugin: openclaw-plugin-growth-vectors/index.js

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

class GrowthVectorPlugin {
    constructor(config = {}) {
        this.dbPath = config.dbPath || '/home/coolmann/.openclaw/data/facts.db';
        this.maxVectors = config.maxVectors || 3;
        this.similarityThreshold = config.similarityThreshold || 0.7;
        this.db = null;
    }

    async initialize() {
        this.db = new Database(this.dbPath);
        sqliteVec.load(this.db);
    }

    async findRelevantVectors(query) {
        // Embed query
        const queryEmbedding = await this.embed(query);
        
        // Find similar trigger patterns using sqlite-vec
        const results = this.db.prepare(`
            SELECT 
                v.id,
                v.trigger_pattern,
                v.lesson_text,
                v.principle,
                v.effectiveness_score,
                v.maturity_days,
                vec_distance_cosine(v.trigger_embedding, ?) as distance
            FROM growth_vectors v
            WHERE v.is_metabolized = 0
              AND v.effectiveness_score > 0.3
            ORDER BY 
                (1 - vec_distance_cosine(v.trigger_embedding, ?)) * v.effectiveness_score DESC
            LIMIT ?
        `).all(queryEmbedding, queryEmbedding, this.maxVectors);
        
        return results.filter(r => (1 - r.distance) > this.similarityThreshold);
    }

    async embed(text) {
        // Call llama.cpp embedding server
        const response = await fetch('http://localhost:8082/v1/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                input: `search_query: ${text}`,
                model: 'nomic-embed-text-v1.5'
            })
        });
        const data = await response.json();
        return Buffer.from(new Float32Array(data.data[0].embedding).buffer);
    }

    formatContext(vectors) {
        if (vectors.length === 0) return '';
        
        const lines = ['[GROWTH VECTORS]'];
        for (const v of vectors) {
            lines.push(`• ${v.lesson_text} (${v.principle})`);
        }
        return lines.join('\n');
    }
}

// Hook registration
module.exports = {
    register(api) {
        const plugin = new GrowthVectorPlugin(api.pluginConfig);
        
        api.on('before_agent_start', async (event, ctx) => {
            await plugin.initialize();
            
            const messages = event.messages || [];
            const lastUser = [...messages].reverse().find(m => m?.role === 'user');
            if (!lastUser) return { prependContext: '' };
            
            const query = extractText(lastUser);
            const vectors = await plugin.findRelevantVectors(query);
            
            // Log injection for effectiveness tracking
            for (const v of vectors) {
                plugin.db.prepare(`
                    INSERT INTO vector_outcomes (vector_id, query_text, pre_entropy)
                    VALUES (?, ?, ?)
                `).run(v.id, query, ctx.entropy || 0.5);
            }
            
            return { prependContext: plugin.formatContext(vectors) };
        }, { priority: 20 });  // Run after continuity (10) and stability (?)
    }
};
```

## Phase 2: Entropy Integration (Week 2) — STATE-AWARE INJECTION

### 2.1 Export Entropy from Stability Plugin

Modify `openclaw-plugin-stability` to expose current entropy:

```javascript
// In stability plugin's register():
api.on('before_agent_start', async (event, ctx) => {
    const entropy = calculateEntropy(event.messages);
    ctx.entropy = entropy;  // Export for other plugins
    // ... rest of injection
});
```

### 2.2 Entropy-Aware Scoring

```javascript
function scoreVector(vector, queryEmbedding, entropy) {
    const relevance = 1 - vector.distance;  // cosine similarity
    const maturity = Math.min(vector.maturity_days / 30, 1.0);
    const effectiveness = vector.effectiveness_score;
    
    // High entropy = fewer, more conservative vectors
    const entropyFactor = entropy > 0.7 ? 0.3 : 
                          entropy > 0.5 ? 0.6 : 
                          1.0;
    
    return relevance * maturity * effectiveness * entropyFactor;
}
```

## Phase 3: Effectiveness Tracking (Week 3-4) — CLOSED-LOOP

### 3.1 Post-Turn Logging

```javascript
// Hook: after_agent_response (new hook needed in OpenClaw?)
// Or: track in next before_agent_start

api.on('before_agent_start', async (event, ctx) => {
    // Update previous turn's outcomes
    const previousOutcomes = plugin.db.prepare(`
        SELECT * FROM vector_outcomes 
        WHERE post_entropy IS NULL 
        ORDER BY injection_time DESC LIMIT 10
    `).all();
    
    for (const outcome of previousOutcomes) {
        const postEntropy = ctx.entropy;
        const helped = postEntropy < outcome.pre_entropy;
        
        plugin.db.prepare(`
            UPDATE vector_outcomes 
            SET post_entropy = ?, helped = ?
            WHERE id = ?
        `).run(postEntropy, helped, outcome.id);
        
        // Update vector effectiveness
        const stats = plugin.db.prepare(`
            SELECT AVG(CASE WHEN helped THEN 1.0 ELSE 0.0 END) as success_rate
            FROM vector_outcomes
            WHERE vector_id = ?
        `).get(outcome.vector_id);
        
        plugin.db.prepare(`
            UPDATE growth_vectors
            SET effectiveness_score = ?
            WHERE id = ?
        `).run(stats.success_rate, outcome.vector_id);
    }
});
```

### 3.2 User Feedback Capture

```javascript
// Detect explicit feedback in user messages
const FEEDBACK_PATTERNS = {
    positive: [/\b(good|better|yes|thanks|perfect)\b/i, /\bthat helped\b/i],
    negative: [/\b(bad|worse|no|wrong|not helpful)\b/i, /\bthat didn't help\b/i]
};

function detectFeedback(text) {
    for (const [sentiment, patterns] of Object.entries(FEEDBACK_PATTERNS)) {
        if (patterns.some(p => p.test(text))) {
            return sentiment;
        }
    }
    return null;
}

// In before_agent_start:
const feedback = detectFeedback(query);
if (feedback) {
    // Update most recent outcome
    plugin.db.prepare(`
        UPDATE vector_outcomes
        SET user_feedback = ?
        WHERE id = (SELECT id FROM vector_outcomes ORDER BY injection_time DESC LIMIT 1)
    `).run(feedback);
}
```

## Phase 4: Metabolization (Future) — TRAIT PROMOTION

### 4.1 Flag for Review

```sql
-- Query to find vectors ready for promotion
SELECT 
    id,
    trigger_pattern,
    lesson_text,
    principle,
    maturity_days,
    effectiveness_score,
    injection_count
FROM growth_vectors
WHERE maturity_days >= 30
  AND effectiveness_score > 0.8
  AND injection_count >= 5
  AND is_metabolized = 0
ORDER BY effectiveness_score DESC;
```

### 4.2 Manual Promotion Workflow

```bash
# Script: scripts/review-vectors.js

const vectors = db.prepare(metabolizationQuery).all();

console.log(`Found ${vectors.length} vectors ready for promotion:\n`);

for (const v of vectors) {
    console.log(`[${v.id}] ${v.lesson_text}`);
    console.log(`    Principle: ${v.principle}`);
    console.log(`    Success rate: ${(v.effectiveness_score * 100).toFixed(1)}%`);
    console.log(`    Maturity: ${v.maturity_days} days`);
    console.log();
}

console.log('Review and add to SOUL.md under "## Behavioral Traits" if appropriate.');
```

## Testing Strategy

### Unit Tests

```javascript
// test/correction-detection.test.js

test('detects "don\'t restart" pattern', () => {
    const text = "Don't restart the gateway without asking.";
    const corrections = detectCorrection(text);
    expect(corrections).toHaveLength(1);
    expect(corrections[0].weight).toBe(0.9);
});

test('extracts lesson from "don\'t X"', () => {
    const lesson = extractLesson("Don't restart without asking", null, { matched: "Don't restart" });
    expect(lesson).toBe("Always ask for explicit confirmation before restarting");
});
```

### Integration Tests

```bash
# Test end-to-end flow

# 1. Create vector
node scripts/add-growth-vector.js "propose restart" "Ask before restarting" reliability

# 2. Query should trigger injection
# (Send message: "I need to restart the gateway")
# Expected: [GROWTH VECTORS] section in context

# 3. Verify outcome logged
sqlite3 facts.db "SELECT * FROM vector_outcomes ORDER BY injection_time DESC LIMIT 1;"
```

## Migration from Current System

### Facts → Vectors

Current facts that should become vectors:

| Current Fact | Should Be Vector? | Reason |
|-------------|-------------------|---------|
| `Mama.birthday = Sept 1` | No | Static fact, not behavior |
| `Komodo.url = ...` | No | Configuration, not behavior |
| `User prefers direct answers` | **Yes** | Behavioral preference |
| `Don't restart without asking` | **Yes** | Direct behavioral instruction |

### Workflow

1. Keep facts.db for entity lookups (complementary)
2. Add growth_vectors for behavioral lessons
3. Facts answer "what is X?"
4. Vectors shape "how should I respond?"

## Success Metrics

After 30 days:
- [ ] 10+ growth vectors created from corrections
- [ ] Average effectiveness score > 0.6
- [ ] 50%+ reduction in repeated corrections
- [ ] 1-2 vectors promoted to SOUL.md (manual review)

---

*Roadmap: 2026-02-21 | Phases: 4 weeks estimated | Author: Gandalf*
