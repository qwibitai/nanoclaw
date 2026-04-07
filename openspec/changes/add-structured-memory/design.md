## Context

DeerFlow 是 Microsoft Research 开源的 Agent 框架，其记忆模块经过迭代打磨，设计成熟。Nine 平台（我们的 Python 后端）已成功移植该模块（~1240 行 Python），验证了其在生产环境的可靠性。

现需将同一设计移植到 NanoClaw（TypeScript + 单进程），存储层从 MySQL + Qdrant 简化为 SQLite + 内存向量计算。

### DeerFlow 记忆架构（已验证）

```
对话结束
    ↓
MemoryUpdateQueue（防抖 30s，同 thread_id 覆盖）
    ↓
MemoryUpdater（LLM 提取）
  1. 加载当前记忆状态（profile + facts）
  2. 格式化对话为文本
  3. 组装 MEMORY_UPDATE_PROMPT（含当前记忆 + 新对话）
  4. 调 LLM 生成更新 JSON
  5. 解析 JSON，应用增量更新
    ↓
Storage（持久化）
  - profile: 用户画像 JSON（user context + history，6 个 section）
  - facts: 知识点列表（content + category + confidence + vector）
    ↓
format_memory_for_injection → 注入 system prompt
```

### 记忆数据结构（DeerFlow 原版，直接复用）

```json
{
  "version": "1.0",
  "user": {
    "workContext": { "summary": "...", "updatedAt": "..." },
    "personalContext": { "summary": "...", "updatedAt": "..." },
    "topOfMind": { "summary": "...", "updatedAt": "..." }
  },
  "history": {
    "recentMonths": { "summary": "...", "updatedAt": "..." },
    "earlierContext": { "summary": "...", "updatedAt": "..." },
    "longTermBackground": { "summary": "...", "updatedAt": "..." }
  },
  "facts": [
    { "id": "uuid", "content": "...", "category": "preference|knowledge|context|behavior|goal", "confidence": 0.9 }
  ]
}
```

## Goals / Non-Goals

**Goals:**
- 移植 DeerFlow 完整的结构化记忆系统到 NanoClaw
- 保持与 DeerFlow/Nine 相同的记忆数据结构和 Prompt 模板
- 使用 DashScope text-embedding-v4 做向量化（1024 维）
- 使用 Qwen3.6-plus 做记忆提取 LLM
- SQLite 存储，zero 外部依赖（不需要 Qdrant）
- 对话完成后异步提取，不阻塞消息响应
- 记忆自动注入 Agent 的 system prompt（通过 CLAUDE.md）
- MEMORY_ENABLED=false 时完全 bypass

**Non-Goals:**
- 多用户隔离（NanoClaw 是个人助手，per-group 隔离即可）
- 实时流式记忆更新（只在对话完成后批量更新）
- 记忆管理 UI（后续可通过 MCP tool 暴露）
- 向量搜索索引优化（facts 数量 <500，暴力 cosine 即可）

## Decisions

### 1. 存储：SQLite vs Qdrant

**选择 SQLite。** NanoClaw 的设计哲学是零外部依赖。每个用户的 facts 数量预计 <500 条，cosine similarity 暴力计算在毫秒级。不需要 Qdrant。

SQLite 表设计：
```sql
-- 用户画像（per-group 一条记录）
CREATE TABLE memory_profiles (
  group_folder TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 知识点
CREATE TABLE memory_facts (
  id TEXT PRIMARY KEY,
  group_folder TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'context',
  confidence REAL NOT NULL DEFAULT 0.0,
  source TEXT,  -- 来源 session ID
  embedding BLOB,  -- Float32Array 序列化
  created_at TEXT NOT NULL
);
CREATE INDEX idx_facts_group ON memory_facts(group_folder);
```

### 2. Embedding：DashScope text-embedding-v4

**选择 DashScope。** 与 Nine 平台保持一致。通过 OpenAI 兼容 API 调用，1024 维。

```typescript
const openai = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
});
const resp = await openai.embeddings.create({
  model: 'text-embedding-v4',
  input: text,
});
```

### 3. LLM 记忆提取：Qwen3.6-plus

**选择 Qwen3.6-plus。** 成本低、速度快、中文能力强，适合结构化 JSON 提取任务。同样走 DashScope OpenAI 兼容 API。

```typescript
const resp = await openai.chat.completions.create({
  model: 'qwen3.6-plus',
  messages: [{ role: 'user', content: prompt }],
  temperature: 0.1,
  response_format: { type: 'json_object' },
});
```

### 4. 触发时机：对话完成后入队

在 `processGroupMessages()` 的 `runAgent()` 返回后，将最近消息入队：

```typescript
// Agent 回复完成后
if (memoryEnabled) {
  memoryQueue.add(group.folder, recentMessages);
}
```

防抖 30 秒——同一 group 的多次快速对话只触发一次记忆更新。

### 5. 注入方式：CLAUDE.md Memory section

每次启动容器前，从 storage 加载记忆，格式化后写入 group 目录的 `CLAUDE.md`：

```markdown
## Memory

User Context:
- Work: Senior engineer at TierII Tech, building Nine AI platform...
- Current Focus: NanoClaw migration, Feishu channel integration...

History:
- Recent: Explored DeerFlow memory system, implemented sandbox optimization...

Facts:
- [knowledge | 0.95] Proficient in TypeScript, Python, Go
- [preference | 0.90] Prefers concise responses, dislikes verbose explanations
- [context | 0.85] Uses Mac mini as development machine
```

Claude Code SDK 在启动时自动读取 CLAUDE.md，记忆自然注入上下文。

### 6. 语义去重：cosine > 0.95

新 fact 存入前，与已有 facts 计算 cosine similarity。超过 0.95 视为重复，跳过。暴力遍历，facts 数量小时性能可接受。

### 7. Prompt 模板：直接复用 DeerFlow

MEMORY_UPDATE_PROMPT 是 DeerFlow 迭代多版的核心 IP（~340 行），直接翻译为 TypeScript 常量。不改动 prompt 内容，只做语言适配。

### 8. 凭证管理：DashScope key 走 .env 不走 OneCLI

OneCLI 的职责是给**容器内请求**做代理注入。记忆模块跑在**宿主机主进程**，直接调 DashScope API，不经过容器代理链路。这与飞书 APP_ID/SECRET 同理——宿主机进程的凭证统一放 .env，只有容器内的 Anthropic key 走 OneCLI。

### 9. 记忆注入标记

使用 HTML 注释标记 `<!-- nanoclaw:memory:start -->` / `<!-- nanoclaw:memory:end -->` 包裹 Memory section，避免与用户手写的 `## Memory` 冲突。

### 10. 启用逻辑

MEMORY_ENABLED 默认 false。当 DASHSCOPE_API_KEY 已配置时可手动设为 true。也支持 auto 模式：检测到 DASHSCOPE_API_KEY 存在时自动启用。

## Risks / Trade-offs

- **[DashScope API 不可用]** → 记忆更新静默失败，不影响正常对话。下次 API 恢复后自动补上
- **[LLM 返回格式错误]** → JSON 解析失败时用 json-repair 库兜底，仍失败则跳过本次更新
- **[SQLite 并发写入]** → NanoClaw 是单进程，不存在并发问题。防抖队列已序列化处理
- **[facts 膨胀]** → enforce_max_facts 按 (confidence + 时间衰减) 排序清理，上限 100 条
- **[embedding 维度变化]** → 如果将来换模型，需要重建向量。配置 MEMORY_EMBEDDING_DIMS 可调
- **[CLAUDE.md 覆盖冲突]** → 使用 HTML 注释标记包裹，不影响用户手写内容
- **[记忆只有用户消息]** → 必须将 Agent 回复也入队，否则 LLM 无法理解对话主题。onOutput 回调中收集 Agent 回复文本，与用户消息一起入队
- **[向量语义去重性能]** → O(n) 暴力 cosine 扫描，n<500 时毫秒级。embedding BLOB 反序列化：Buffer → Float32Array
