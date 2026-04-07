# /llmlog — LLM 请求日志开关

## 触发条件

用户发送以下任意命令时执行本技能：
- `/llmlog on` — 开启本会话的 LLM 请求日志
- `/llmlog off` — 关闭本会话的 LLM 请求日志
- `/llmlog status` — 查看当前开关状态
- `/llmlog` — 查看当前开关状态（同 status）

## 说明

LLM 请求日志功能会拦截发往 Anthropic API 的完整请求和响应，保存为 JSON 文件。

- 标志文件路径：`/workspace/group/.llmlog_enabled`（存在 = 开启，不存在 = 关闭）
- 日志保存目录：`/workspace/group/llmlogs/`
- 每次会话启动时自动重置为关闭状态
- 每条日志文件名为请求时间戳，内容包含完整的请求体和响应体
- API Key 会自动脱敏（显示为 `[REDACTED]`）

## 执行步骤

### `/llmlog on`

```bash
touch /workspace/group/.llmlog_enabled
```

回复：`✅ LLM 请求日志已开启。后续 API 请求将保存到 /workspace/group/llmlogs/`

### `/llmlog off`

```bash
rm -f /workspace/group/.llmlog_enabled
```

回复：`⏹ LLM 请求日志已关闭。`

### `/llmlog status` 或 `/llmlog`

检查标志文件是否存在：

```bash
ls /workspace/group/.llmlog_enabled 2>/dev/null && echo "on" || echo "off"
```

同时列出已有的日志文件数量：

```bash
ls /workspace/group/llmlogs/ 2>/dev/null | wc -l
```

回复格式示例：
- `📋 LLM 请求日志：当前**开启**。已保存 3 条日志。`
- `📋 LLM 请求日志：当前**关闭**。已保存 0 条日志。`
