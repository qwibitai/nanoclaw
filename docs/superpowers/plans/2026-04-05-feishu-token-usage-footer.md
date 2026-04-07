# 飞书完成卡片 Token 用量脚注 Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 agent 回复后，在飞书完成卡片底部以灰色小字显示本次调用的 token 消耗信息。

**Architecture:** 数据从 container 内 SDK result 消息提取 → 通过 ContainerOutput 传递到宿主进程 → 飞书 channel 在 buildCompletedCard 时追加脚注行。

**Tech Stack:** TypeScript, Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`), 飞书卡片 schema 2.0

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `container/agent-runner/src/index.ts` | Modify (lines 641-653) | 从 SDK result 消息提取 usage 字段，写入 writeOutput |
| `src/container-runner.ts` | Modify (lines 171-178) | ContainerOutput 接口新增 usage 可选字段 |
| `src/channels/feishu.ts` | Modify (lines 94-119, 280-291) | buildCompletedCard 接收 usage 并渲染脚注；sendMessage 传递 usage |

---

## Chunk 1: Token 数据通道

### Task 1: ContainerOutput 接口新增 usage 字段

**Files:**
- Modify: `src/container-runner.ts:171-178`

- [ ] **Step 1: 在 ContainerOutput 接口添加 usage 可选字段**

```typescript
// src/container-runner.ts — ContainerOutput 接口
export interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string | null;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
  };
}
```

- [ ] **Step 2: 验证编译通过**

Run: `cd /Users/dajay/AI_Workspace/nanoclaw && npx tsc --noEmit`
Expected: 无新增错误（usage 是可选字段，现有代码无需修改）

- [ ] **Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: add usage field to ContainerOutput interface"
```

---

### Task 2: Agent runner 提取 SDK result 中的 usage 数据

**Files:**
- Modify: `container/agent-runner/src/index.ts:641-653`

- [ ] **Step 1: 修改 result 消息处理，提取 usage 字段**

在 `message.type === 'result'` 分支中，从 message 提取 usage 数据并传给 writeOutput：

```typescript
if (message.type === 'result') {
  resultCount++;
  const textResult =
    'result' in message ? (message as { result?: string }).result : null;

  // 提取 token 用量
  const msg = message as Record<string, unknown>;
  const rawUsage = msg.usage as Record<string, number> | undefined;
  const usage = rawUsage
    ? {
        inputTokens: rawUsage.input_tokens ?? 0,
        outputTokens: rawUsage.output_tokens ?? 0,
        cacheReadInputTokens: rawUsage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: rawUsage.cache_creation_input_tokens ?? 0,
        numTurns: (msg.num_turns as number) ?? 0,
        durationMs: (msg.duration_ms as number) ?? 0,
        totalCostUsd: (msg.total_cost_usd as number) ?? 0,
      }
    : undefined;

  log(
    `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
  );
  writeOutput({
    status: 'success',
    result: textResult || null,
    newSessionId,
    usage,
  });
}
```

- [ ] **Step 2: 重建容器镜像**

Run: `cd /Users/dajay/AI_Workspace/nanoclaw && ./container/build.sh`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat: extract token usage from SDK result message"
```

---

## Chunk 2: 飞书卡片脚注渲染

### Task 3: 飞书 channel 存储 usage 并在完成卡片中渲染

**Files:**
- Modify: `src/channels/feishu.ts:33-119, 143-146, 280-291`

- [ ] **Step 1: progressCards Map 增加 usage 存储**

在 `progressCards` Map 的值类型中添加 `usage` 字段：

```typescript
// 现有类型（约 line 143）
private progressCards = new Map<
  string,
  { messageId: string; steps: ProgressStep[]; frame: number; usage?: ContainerOutput['usage'] }
>();
```

需要在文件顶部导入 ContainerOutput：

```typescript
import type { ContainerOutput } from '../container-runner.js';
```

- [ ] **Step 2: sendMessage 中解析并存储 usage**

在 `sendMessage` 方法中，正式回复到达时（将进度卡片标记为完成之前），从 progress entry 中取 usage。需要在进度消息处理中存储 usage。

在 feishu.ts 的 sendMessage 方法中，找到处理 progress JSON 的部分，增加 usage 解析：

```typescript
// 在解析 progress payload 的位置，检测 usage 数据
// sendMessage 方法中，正式回复到达的分支：
const progressEntry = this.progressCards.get(jid);
if (progressEntry) {
  this.progressCards.delete(jid);
  try {
    await this.client.im.message.patch({
      path: { message_id: progressEntry.messageId },
      data: { content: buildCompletedCard(progressEntry.steps, progressEntry.usage) },
    });
  } catch (err) {
    logger.debug({ err }, '飞书进度卡片更新失败（非致命）');
  }
}
```

- [ ] **Step 3: 新增 setUsage 方法供宿主进程传入 usage**

在 Channel 接口不变的前提下，通过飞书 channel 特有的方法传入 usage：

```typescript
/** 设置指定 chat 的最新 usage 数据（下次 sendMessage 完成卡片时使用） */
setUsage(jid: string, usage: ContainerOutput['usage']): void {
  const entry = this.progressCards.get(jid);
  if (entry) {
    entry.usage = usage;
  }
}
```

- [ ] **Step 4: 修改 buildCompletedCard 渲染脚注**

```typescript
function buildCompletedCard(steps: ProgressStep[], usage?: ContainerOutput['usage']): string {
  const elements = steps.map((step) => {
    if (step.detail) {
      return {
        tag: 'collapsible_panel',
        expanded: false,
        background_color: 'grey',
        header: {
          title: { tag: 'markdown', content: step.title },
          vertical_align: 'center',
        },
        elements: [{ tag: 'markdown', content: step.detail }],
      };
    }
    return { tag: 'markdown', content: step.title };
  });

  // 添加 token 用量脚注
  if (usage) {
    const inp = usage.inputTokens.toLocaleString();
    const cacheRead = usage.cacheReadInputTokens.toLocaleString();
    const cacheCreate = usage.cacheCreationInputTokens.toLocaleString();
    const out = usage.outputTokens.toLocaleString();
    const turns = usage.numTurns;
    const dur = (usage.durationMs / 1000).toFixed(1);
    const cost = usage.totalCostUsd.toFixed(2);

    elements.push({ tag: 'hr' } as any);
    elements.push({
      tag: 'markdown',
      content: `<font color="grey">↑${inp}/${cacheRead}/${cacheCreate} ↓${out} 🔄${turns} ⏱${dur}s 💰≈$${cost}</font>`,
    });
  }

  return JSON.stringify({
    schema: '2.0',
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '✅ 已完成' },
    },
    body: { elements },
  });
}
```

- [ ] **Step 5: 验证编译通过**

Run: `cd /Users/dajay/AI_Workspace/nanoclaw && npx tsc --noEmit`
Expected: 编译通过

- [ ] **Step 6: Commit**

```bash
git add src/channels/feishu.ts
git commit -m "feat: render token usage footer in Feishu completed card"
```

---

### Task 4: 宿主进程串联 — 将 usage 从容器输出传递到飞书 channel

**Files:**
- Modify: `src/index.ts:397-437`

- [ ] **Step 1: 在 onOutput 回调中捕获 usage 并传给飞书 channel**

在 `src/index.ts` 的 onOutput 回调中，当收到带 usage 的 success 消息时，调用飞书 channel 的 setUsage：

```typescript
const output = await runAgent(
  group,
  prompt,
  chatJid,
  async (result) => {
    // 进度消息 — 转发给 channel 显示进度卡片
    if (result.status === 'progress' && result.result) {
      const payload = result.detail
        ? JSON.stringify({ title: result.result, detail: result.detail })
        : result.result;
      await channel.sendMessage(chatJid, payload);
      return;
    }

    // 传递 usage 数据到飞书 channel（在发送文本回复之前）
    if (result.usage && 'setUsage' in channel) {
      (channel as { setUsage: (jid: string, usage: typeof result.usage) => void }).setUsage(chatJid, result.usage);
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      // ... 现有逻辑不变
    }
    // ... 其余不变
  },
  latestUserMessage,
  memorySenderId,
);
```

- [ ] **Step 2: 编译验证**

Run: `cd /Users/dajay/AI_Workspace/nanoclaw && npx tsc --noEmit`
Expected: 编译通过

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: pass token usage from container output to Feishu channel"
```

---

### Task 5: 构建、部署、端到端验证

- [ ] **Step 1: 完整构建**

```bash
cd /Users/dajay/AI_Workspace/nanoclaw && npm run build
```

- [ ] **Step 2: 重建容器镜像**

```bash
cd /Users/dajay/AI_Workspace/nanoclaw && ./container/build.sh
```

- [ ] **Step 3: 重启服务**

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

- [ ] **Step 4: 在飞书群发送测试消息，验证完成卡片底部出现灰色 token 脚注**

Expected: 卡片底部出现灰色分割线和类似 `↑48,231/32,400/8,120 ↓2,156 🔄5 ⏱12.3s 💰≈$0.08` 的文字

- [ ] **Step 5: 验证无 usage 时不显示脚注（如容器报错等场景）**

Expected: 没有 usage 数据时卡片和以前一样，没有多余内容
