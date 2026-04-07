## Capability: structured-memory

### Overview
结构化长期记忆系统，从 DeerFlow 移植。对话结束后异步提取用户偏好、知识点、工作背景等信息，持久化存储，下次对话时自动注入 Agent 上下文。

### Requirements

#### R1: 防抖队列（MemoryUpdateQueue）
- R1.1: 对话完成后，将 group_folder + 完整对话消息（用户 + Agent 回复）入队
- R1.2: 同一 group_folder 的多次入队，只保留最新消息（覆盖旧的）
- R1.3: 防抖时间默认 30 秒（MEMORY_DEBOUNCE_SECONDS 可配）
- R1.4: 防抖到期后，批量触发所有待处理 group 的记忆更新
- R1.5: 更新过程中有新入队，等当前批次完成后重新计时
- R1.6: 提供 flush() 方法强制立即处理（graceful shutdown 用）
- R1.7: 批量处理多 group 时，每个更新之间延迟 500ms 防限流

#### R2: 记忆提取（MemoryUpdater）
- R2.1: 加载 group 当前的 profile + facts
- R2.2: 用 format_conversation_for_update() 格式化对话消息
- R2.3: 组装 MEMORY_UPDATE_PROMPT（当前记忆 + 新对话）
- R2.4: 调 Qwen3.6-plus（DashScope 兼容 API）生成更新 JSON
- R2.5: temperature=0.1，使用 json_object response_format
- R2.6: JSON 解析失败时用 json-repair 兜底
- R2.7: 应用增量更新：更新 profile sections + 新增 facts + 删除被否定的 facts
- R2.8: 清除文件上传相关内容（session 级临时数据不该持久化）

#### R3: 存储层（MemoryStorage）
- R3.1: SQLite 数据库 `store/memory.db`，启动时自动创建表
- R3.2: memory_profiles 表：group_folder (PK) + profile_json (TEXT) + updated_at
- R3.3: memory_facts 表：id (PK) + group_folder + content + category + confidence + source + embedding (BLOB) + created_at
- R3.4: load_profile(group_folder) / save_profile(group_folder, data)
- R3.5: load_facts(group_folder) / store_facts(group_folder, facts) / remove_facts(fact_ids)
- R3.6: 新 fact 存入前进行字符串精确去重
- R3.7: 新 fact 存入前进行向量语义去重（cosine > 0.95 视为重复）
- R3.8: enforce_max_facts(group_folder, max=100)：按 (confidence + 时间衰减) 排序，删除超限 facts
- R3.9: embedding 存储为 Float32Array 序列化的 BLOB

#### R4: 向量化（Embeddings）
- R4.1: 使用 DashScope text-embedding-v4（1024 维）
- R4.2: 通过 OpenAI SDK 兼容 API 调用
- R4.3: 环境变量：DASHSCOPE_API_KEY（必填）、DASHSCOPE_BASE_URL（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
- R4.4: 提供 getEmbedding(text): Promise<number[] | null>
- R4.5: API 失败时返回 null，调用方需处理

#### R5: Prompt 模板
- R5.1: MEMORY_UPDATE_PROMPT 从 DeerFlow/Nine 直接移植（~100 行英文）
- R5.2: format_memory_for_injection(memoryData, maxTokens): 格式化记忆为注入文本
- R5.3: format_conversation_for_update(messages): 格式化对话消息为更新输入
- R5.4: token 计算用字符估算（len/4），不引入 tiktoken 依赖
- R5.5: facts 注入时按置信度降序排列，在 token 预算内尽量多填

#### R6: 记忆注入
- R6.1: 每次启动 Agent 容器前，调用 injectMemory(groupFolder)（仅 MEMORY_INJECTION_ENABLED=true 时）
- R6.2: 从 storage 加载 profile + facts
- R6.3: 用 format_memory_for_injection() 格式化
- R6.4: 写入 group 目录 CLAUDE.md，用 `<!-- nanoclaw:memory:start -->` / `<!-- nanoclaw:memory:end -->` 标记包裹
- R6.5: 只替换标记之间的内容，不影响 CLAUDE.md 其他部分
- R6.6: 记忆为空时不写入（不创建空 section）

#### R7: 配置
- R7.1: MEMORY_ENABLED（默认 false，设为 auto 时有 DASHSCOPE_API_KEY 自动启用）— 总开关
- R7.2: MEMORY_DEBOUNCE_SECONDS（默认 30）— 防抖秒数
- R7.3: MEMORY_MAX_FACTS（默认 100）— 每 group 最大 facts 数
- R7.4: MEMORY_FACT_CONFIDENCE_THRESHOLD（默认 0.7）— fact 最低置信度
- R7.5: MEMORY_MAX_INJECTION_TOKENS（默认 1500）— 注入最大 token 数
- R7.6: DASHSCOPE_API_KEY — DashScope API Key（embedding + LLM 共用）
- R7.7: DASHSCOPE_BASE_URL（默认 https://dashscope.aliyuncs.com/compatible-mode/v1）
- R7.8: MEMORY_EMBEDDING_MODEL（默认 text-embedding-v4）
- R7.9: MEMORY_LLM_MODEL（默认 qwen3.6-plus）
- R7.10: MEMORY_INJECTION_ENABLED（默认 true）— 独立控制注入开关，可只收集不注入（调试用）
- R7.11: MEMORY_EMBEDDING_DIMS（默认 1024）— embedding 维度
- R7.12: 所有配置通过 readEnvFile() 读取，与 NanoClaw 其他配置一致

#### R5.3 补充：消息字段映射
- is_bot_message === true 或 is_from_me === true → "Assistant: {content}"
- 其余 → "User ({sender_name}): {content}"（保留发送者名称，群聊场景有用）

#### R8: 集成点
- R8.1: src/index.ts processGroupMessages() 完成后，收集 Agent 回复文本 + 用户消息一起入队
- R8.2: src/container-runner.ts runContainerAgent() 启动前注入记忆
- R8.3: 模块入口 src/memory/index.ts，export { memoryQueue, injectMemory, getMemoryConfig }
- R8.4: src/index.ts shutdown() handler 中调用 memoryQueue.flush()

### Edge Cases
- DashScope API 不可用 → 静默失败，记录日志，不影响正常对话
- LLM 返回非法 JSON → json-repair 兜底，仍失败则跳过
- Group 首次使用 → profile 为空，facts 为空，正常走更新流程
- 对话只有 1 条消息 → 正常提取，可能产出较少信息
- MEMORY_ENABLED=false → 完全 bypass，不加载任何记忆模块
- CLAUDE.md 不存在 → 创建文件并写入 Memory section
- CLAUDE.md 无 Memory section → 追加到文件末尾
