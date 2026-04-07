## Tasks

### T1: 基础设施（config + storage + embeddings）
**Files:** `src/memory/config.ts`, `src/memory/storage.ts`, `src/memory/embeddings.ts`
**Spec refs:** R3, R4, R7

1. 创建 `src/memory/config.ts`
   - MemoryConfig 接口定义
   - getMemoryConfig() 从环境变量加载配置
   - 所有默认值与 spec R7 一致

2. 创建 `src/memory/storage.ts`
   - 使用 better-sqlite3（NanoClaw 已有依赖）
   - initMemoryDb()：创建 memory_profiles + memory_facts 表（IF NOT EXISTS）
   - loadProfile / saveProfile：per-group JSON 读写
   - loadFacts / storeFacts / removeFacts：CRUD
   - 字符串精确去重 + cosine 语义去重（> 0.95）
   - enforceMaxFacts：按 (confidence + recency) 评分，删除超限项
   - embedding 存储为 Buffer（Float32Array 序列化）

3. 创建 `src/memory/embeddings.ts`
   - 使用 `openai` npm 包调 DashScope 兼容 API
   - getEmbedding(text): Promise<number[] | null>
   - cosineSimilarity(a, b): number
   - API 失败返回 null + 日志

4. 更新 `.env.example`：添加所有 MEMORY_* 和 DASHSCOPE_* 环境变量

**验收：** npm run build 通过，storage 单元测试通过

### T2: Prompt 模板移植
**Files:** `src/memory/prompt.ts`
**Spec refs:** R5

1. 移植 MEMORY_UPDATE_PROMPT 常量（从 Nine prompt.py 直接翻译）
2. 实现 formatMemoryForInjection(memoryData, maxTokens)
   - 按 DeerFlow 格式输出：User Context → History → Facts
   - Facts 按置信度降序，在 token 预算内填充
   - token 估算用 len/4
3. 实现 formatConversationForUpdate(messages)
   - 格式化为 "User: ... / Assistant: ..." 文本
   - 截断过长消息（>1000 字符）
   - 清除上传文件标签

**验收：** npm run build 通过，prompt 格式化单元测试通过

### T3: 防抖队列 + LLM 更新器
**Files:** `src/memory/queue.ts`, `src/memory/updater.ts`
**Spec refs:** R1, R2

1. 创建 `src/memory/queue.ts`
   - MemoryUpdateQueue 类
   - add(groupFolder, messages)：入队 + 防抖 reset
   - setTimeout 替代 Python threading.Timer
   - 同 groupFolder 覆盖旧消息
   - flush()：立即处理
   - 处理完成后如有新入队，重新计时

2. 创建 `src/memory/updater.ts`
   - MemoryUpdater 类
   - updateMemory(groupFolder, messages): Promise<boolean>
   - 完整流程：load → format → LLM call → parse JSON → apply updates
   - LLM 调用 Qwen3.6-plus via DashScope OpenAI 兼容 API
   - JSON 解析失败时尝试 json-repair
   - 应用增量更新：profile sections + new facts + remove facts
   - 清除上传文件相关内容

**验收：** npm run build 通过，queue 防抖逻辑单元测试通过

### T4: 记忆注入 + 集成
**Files:** `src/memory/index.ts`, `src/memory/inject.ts`, 修改 `src/index.ts`, 修改 `src/container-runner.ts`
**Spec refs:** R6, R8

1. 创建 `src/memory/inject.ts`
   - injectMemory(groupFolder, groupDir): Promise<void>
   - 加载 profile + facts → formatMemoryForInjection
   - 读取 CLAUDE.md → 替换/追加 ## Memory section → 写回
   - 记忆为空时不操作

2. 创建 `src/memory/index.ts`
   - 统一入口：export { memoryQueue, injectMemory, getMemoryConfig }
   - 初始化：调 initMemoryDb()

3. 修改 `src/index.ts`
   - processGroupMessages() 完成后：收集 Agent 回复文本（从 onOutput 回调中）+ 用户消息，一起入队 memoryQueue.add(group.folder, fullConversation)
   - 只在 MEMORY_ENABLED=true 时执行
   - shutdown() handler 中调用 memoryQueue.flush()

4. 修改 `src/container-runner.ts`（或调用方）
   - runContainerAgent() 前调 injectMemory(group.folder, groupDir)
   - 仅 MEMORY_INJECTION_ENABLED=true 时执行

**验收：** npm run build 通过，全量测试通过（257+），手动验证记忆注入到 CLAUDE.md

### T5: 双路召回系统
**Files:** `src/memory/keyword-store.ts`, `src/memory/hybrid.ts`, `src/memory/mmr.ts`, `src/memory/temporal-decay.ts`, `src/memory/memory-store.ts`
**Spec refs:** R9-R14

1. 创建 `src/memory/temporal-decay.ts`
   - toDecayLambda(halfLifeDays): 半衰期→衰减常数
   - calculateDecayMultiplier(ageDays, halfLifeDays): 指数衰减乘数
   - applyDecayToResults(results, halfLifeDays): 批量时间衰减
   - 直接从 Nine temporal_decay.py 翻译

2. 创建 `src/memory/mmr.ts`
   - tokenize(text): 分词为 Set（支持中日韩）
   - jaccardSimilarity(setA, setB): 文本相似度
   - cosineSimilarity(vecA, vecB): 向量相似度（已在 embeddings.ts 有，复用）
   - mmrRerank(items, lambdaParam, embeddings?): MMR 贪心重排
   - 直接从 Nine mmr.py 翻译

3. 创建 `src/memory/keyword-store.ts`
   - 使用 SQLite FTS5 虚拟表 `memory_facts_fts`
   - initFtsTable(): CREATE VIRTUAL TABLE IF NOT EXISTS
   - syncFtsInsert/syncFtsDelete: 与 memory_facts 表同步
   - search(query, groupFolder, topK): FTS5 MATCH 查询
   - 分数归一化：abs(rank) / (1 + abs(rank))
   - FTS5 不可用时回退 LIKE（与 Nine 一致）

4. 创建 `src/memory/hybrid.ts`
   - mergeHybridResults(vectorResults, keywordResults, options)
   - 按 ID 合并 → 加权分数(0.7/0.3) → 时间衰减 → 排序 → MMR
   - 直接从 Nine hybrid.py 翻译

5. 创建 `src/memory/memory-store.ts`
   - MemoryStore 类
   - recall(query, topK=5): 双路检索 → 融合 → top-K
   - store(content, metadata): 写入 SQLite + FTS5 + embedding
   - 向量检索：从 SQLite 加载 group 所有 fact embeddings，暴力 cosine

**验收：** npm run build 通过，各模块单元测试通过

### T6: 注入改造 + 集成测试
**Files:** 修改 `src/memory/inject.ts`, `src/memory/memory.test.ts`
**Spec refs:** R15

1. 修改 injectMemory：
   - profile 全量注入
   - facts 走 MemoryStore.recall(latestUserMessage) 双路召回 top-K
   - latestUserMessage 为空时 fallback 全量注入

2. 修改 src/index.ts：传 latestUserMessage 给 injectMemory

3. 综合测试：
   - config 测试：默认值、环境变量覆盖
   - storage 测试：CRUD、去重、enforceMaxFacts
   - embeddings 测试：mock DashScope API、cosineSimilarity 计算
   - queue 测试：入队、覆盖、防抖触发
   - prompt 测试：formatMemoryForInjection 输出格式、token 截断
   - inject 测试：CLAUDE.md 读写、标记替换
   - recall 测试：双路检索、融合排序、MMR
   - keyword-store 测试：FTS5 和 LIKE 回退
   - temporal-decay 测试：衰减计算
   - mmr 测试：重排序多样性

**验收：** npx vitest run 全部通过

### 依赖顺序
```
T1 ‖ T2 → T3 → T4
              ↘
               T5 → T6
```
- T1（基础设施）和 T2（prompt）可并行
- T3（queue+updater）依赖 T1+T2
- T4（集成）依赖 T3
- T5（双路召回）依赖 T1（storage+embeddings）
- T6（注入改造+测试）依赖 T4+T5
