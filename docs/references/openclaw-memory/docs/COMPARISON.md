# Memory Architecture: Documentation vs Reality (2026-02-20)

## Layer-by-Layer Comparison

### Layer 1: Always-Loaded Context
| Documented | Current Status | Notes |
|------------|----------------|-------|
| SOUL.md | ✅ 3.3KB | Unchanged |
| USER.md | ✅ 1.9KB | Unchanged |
| IDENTITY.md | ✅ 165B | Unchanged |
| active-context.md | ✅ 6.3KB | Larger than target (2KB), but functional |
| HEARTBEAT.md | ✅ 760B | Unchanged |

**Verdict:** ✅ Fully implemented

---

### Layer 2: Strategic Memory
| Documented | Current Status | Notes |
|------------|----------------|-------|
| MEMORY.md | ✅ 3.5KB | Within target (<8KB) |

**Verdict:** ✅ Fully implemented

---

### Layer 3: Project Memory
| Documented | Current Status | Notes |
|------------|----------------|-------|
| project-keystone.md | ✅ | Exists |
| project-microdose-tracker.md | ✅ | Exists |
| project-clawsmith.md | ✅ | Exists |
| project-adult-in-training.md | ✅ | Exists |
| project-canva-connect.md | ✅ | Exists |

**Verdict:** ✅ Fully implemented (5 projects)

---

### Layer 4: Structured Facts (facts.db)
| Documented | Current Status | Notes |
|------------|----------------|-------|
| facts table | ✅ 3,108 facts | 2.5x growth since doc |
| relations table | ✅ 1,009 relations | 2x growth since doc |
| aliases table | ✅ 275 aliases | **NEW** - not in schema docs |
| co_occurrences table | ✅ | **NEW** - for activation wiring |
| FTS5 index | ✅ | Working |
| Activation scoring | ✅ | **NEW** - decay system |

**Schema Evolution (not documented):**
```sql
-- New columns on facts:
activation REAL DEFAULT 1.0
importance REAL DEFAULT 0.5

-- New tables:
aliases (alias, entity)
co_occurrences (fact_a, fact_b, weight)
```

**Verdict:** ✅ Implemented + evolved beyond documentation

---

### Layer 5: Semantic Search
| Documented | Current Status | Notes |
|------------|----------------|-------|
| QMD primary | ⚠️ Configured | Often times out |
| Ollama fallback | ❌ Changed | **Now: llama.cpp + nomic-embed-text-v2-moe** |
| 384d embeddings | ❌ Changed | **Now: 768d embeddings** |
| OpenAI-compatible API | ❌ Changed | **Now: llama.cpp HTTP server** |

**Major Changes:**
- **Old:** `Xenova/all-MiniLM-L6-v2` (384d, ONNX, CPU)
- **New:** `nomic-embed-text-v2-moe` (768d, GGUF, GPU)
- **Latency:** 500ms → 7ms (70x faster)
- **Multilingual:** English-only → 100+ languages

**Verdict:** ⚠️ Implemented but significantly changed from docs

---

### Layer 6: Daily Logs
| Documented | Current Status | Notes |
|------------|----------------|-------|
| YYYY-MM-DD.md pattern | ✅ 62 files | Working |
| Auto-append | ✅ | Working |
| Source for curation | ✅ | Working |

**Verdict:** ✅ Fully implemented

---

### Layer 7: Procedural Memory
| Documented | Current Status | Notes |
|------------|----------------|-------|
| tools-wix-api.md | ✅ | Exists |
| tools-social-media.md | ✅ | Exists |
| tools-infrastructure.md | ✅ | Exists |
| tools-home-assistant.md | ✅ | Exists |
| tools-n8n.md | ✅ | Exists |
| TOOLS.md (index) | ✅ | Exists |

**Verdict:** ✅ Fully implemented

---

### Layer 8: Gating Policies
| Documented | Current Status | Notes |
|------------|----------------|-------|
| gating-policies.md | ✅ | Exists |

**Verdict:** ✅ Fully implemented

---

### Layer 9: Checkpoints
| Documented | Current Status | Notes |
|------------|----------------|-------|
| checkpoints/ directory | ✅ | 1 active checkpoint |

**Verdict:** ✅ Fully implemented

---

### Layer 10: Continuity Plugin
| Documented | Current Status | Notes |
|------------|----------------|-------|
| SQLite + SQLite-vec | ✅ | Working |
| 384d embeddings | ❌ Changed | **Now: 768d** |
| all-MiniLM-L6-v2 | ❌ Changed | **Now: nomic-embed-text-v2-moe** |
| Topic tracking | ✅ | Working |
| Continuity anchors | ✅ | Working |
| Context budgeting | ✅ | Working |
| Injects [CONTINUITY CONTEXT] | ✅ | Working |

**Data:**
- Exchanges: 2,065
- Vector indexed: 1,847
- Dates: 4 (Feb 17-20)

**Verdict:** ⚠️ Working but embedding model changed

---

### Layer 11: Stability Plugin
| Documented | Current Status | Notes |
|------------|----------------|-------|
| Entropy monitoring | ✅ | Working (injected per prompt) |
| Principle alignment | ✅ | Working |
| Loop detection | ✅ | Working |
| Confabulation detection | ✅ | Working |

**Verdict:** ✅ Fully implemented

---

## Additional Systems (Not in Docs)

### Graph-memory Plugin
| Component | Status |
|-----------|--------|
| before_agent_start hook | ✅ |
| Entity extraction | ✅ |
| [GRAPH MEMORY] injection | ✅ |
| Telemetry logging | ✅ (571 entries) |

**Not documented in ARCHITECTURE.md** but fully functional.

### Memory Telemetry
| Metric | Value |
|--------|-------|
| Log file | /tmp/openclaw/memory-telemetry.jsonl |
| Entries | 571 |
| Systems tracked | graph-memory, continuity |

**Not documented in ARCHITECTURE.md**

### Graph Decay System
| Component | Status |
|-----------|--------|
| graph-decay.py script | ✅ |
| Daily cron (3 AM) | ✅ Just scheduled today |
| Activation scoring | ✅ |
| Hot/Warm/Cool tiers | ✅ (74/1554/1434) |

**Not documented in ARCHITECTURE.md**

---

## Documentation Gaps

### 1. Embedding Model Migration
**Docs say:** `Xenova/all-MiniLM-L6-v2` (384d)
**Reality:** `nomic-embed-text-v2-moe` (768d) on llama.cpp GPU

**Impact:**
- Schema shows 384d, reality is 768d
- Continuity plugin config shows old model name
- Docs don't mention multilingual capability

### 2. Graph-memory Plugin
**Docs say:** Nothing (not mentioned)
**Reality:** Fully operational, injecting [GRAPH MEMORY] per prompt

**Impact:**
- Architecture diagram missing this layer
- No documentation on how it interacts with facts.db

### 3. Activation/Decay System
**Docs say:** Facts table has `last_accessed`, `access_count`, `permanent`
**Reality:** Additional `activation`, `importance` columns + `co_occurrences` table

**Impact:**
- Schema documentation outdated
- No documentation on decay algorithm
- No mention of Hot/Warm/Cool tiers

### 4. facts.db Growth
**Docs say:** ~1,250 facts implied
**Reality:** 3,108 facts (2.5x growth)

**Impact:**
- Performance considerations changed
- Need to document pruning/archival strategy

### 5. Hardware Section
**Docs say:** AMD GPU with ROCm, 96GB unified VRAM
**Reality:** Same, but should verify accuracy

---

## Summary

| Layer | Doc Accuracy | Implementation |
|-------|--------------|----------------|
| 1. Always-Loaded | ✅ Accurate | ✅ Complete |
| 2. Strategic Memory | ✅ Accurate | ✅ Complete |
| 3. Project Memory | ✅ Accurate | ✅ Complete |
| 4. Structured Facts | ⚠️ Schema outdated | ✅ Complete + evolved |
| 5. Semantic Search | ❌ Outdated | ✅ Complete (different tech) |
| 6. Daily Logs | ✅ Accurate | ✅ Complete |
| 7. Procedural Memory | ✅ Accurate | ✅ Complete |
| 8. Gating Policies | ✅ Accurate | ✅ Complete |
| 9. Checkpoints | ✅ Accurate | ✅ Complete |
| 10. Continuity Plugin | ⚠️ Model outdated | ✅ Complete |
| 11. Stability Plugin | ✅ Accurate | ✅ Complete |
| Graph-memory Plugin | ❌ Not documented | ✅ Complete |
| Decay System | ❌ Not documented | ✅ Complete |
| Telemetry | ❌ Not documented | ✅ Complete |

**Overall:** Architecture is fully implemented and has evolved beyond documentation. Main gaps are:
1. Embedding model migration (384d → 768d)
2. Graph-memory plugin not documented
3. Activation/decay system not documented
4. Schema changes not reflected

---

*Generated: 2026-02-20*