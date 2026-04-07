# Tasks: 飞书进度卡片 Spinner + 计时器

> 单 PR 交付，只改 `src/channels/feishu.ts` 一个文件。

---

## T1: progressCards entry 新增 startTime 字段

- 在 `progressCards` Map 的 value type 新增 `startTime: number`
- 所有 `progressCards.set(...)` 调用补上 `startTime: Date.now()`
- 验收：TypeScript 编译通过，现有逻辑不受影响

## T2: buildProgressCard 增加计时显示

- 函数签名新增可选参数 `startTime?: number`
- 计算 elapsed 秒数，格式化为 `(Xs)` 或 `(XmYs)`
- 追加到 header title：`${spinner} ${phrase}... (32s)`
- 所有调用 `buildProgressCard` 的地方补传 `startTime`（共 3 处）：
  1. 初始创建卡片时
  2. progress 事件更新时
  3. 定时器 tick 时（T3 新增）
- 验收：卡片 header 显示计时

## T3: 新增 spinnerTimers Map + clearSpinnerTimer 方法

- `private spinnerTimers = new Map<string, NodeJS.Timeout>()`
- `private clearSpinnerTimer(jid: string): void` — clearInterval + delete
- 验收：方法存在，TypeScript 编译通过

## T4: setTyping(jid, true) 启动定时器

- 在创建进度卡片（`progressCards.set`）之后启动 `setInterval`
- 间隔：3000ms（常量 `SPINNER_INTERVAL_MS`）
- 每次 tick：entry.frame++，调 `message.patch` 更新卡片
- 硬上限：10 分钟（常量 `SPINNER_MAX_DURATION_MS`），超时自动 clearInterval + warn log
- 启动前清理可能残留的旧定时器（`clearSpinnerTimer(jid)`）
- 验收：setTyping(true) 后卡片每 3 秒自动更新

## T5: 三重清理

- **清理点 1**: `setTyping(jid, false)` 的 else 分支开头调 `clearSpinnerTimer(jid)`
- **清理点 2**: `sendMessage` 中 `progressCards.delete(jid)` 处调 `clearSpinnerTimer(jid)`
- **清理点 3**: 定时器 tick 发现 `progressCards.get(jid)` 为空时自动 `clearSpinnerTimer(jid)`
- 验收：
  - 正常完成 → 定时器被清理（无残留 interval）
  - 容器超时 → setTyping(false) 清理
  - 进度卡片被手动删除 → tick 时自检清理
  - 10 分钟硬上限 → 自动停止

## T6: 验证

- `npx tsc --noEmit` 编译通过
- `npx prettier --write src/channels/feishu.ts` 格式通过
- 手动检查：
  - SPINNER_INTERVAL_MS = 3000
  - SPINNER_MAX_DURATION_MS = 600000
  - 所有 buildProgressCard 调用都传了 startTime
  - clearSpinnerTimer 被调用了至少 3 处
- Git commit: `feat(feishu): 进度卡片自动旋转 spinner + 计时器`
