---
name: add-generic-llm
description: Add a generic OpenAI-compatible LLM provider (DeepSeek/GLM) for text-only responses
---

# Add Generic LLM Provider (DeepSeek / GLM)

本技能为 NanoClaw 添加一个**通用 LLM 提供方**，使用 OpenAI 兼容的 Chat Completions API（如 DeepSeek、智谱 GLM）。启用后，容器内的 agent-runner 将切换到**文本生成模式**，不再依赖 Claude 的工具套件（Bash/Read/Write/MCP 等）。适合通知、简单问答和基础总结场景。

## 能力与限制
- 支持 DeepSeek 与智谱 GLM（或其他 OpenAI 兼容接口）
- 保留 NanoClaw 的消息路由、容器隔离、组上下文
- 不支持 Claude Code 的工具调用、Agent Teams、MCP 集成（若需要这些，请继续使用 Claude）

## 环境配置
在项目 `.env` 添加以下变量：
```bash
LLM_PROVIDER=generic
LLM_API_BASE=https://api.deepseek.com/v1      # DeepSeek
# 或 GLM: https://open.bigmodel.cn/api/paas/v4
LLM_MODEL=deepseek-chat                       # 对应的模型名
LLM_API_KEY=sk-xxxxxx                         # 你的 API Key
```

## 应用技能
```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-generic-llm
```

这会：
- 添加 `container/agent-runner/src/provider-generic-llm.ts`（通用 LLM 调用逻辑）
- 修改 `container/agent-runner/src/index.ts` 增加提供方切换（如检测到 `LLM_PROVIDER=generic`）
- 扩展宿主侧 `src/container-runner.ts`，把上述 LLM 环境变量作为密钥传入容器（仅进程内可见）

## 运行与验证
- 设置好 `.env`，重启 NanoClaw
- 发送消息，容器会调用通用 LLM，并将结果以 `---NANOCLAW_OUTPUT_START---/END` 标记返回
- 如果需要恢复 Claude 能力：移除 `LLM_PROVIDER` 或清空 `LLM_API_KEY/BASE/MODEL` 即可

## 选择建议
- 需要工具调用、代码执行、Web 抓取、MCP 集成：继续使用 Claude 模式
- 仅需纯文本对话/摘要：可以使用通用 LLM，成本可能更低

