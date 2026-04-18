---
name: kickoff
description: 任务启动工作流。从上下文提取需求 → 改群名 → 开 worktree → 写 OpenSpec → 子 Agent 评审 → 修改 → 汇报。触发词：kickoff、开始任务、启动任务、开搞写spec。
---

# 任务启动工作流

一站式完成从需求梳理到规范评审的全流程。

## 幂等原则

**每步先检测，已有的跳过。** 用户可能已经手动完成了部分步骤（比如已经开了 worktree、已经写了 openspec），不要重复执行。

## 执行步骤

### Step 1: 提取需求 & 改群名

1. 从当前对话上下文中提取用户讨论的需求
2. 总结为 10-20 字的任务名
3. 调用 `rename_chat` 将群名改为任务名
4. 确认目标项目（NanoClaw / Nine / 其他），确定项目路径

### Step 2: 开 Worktree

1. **先检查**：如果当前已经在 worktree 中（`git rev-parse --show-toplevel` 指向 worktree 路径），跳过此步
2. 如果没有，使用 `EnterWorktree` 工具在目标项目中开一个隔离的 worktree
3. worktree 分支名建议用 `feat/<change-name>` 或 `fix/<change-name>`

### Step 3: 写 OpenSpec

1. **先检查**：运行 `openspec list`，如果已存在与当前任务相关的 change，跳过创建，直接检查已有 artifact 的完成度
2. 对于已有的 artifact（proposal.md / specs/ / design.md），如果文件已存在且非空，跳过
3. 只补写缺失的部分

按 OpenSpec 标准流程执行（先读 `container/skills/openspec/INSTRUCTIONS.md` 获取 CLI 用法）：

1. `openspec new change <name> --description "描述"`（如已存在则跳过）
2. `openspec instructions --change <name> proposal` → 写 proposal.md（如已存在则跳过）
3. `openspec instructions --change <name> specs` → 写 specs/（如已存在则跳过）
4. `openspec instructions --change <name> design` → 写 design.md（如已存在则跳过）

**不要在每个阶段停下来等确认，一路写完到 design。**

### Step 4: 子 Agent 评审

用 `Agent` 工具 spawn 一个评审 agent，prompt 要求：

- 角色：资深架构师，负责评审变更规范
- 输入：把 proposal.md、specs/、design.md 的内容喂给它
- 评审标准：
  - **完整性**：是否覆盖所有场景，有无遗漏的边界条件
  - **可行性**：技术方案是否可落地，有无明显的实现障碍
  - **风险点**：是否有安全、性能、兼容性方面的隐患
  - **简洁性**：是否过度设计，有无可以简化的部分
  - **可测试性**：关键逻辑是否可单元测试，有无纯函数可提取
- 输出：结构化的评审意见列表（问题 + 建议）

### Step 5: 修改

根据评审 agent 的反馈，修改 proposal / specs / design 中的问题。
只改有道理的建议，不合理的忽略（你来判断）。

### Step 6: 制定测试计划

在 design.md 末尾追加 `## 测试计划` 章节，包含：

1. **测试分层**：哪些函数/模块适合纯逻辑单测（零 mock），哪些需要 mock 外部依赖
2. **优先级**：按 P0（核心逻辑必测）、P1（重要路径）、P2（锦上添花）分级
3. **预估范围**：大约多少个测试用例，覆盖哪些文件

规则：
- 每个新增/修改的模块都必须有对应的单元测试
- 纯函数优先（零 mock、跑得快、不 flaky）
- 有外部依赖的函数用 mock 测试核心分支逻辑
- 测试是编码完成的必要条件，不是可选项

### Step 7: 汇报

向用户汇报，格式要求：

```
## 任务名

**一句话总结**：这个变更要做什么

**关键决策**：
- 决策 1
- 决策 2

**评审结果**：X 个问题已修复，Y 个忽略（附理由）

**测试计划**：X 个 P0 测试 + Y 个 P1 测试（简要描述）

**下一步**：等你确认后开始写代码 + 单测
```

要求：
- 总分结构，从顶层开始讲
- 简洁，不讲实现细节
- 不超过 20 行
