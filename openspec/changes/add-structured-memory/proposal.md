## Why

NanoClaw 当前没有跨 session 的长期记忆能力。每次 Claude Code session compaction 后，历史上下文只剩摘要，用户偏好、工作背景、常用工具等信息会丢失。这导致 Agent 在长期使用中无法积累对用户的理解，每次对话都像"初次见面"。

DeerFlow 开源项目实现了一套成熟的结构化记忆系统（已被 Nine 平台成功移植验证），核心设计是：对话结束后异步提取记忆 → 结构化存储（用户画像 + 知识点） → 下次对话时注入 system prompt。这套方案经过生产验证，适合移植到 NanoClaw。

## What Changes

- 新增 `src/memory/` 目录（6 个文件）：config、queue、updater、storage、embeddings、prompt
- 新增 `src/memory/index.ts`：统一入口
- 修改 `src/index.ts`：对话完成后将消息入队记忆更新
- 修改容器启动逻辑：Agent 启动前将记忆注入 CLAUDE.md 的 `## Memory` section
- 新增 `store/memory.db`：SQLite 记忆存储（profiles + facts + vectors）
- 修改 `.env.example`：添加记忆相关环境变量
- 修改 `package.json`：添加 `openai` SDK 依赖（用于调 DashScope 兼容 API）

## Capabilities

### New Capabilities
- `structured-memory`: 结构化长期记忆系统，包含防抖队列、LLM 记忆提取（Qwen3.6-plus）、DashScope text-embedding-v4 向量化、SQLite 存储、system prompt 注入
- `memory-recall`: 双路记忆召回系统，包含向量近邻搜索 + 关键词匹配（SQLite FTS5）、混合融合排序、时间衰减、MMR 多样性重排。与 Nine/DeerFlow 一致

### Modified Capabilities
（无既有 spec 需修改）

## Impact

- **依赖**: 新增 `openai` npm 包（调 DashScope 兼容 API）
- **环境变量**: 新增 MEMORY_ENABLED、DASHSCOPE_API_KEY、DASHSCOPE_BASE_URL 等
- **存储**: 新增 SQLite 数据库 `store/memory.db`（自动创建）
- **外部服务**: 依赖 DashScope API（embedding + LLM），需要阿里云 API Key
- **性能**: 记忆更新是异步后台任务，不影响消息响应延迟
- **兼容性**: 纯增量变更，MEMORY_ENABLED=false 时完全不影响已有功能
