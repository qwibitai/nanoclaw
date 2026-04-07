## Capability: memory-recall

### Overview
双路记忆召回系统，从 Nine（源自 DeerFlow + OpenClaw）移植。向量近邻搜索 + 关键词匹配双路检索，混合融合排序 + 时间衰减 + MMR 多样性重排。在记忆注入时根据用户当前消息检索最相关的 facts，而非全量灌入。

### 参考源码（直接翻译）
- `nine/server/backend/app/agents/main_agent/memory/store.py` — 统一 MemoryStore 接口（213 行）
- `nine/server/backend/app/agents/main_agent/memory/hybrid.py` — 混合融合（127 行）
- `nine/server/backend/app/agents/main_agent/memory/mmr.py` — MMR 重排（156 行）
- `nine/server/backend/app/agents/main_agent/memory/keyword_store.py` — 关键词检索（259 行）
- `nine/server/backend/app/agents/main_agent/memory/temporal_decay.py` — 时间衰减（112 行）
- `nine/server/backend/app/agents/main_agent/memory/embeddings.py` — Embedding（107 行）
- `nine/server/backend/app/agents/main_agent/memory/vector_store.py` — 向量存储（132 行）

### Requirements

#### R9: 向量检索
- R9.1: 对用户最新消息生成 embedding（DashScope text-embedding-v4）
- R9.2: 在该 group 的所有 facts embeddings 中搜索 top-K 近邻（cosine similarity）
- R9.3: 返回 { id, content, metadata, created_at, score } 列表
- R9.4: NanoClaw 适配：facts 数量 <500，直接从 SQLite 加载所有 embeddings 暴力 cosine 计算（无需 Qdrant）
- R9.5: top_k 默认取 2 * final_top_k，多取用于后续融合截取

#### R10: 关键词检索
- R10.1: Nine 用 MySQL FULLTEXT + ngram parser 做 BM25。NanoClaw 适配为 SQLite FTS5
- R10.2: SQLite FTS5 虚拟表：`CREATE VIRTUAL TABLE memory_facts_fts USING fts5(content, fact_id UNINDEXED)`
- R10.3: 同步 FTS 索引：store_facts 时 INSERT INTO memory_facts_fts，remove_facts 时 DELETE
- R10.4: 搜索：`SELECT fact_id, rank FROM memory_facts_fts WHERE content MATCH :query ORDER BY rank LIMIT :top_k`
- R10.5: FTS5 rank 值归一化到 [0, 1]：`score = abs(rank) / (1 + abs(rank))`
- R10.6: FTS5 不可用时回退到 LIKE 模糊匹配（与 Nine 的 KeywordStore 一致）
- R10.7: 查询文本分词：提取字母数字 + 中日韩字符 token，组合成 FTS5 查询表达式

#### R11: 混合融合（Hybrid Merge）
- R11.1: 按 ID 合并向量结果和关键词结果
- R11.2: 加权分数：`fusedScore = vectorWeight * vectorScore + textWeight * textScore`
- R11.3: 默认权重：向量 0.7，关键词 0.3
- R11.4: 两路都命中的 item 保留双分数，单路命中的缺失分数为 0

#### R12: 时间衰减（Temporal Decay）
- R12.1: 指数衰减公式：`decayedScore = score * exp(-lambda * ageDays)`
- R12.2: lambda = ln(2) / halfLifeDays
- R12.3: 默认半衰期 30 天
- R12.4: created_at 为空的 item 保持原始分数

#### R13: MMR 重排序（Maximal Marginal Relevance）
- R13.1: MMR 分数：`mmr = lambda * relevance - (1-lambda) * maxSimilarity`
- R13.2: 默认 lambda = 0.7（偏向相关性）
- R13.3: 相似度计算优先用向量余弦相似度，无向量时回退到文本 Jaccard 相似度
- R13.4: 分数归一化到 [0, 1] 后再计算 MMR
- R13.5: 贪心迭代选择：每轮选 MMR 最高的 item 加入已选集

#### R14: 统一 MemoryStore 接口
- R14.1: `MemoryStore` 类，per-group 实例
- R14.2: `recall(query, topK=5)`: 双路检索 → 融合 → 时间衰减 → 排序 → MMR → 截取 top-K
- R14.3: `store(content, metadata)`: 写入 SQLite + FTS5 + embedding
- R14.4: 内部惰性初始化 vector store + keyword store

#### R15: 记忆注入改造
- R15.1: 注入时不再全量灌 facts，改为：
  - profile 全量注入（user context + history sections）
  - facts 按用户最新消息做双路召回 top-K 注入
- R15.2: injectMemory(groupFolder, groupDir, latestUserMessage) 增加 latestUserMessage 参数
- R15.3: latestUserMessage 为空时 fallback 到全量注入（兼容首次使用）

### Edge Cases
- FTS5 扩展不可用 → 回退到 LIKE 模糊匹配
- 用户首条消息 → 无历史 facts，召回结果为空，只注入 profile
- embedding API 失败 → 向量路返回空，只走关键词路单路
- facts 没有 embedding（旧数据） → 向量路跳过该 fact，关键词路仍可命中
- 所有 facts 都没 embedding → 纯关键词路
