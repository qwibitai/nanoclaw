# NanoClaw 智能 Token 优化需求文档

> 版本：v1.0
> 日期：2026-03-11

---

## 背景

NanoClaw 每次 API 调用的 token 成本构成（贵→便宜）：

- **Output token**：最贵，约 5 倍于 input 价格
- **对话历史**：最大变量，session 不压缩则无限膨胀
- **Tool Results**：工具调用原始返回，用完即废但持续占位
- **System Prompt / CLAUDE.md**：固定开销，每次都带

目标：在每次对话的处理链路上自动介入，从源头预防浪费。

---

## 核心原则

> **只要是纯计算逻辑（不调 LLM），不管多复杂都做；只要调 LLM，就要严格评估 token 成本。**

---

## 机制一：Inline Compaction

### 解决的问题

对话历史 + Tool Results 无限膨胀。

### 触发逻辑（零 token）

```
每次 API 调用前：
  检查当前 context 大小（transcript 文件大小估算 token 数）
  如果 > 阈值（80KB）：
    在本次调用的 system prompt 里注入 compact 指令
    Claude 本次回复顺带输出 <compact_summary>
    提取摘要，写入 seed 文件
    下次 session 启动时加载 seed，丢弃完整历史
```

**关键**：不等到下一轮，当轮触发，当轮处理。

### 成本分析

| | 单独 compact 调用 | Inline compaction |
|---|---|---|
| Input | 全量历史（重新传一遍）| 0（历史本来就在 messages 里）|
| Output | 摘要 | 摘要（同样的输出，挪过来了）|
| **净成本** | **全量历史 input + 摘要 output** | **仅摘要 output（本来就要付）** |

### 分内容压缩策略

不同内容类型混在一起压缩会导致语义混乱，必须分开处理。

#### Tool Results（最激进）

| 范围 | 处理方式 |
|------|----------|
| 最近 2 轮的 tool results | 保留原文（可能仍被追问） |
| 更早的 tool results | 极度激进压缩，只保留结论 |

**权重**：`read_file` 类保留权重 1.5，`bash` 一次性命令保留权重 0.8。

**不立即压缩的原因**：同 session 内用户可能追问工具结果细节，立即压缩会丢失上下文。

#### 对话历史（滑动窗口 + 增量摘要）

```
[已有摘要 seed]  +  [最近 N 轮原文]
      ↓                    ↓
  上次压缩的结果        保留完整原文

触发下次压缩时：
  只压缩「N+1 轮到最新轮之前」的新增内容
  合并进已有摘要
  最新 N 轮继续保留原文
```

**每次压缩只处理新增内容，不重新处理已压缩的摘要，避免重复成本。**

#### 对话摘要结构

```xml
<conversation_summary>
  <completed>已完成的事项</completed>
  <pending>待完成 / 进行中的任务</pending>
  <context>关键背景、约束、用户偏好</context>
  <decisions>重要决策和结论</decisions>
</conversation_summary>
```

增量合并时只更新变化的 section，不整段重写。

### 完整 compact 输出结构

```xml
<compact_summary>
  <tool_results>
    <!-- 2轮前的工具调用结论 -->
  </tool_results>
  <conversation_summary>
    <completed>...</completed>
    <pending>...</pending>
    <context>...</context>
    <decisions>...</decisions>
  </conversation_summary>
</compact_summary>
```

### 动态参数（零 token，纯计算）

**保留轮数（无硬上限，下限类型感知）：**

```
可用 token 预算 = 阈值 - system_prompt 大小 - 当前消息大小 - seed 大小
保留轮数 = 可用预算 ÷ 近期平均轮大小

下限：
  独立问答型对话 → 最少保留 1 轮
  连续任务型对话 → 最少保留 3 轮
上限：
  无硬上限，由预算决定
```

**效果**：短消息对话自动保留更多轮（便宜），长消息对话自动少保留（省钱）。

---

## 机制二：响应长度控制

### 解决的问题

Output token 浪费（output 比 input 贵 5 倍）。

### 约束指令

一条通用软约束，不做消息类型分类（分类逻辑脆弱，误判代价高于不分类）：

```
回复时结论优先，能一句话说清的不写三句，细节按需展开，不重复已知信息。
```

### 注入时机（两个条件取「或」）

**条件一：周期保底**
```
距上次注入，新增 context 超过 X token
X = compaction 阈值 ÷ 2（复用 compaction 的 token 计数逻辑，无新增状态）
```

**条件二：漂移修正**
```
满足任一：
  上一轮 output > 近期均值 × 系数（相对漂移）
  上一轮 output > Y token（绝对上限兜底）

初始参数：
  系数 = 1.5
  Y = 700 token（Telegram 场景）
```

**Y 存在的意义**：当 input 很大时，output 合理变长，纯系数无法区分「正常变长」和「指令遗忘漂移」，绝对值兜底解决这个盲点。

### 参数自优化（零 token，纯计算）

```
注入提醒后，记录下一轮 output token 数：

下一轮明显变短 → 阈值合适，不调整
下一轮没变化   → 阈值太松，系数 × 0.9（收紧）
长期无触发     → 阈值太紧，系数 × 1.1（放宽）
```

数据来源：`data/shared/usage/usage.db`，无需新增基础设施。

### 成本

| 状态 | token 成本 |
|------|------------|
| 注入时 | 约 30 token |
| 平均摊薄 | < 3 token / 轮 |
| 不满足条件时 | 0 |

---

## 机制三：CLAUDE.md 自动压缩

### 解决的问题

CLAUDE.md 随 Agent auto-memory 自动写入而持续膨胀，每次对话都带着越来越大的 system prompt。

### 触发逻辑（零 token）

```
每次读取 CLAUDE.md 时，检查文件大小
超过阈值 → 在本次调用 inline 注入压缩指令
（与机制一完全相同的思路，不单独发起额外调用）
```

### 压缩策略

| 内容类型 | 处理方式 |
|----------|----------|
| 规则、禁止项、必须项、格式要求 | **原文保留，不许改动** |
| 背景说明、解释性文字 | 激进压缩或删除 |
| 举例 | 保留最多一个，其余删除 |
| 重复表达 | 删除重复，保留一处 |

**原理**：LLM 不需要知道「为什么」，只需要知道「是什么」。删除解释类内容不只省 token，还可能提升指令遵守率（规则不被大量解释稀释）。

### 验证（零 token，纯字符串匹配）

```
提取原文中包含约束关键词的行：
  「禁止」「必须」「不能」「需要」「不许」「要」等

压缩后逐一检查这些行是否仍然存在：
  全部存在 → 自动应用压缩版本
  有缺失   → 记录日志，等待人工处理（不自动应用）
```

### 成本

- 触发检测：零 token
- 压缩调用：有 token，但 inline 进正常调用，无额外成本
- 结构化验证：零 token
- 人工介入：仅验证失败时

---

## 实现文件

| 文件 | 改动内容 |
|------|----------|
| `container/agent-runner/src/index.ts` | 机制一：compaction 检测、注入、提取；机制二：软约束注入逻辑；机制三：CLAUDE.md 大小检测与压缩注入 |
| `src/container-runner.ts` | 机制一：启动容器时加载 seed 文件作为初始 context |
| `src/index.ts` | 机制二：token 计数状态、自优化参数持久化 |

---

## 验证方式

1. **机制一**：发送多条消息直到 context > 80KB，确认当轮回复含 `<compact_summary>`，确认下轮 session token 用量骤降
2. **机制二**：发送「你好」确认回复简短；发送技术问题确认回复完整；观察 `usage.db` 中 output token 趋势
3. **机制三**：持续对话直到 CLAUDE.md 超阈值，确认自动压缩触发，确认关键词验证通过，确认文件大小下降

全程通过 `data/shared/usage/usage.db` 对比优化前后 input / output token 数据。
