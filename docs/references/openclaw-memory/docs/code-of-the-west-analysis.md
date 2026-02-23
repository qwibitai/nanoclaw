# Code of the West: Architecture Analysis & Implementation Roadmap

> Analysis of CoderofTheWest's constraint-based agent architecture and practical implementation path for our OpenClaw + facts.db + llama.cpp setup.
> 
> Source: https://github.com/CoderofTheWest/Code-of-The-West-Constraint-Based-Harness
> Date: 2026-02-21

## Executive Summary

**Code of the West** (Clint/Piper) represents a breakthrough in agent behavioral persistence. Unlike our current fact-storage approach (facts.db), it implements **growth vectors** — structured lesson records that are scored, filtered, and injected into context to actively shape agent behavior over time.

**Key Insight:** Facts tell you *what* is true. Growth vectors tell you *how to behave*.

Our current system stores static facts (Mama's birthday, stack IDs). Clint's system stores dynamic lessons ("I over-explained here — be more concise", "User prefers direct answers"). These lessons accumulate and metabolize into character traits.

## Architecture Comparison

### Current State (OMA)

```
Layer 1: facts.db — Entity/key/value store
  - 161 facts, 26 aliases
  - Static knowledge (birthdays, URLs, configs)
  - Query: "Who is Janna?" → returns facts
  - No behavioral learning

Layer 2: Continuity — Conversation archive
  - 2,065 exchanges with embeddings
  - Semantic search over history
  - No lesson extraction

Layer 3: MEMORY.md — Manual curation
  - Human-edited insights
  - No automated learning pipeline
```

### Code of the West (Clint/Piper)

```
Layer 1: Growth Vector Store — Structured lessons
  - Vectors = {trigger, lesson, principle, source, timestamp, entropy_delta}
  - Automatically extracted from corrections
  - Scored for relevance and effectiveness

Layer 2: Entropy Monitor — Real-time state assessment
  - 9 entropy sources (corrections, novel concepts, confabulation, etc.)
  - Modulates which vectors get injected

Layer 3: Metabolism Pipeline — 30-day maturation
  - Episodic vectors → permanent character traits
  - 3-gate conjunction: time + principle + review

Layer 4: Closed-Loop Feedback — Effectiveness tracking
  - Did the injected lesson help?
  - Auto-adjust vector weights
```

## Key Concepts We Should Adopt

### 1. Growth Vectors (High Priority)

**What:** Structured records of corrections and lessons.

**Why our facts.db fails:** We store "Janna.birthday = July 7". We don't store "When user asks about family, include relationship context".

**Implementation:**
```sql
-- New table: growth_vectors
CREATE TABLE growth_vectors (
    id INTEGER PRIMARY KEY,
    trigger_pattern TEXT,      -- "user asks about family"
    lesson_text TEXT,          -- "include relationship context"
    principle TEXT,            -- "integrity", "directness"
    source_exchange_id TEXT,   -- link to continuity.db
    created_at TEXT,
    maturity_days INTEGER DEFAULT 0,
    is_metabolized BOOLEAN DEFAULT 0,
    effectiveness_score REAL DEFAULT 1.0,  -- from closed-loop feedback
    injection_count INTEGER DEFAULT 0,
    last_injected_at TEXT
);

-- Index for fast lookup
CREATE INDEX idx_gv_trigger ON growth_vectors(trigger_pattern);
CREATE INDEX idx_gv_maturity ON growth_vectors(maturity_days, is_metabolized);
```

**Extraction:** Hook into continuity plugin's `before_agent_start` to detect corrections:
```javascript
// Detect correction patterns in user messages
const correctionPatterns = [
    /no,?( that's)? (not |incorrect|wrong)/i,
    /you (should|need to) (have|be)/i,
    /don't (do|say)/i,
    /I (prefer|want|like)/i,
    /stop (doing|saying)/i
];
```

### 2. Entropy-Aware Injection (Medium Priority)

**What:** Modulate which growth vectors get injected based on agent state.

**Current:** We inject `[GRAPH MEMORY]` on entity match (binary: yes/no).

**Proposed:** Score vectors by:
- **Query relevance** (similarity to current topic)
- **Maturity** (days since creation)
- **Effectiveness** (historical success rate)
- **Entropy level** (high entropy = more conservative injection)

**Implementation:**
```javascript
function scoreVector(vector, query, entropy) {
    const relevance = cosineSimilarity(embed(query), embed(vector.trigger_pattern));
    const maturity = Math.min(vector.maturity_days / 30, 1.0);  // 30-day cap
    const effectiveness = vector.effectiveness_score;
    const entropyFactor = entropy > 0.7 ? 0.5 : 1.0;  // reduce at high entropy
    
    return relevance * maturity * effectiveness * entropyFactor;
}
```

### 3. Metabolism Pipeline (Lower Priority — Complex)

**What:** Transform episodic lessons into permanent character traits after 30 days.

**Challenge:** Requires SOUL.md editing automation (risky).

**Simpler Alternative:** Mature vectors get higher priority but remain in DB. Manual promotion to SOUL.md.

### 4. Closed-Loop Feedback (High Priority)

**What:** Track whether injected lessons actually helped.

**Implementation:**
```sql
-- Track injections and outcomes
CREATE TABLE vector_outcomes (
    vector_id INTEGER,
    injection_time TEXT,
    pre_entropy REAL,
    post_entropy REAL,
    user_feedback TEXT,  -- explicit feedback if given
    FOREIGN KEY (vector_id) REFERENCES growth_vectors(id)
);
```

**Measurement:**
- Pre-turn entropy (from stability plugin)
- Post-turn entropy
- Delta = effectiveness proxy
- User explicit feedback ("good", "better", "no")

## Practical Implementation Path

### Phase 1: Growth Vector Foundation (Week 1)

**Goal:** Extract and store lessons from corrections.

**Steps:**
1. Add `growth_vectors` table to facts.db
2. Add correction detection to continuity plugin
3. Manual vector creation workflow (you correct me → I create vector)
4. Basic injection: top 3 vectors by query similarity

**Example Workflow:**
```
User: "You restarted the gateway without asking. Don't do that."
→ Detected correction pattern
→ Create vector:
   trigger: "propose gateway restart"
   lesson: "Ask for explicit confirmation before restarting gateway"
   principle: "reliability"
   source: conversation 2026-02-21

Next time I propose a restart:
→ Match trigger
→ Inject: "[LESSON] Ask for explicit confirmation before restarting gateway"
→ Log outcome
```

### Phase 2: Entropy Integration (Week 2)

**Goal:** Modulate injection based on stability state.

**Steps:**
1. Hook into stability plugin's entropy calculation
2. Adjust vector scoring: high entropy = fewer, more conservative vectors
3. Add vector maturity scoring (age / 30 days)

### Phase 3: Effectiveness Tracking (Week 3-4)

**Goal:** Closed-loop feedback.

**Steps:**
1. Log every vector injection with pre-entropy
2. Log post-entropy after turn completion
3. Calculate effectiveness scores
4. Deprecate low-effectiveness vectors

### Phase 4: Metabolization (Future)

**Goal:** Promote mature vectors to SOUL.md.

**Challenge:** Requires automated markdown editing with your approval.

**Interim:** Flag mature vectors (30+ days, high effectiveness) for manual review.

## Leveraging Our Existing Infrastructure

### llama.cpp Embeddings (768d, GPU, ~7ms)

**Use:** Vector similarity for trigger matching.
```javascript
// Embed trigger patterns once, store in growth_vectors
const triggerEmbedding = await embed(vector.trigger_pattern);
// Query-time: cosine similarity
const similarity = cosineSimilarity(queryEmbedding, triggerEmbedding);
```

### facts.db (SQLite)

**Extend:** Add growth_vectors and vector_outcomes tables.

**Keep:** Current facts for entity lookup (complementary, not replacement).

### Continuity Plugin (conversation archive)

**Extend:** Add correction detection to `before_agent_start` hook.

**Keep:** Current semantic search for conversation recall.

### Stability Plugin (entropy monitoring)

**Use:** Entropy scores for vector modulation.

**Integration:** Export entropy value for growth vector scoring.

## What We Should NOT Adopt

| Clint Feature | Why Skip | Alternative |
|--------------|----------|-------------|
| 9-source entropy decomposition | Over-engineered for our use case | Use stability plugin's existing entropy |
| Automatic SOUL.md editing | Too risky, needs human review | Manual promotion workflow |
| Complex maturation gates | Simpler to just score by age | Linear maturity scoring |
| DeepSeek 671b dependency | We use OpenRouter | Model-agnostic approach |

## Document Structure for OMA

```
docs/
├── code-of-the-west-analysis.md (this file)
├── growth-vectors-spec.md (detailed spec)
├── implementation-roadmap.md (phased plan)
└── lessons-learned/ (ongoing)
```

## Next Steps

1. **Review this analysis** — Do you agree with the prioritization?
2. **Phase 1 approval** — Shall I implement the growth_vectors table and basic extraction?
3. **Test vector** — Create one manually to validate the concept?

The core insight: We need to shift from *storing facts* to *learning behaviors*. Facts answer questions. Behaviors shape how I respond.

---

*Analysis: 2026-02-21 | Based on: Code of the West v1.0 | Author: Gandalf*
