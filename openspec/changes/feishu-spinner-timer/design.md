# Design: 飞书进度卡片 Spinner + 计时器

## D1: 新增状态存储

```typescript
// feishu.ts — FeishuChannel 类新增成员
private spinnerTimers = new Map<string, NodeJS.Timeout>();
```

progressCards map 的 entry 新增 `startTime: number` 字段：

```typescript
private progressCards = new Map<
  string,
  {
    messageId: string;
    steps: ProgressStep[];
    frame: number;
    startTime: number;       // ← 新增：Date.now() at creation
    usage?: ContainerOutput['usage'];
  }
>();
```

---

## D2: buildProgressCard 增加计时显示

```typescript
function buildProgressCard(
  steps: ProgressStep[],
  frame: number = 0,
  startTime?: number,       // ← 新增参数
): string {
  const spinner = SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
  const phrase =
    THINKING_PHRASES[
      Math.floor(frame / SPINNER_FRAMES.length) % THINKING_PHRASES.length
    ];

  // 计时器显示
  let timeStr = '';
  if (startTime) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed >= 60) {
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timeStr = ` (${min}m${sec}s)`;
    } else {
      timeStr = ` (${elapsed}s)`;
    }
  }

  const elements = steps.map(stepToElement);

  return JSON.stringify({
    schema: '2.0',
    header: {
      template: 'yellow',
      title: { tag: 'plain_text', content: `${spinner} ${phrase}...${timeStr}` },
    },
    body: { elements },
  });
}
```

---

## D3: setTyping(jid, true) — 启动定时器

在现有创建进度卡片代码之后，启动 spinner 定时器：

```typescript
// 在 progressCards.set(jid, {...}) 之后：

const SPINNER_INTERVAL_MS = 3000;
const SPINNER_MAX_DURATION_MS = 10 * 60 * 1000; // 10 分钟硬上限

// 清理可能残留的旧定时器
const oldTimer = this.spinnerTimers.get(jid);
if (oldTimer) clearInterval(oldTimer);

const spinnerStartTime = Date.now();
const timer = setInterval(async () => {
  const entry = this.progressCards.get(jid);
  if (!entry) {
    // 卡片已被删除（完成/清理），停止定时器
    this.clearSpinnerTimer(jid);
    return;
  }

  // 硬上限保护
  if (Date.now() - spinnerStartTime > SPINNER_MAX_DURATION_MS) {
    logger.warn({ jid }, 'Spinner timer 达到 10 分钟上限，自动停止');
    this.clearSpinnerTimer(jid);
    return;
  }

  entry.frame++;
  try {
    await this.client.im.message.patch({
      path: { message_id: entry.messageId },
      data: {
        content: buildProgressCard(entry.steps, entry.frame, entry.startTime),
      },
    });
  } catch (err) {
    logger.debug({ err, jid }, 'Spinner 自动刷新失败（非致命）');
  }
}, SPINNER_INTERVAL_MS);

this.spinnerTimers.set(jid, timer);
```

---

## D4: clearSpinnerTimer 辅助方法

```typescript
private clearSpinnerTimer(jid: string): void {
  const timer = this.spinnerTimers.get(jid);
  if (timer) {
    clearInterval(timer);
    this.spinnerTimers.delete(jid);
  }
}
```

---

## D5: 三个清理点

### 清理点 1: setTyping(jid, false)

在 `setTyping` 的 `else`（isTyping=false）分支开头调：
```typescript
this.clearSpinnerTimer(jid);
```

### 清理点 2: 卡片完成（sendMessage 中 progressEntry 删除时）

在 `this.progressCards.delete(jid)` 之前或之后调：
```typescript
this.clearSpinnerTimer(jid);
```

### 清理点 3: 进度事件更新时跳过 patch

定时器和 progress 事件都会 patch 卡片。**不需要特殊处理**——progress 事件更新 `frame++` 和 `steps`，定时器下一次 tick 会读到最新值。两者写同一个 messageId，飞书 API 保证最后一次 patch 生效（无并发问题，都在同一个 Node.js 事件循环）。

---

## D6: progressCards.set 时记录 startTime

```typescript
// 现有代码改动：
this.progressCards.set(jid, {
  messageId: msgId,
  steps: initialSteps,
  frame: 0,
  startTime: Date.now(),  // ← 新增
});
```

---

## D7: 初始卡片也传 startTime

创建初始卡片时：
```typescript
content: buildProgressCard(initialSteps, 0, Date.now()),
```

---

## D8: progress 事件更新时也传 startTime

```typescript
// 在 existing.frame++ 之后的 patch 调用：
content: buildProgressCard(existing.steps, existing.frame, existing.startTime),
```
