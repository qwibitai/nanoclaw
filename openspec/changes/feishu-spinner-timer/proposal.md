# Proposal: 飞书进度卡片 — 自动旋转 Spinner + 计时器

## 问题

当前进度卡片的 spinner 只在收到容器 progress 事件时更新（`frame++`）。如果容器 10 秒没有新 progress（比如 LLM 思考中、长时间 tool 执行），卡片"冻住"——用户以为机器人卡死了。

## 方案

在 `setTyping(jid, true)` 时启动一个独立的 `setInterval` 定时器，**每 3 秒自动 patch 卡片**，让 spinner 持续旋转 + 显示已用时间（如 `⣾ 思考中... (32s)`）。

### 改动点

1. **`src/channels/feishu.ts`**（唯一改动文件）
   - 新增 `spinnerTimers: Map<string, NodeJS.Timeout>` 存储每个 chat 的定时器
   - `setTyping(jid, true)` 创建进度卡片后启动 `setInterval`（3s 间隔）
   - 定时回调：`frame++`，重新 `buildProgressCard`，调 `message.patch`
   - `setTyping(jid, false)`、卡片完成、容器超时时清理定时器
   - 定时器硬上限 10 分钟自动销毁（兜底防泄露）

2. **`buildProgressCard`** 函数签名新增 `startTime?: number` 参数
   - 计算 `elapsed = Date.now() - startTime`，格式化为 `Xs` 或 `Xm Ys`
   - header 显示 `${spinner} ${phrase}... (${timeStr})`

### 不改动

- `container-runner.ts` — 不变
- `container/agent-runner/` — 不变
- 其他 channel — 不变
- 进度卡片的 step 累积逻辑 — 不变（progress 事件仍然正常 push step）

## 约束

- 飞书 `message.patch` API 限频 ~5 QPS/app，3s 间隔 = 0.33 QPS，安全
- 定时器必须三重清理：setTyping(false) + 卡片完成 + 10 分钟硬上限
- 定时器不能泄露（即使容器异常退出也要被清理）
