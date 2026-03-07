# Design: Bootstrap User Profile (BOOTSTRAP.md)

## Background

`groups/main/USER.md` 已有结构化模板，`process-runner.ts` 会在首次运行时自动创建它。但 USER.md 的字段（Name、称呼等）还是空的——没有机制引导用户主动填写。

openclaw 用 `BOOTSTRAP.md` 解决这个问题：首次运行时创建这个文件，agent 读到后以自然对话引导用户介绍自己，完成后写入 USER.md 并删掉 BOOTSTRAP.md。

## Goals

- 首次对话时，agent 主动认识用户，收集基本信息写入 USER.md
- 之后不再重复触发
- 实现尽量简单，不引入额外状态文件

## Non-Goals

- 不支持非 main group 的引导
- 不做结构化问卷（保持对话自然）
- 不记录引导完成时间戳（无需 workspace-state.json）

## Design

### 触发条件

**USER.md 的 Name 字段为空时**创建 BOOTSTRAP.md。

- Name 为空 = 从未完成引导
- Name 有值 = 引导已完成，不再触发
- 天然避免重复：agent 完成引导后填入 Name，下次启动检测到 Name 有值，不创建

### 变更点

#### 1. `src/process-runner.ts`

在 `prepareGroupDirs()` 中新增：

```typescript
function isUserProfileEmpty(groupDir: string): boolean {
  const userMdPath = path.join(groupDir, 'USER.md');
  if (!fs.existsSync(userMdPath)) return true;
  const content = fs.readFileSync(userMdPath, 'utf-8');
  return /^- \*\*Name:\*\*\s*$/m.test(content);
}
```

main group 启动时：
```typescript
if (isMain && isUserProfileEmpty(groupDir)) {
  const bootstrapPath = path.join(groupDir, 'BOOTSTRAP.md');
  if (!fs.existsSync(bootstrapPath)) {
    fs.writeFileSync(bootstrapPath, BOOTSTRAP_MD_TEMPLATE, 'utf-8');
  }
}
```

`writeFileIfMissing` 语义：如果 Name 还是空但 BOOTSTRAP.md 已存在（agent 正在引导中），不重复创建。

#### 2. `BOOTSTRAP.md` 模板

直接使用 openclaw 原版内容（去掉 frontmatter）：

```
# BOOTSTRAP.md - Hello, World

_You just woke up. Time to figure out who you are._
...
```

（见 openclaw `docs/reference/templates/BOOTSTRAP.md`）

Claude Code SDK 自动加载 cwd 里的 BOOTSTRAP.md（因为 `groups/main/` 是 agent 的 cwd）。

#### 3. Agent 的行为（由 BOOTSTRAP.md 内容驱动）

1. 自然打招呼："Hey. I just came online. Who am I? Who are you?"
2. 对话中了解：用户名字、称呼、时区、偏好
3. 写入 `USER.md`（Name、What to call them、Timezone、Notes/Context）
4. 删掉 `BOOTSTRAP.md`

### 完整流程

```
首次 main group 启动
  → USER.md Name 为空
  → BOOTSTRAP.md 不存在 → 创建
  → Agent 启动，读到 BOOTSTRAP.md
  → 打招呼，自然对话
  → 收集信息 → 写入 USER.md（Name 填入）
  → 删掉 BOOTSTRAP.md

之后每次启动
  → USER.md Name 有值
  → 不创建 BOOTSTRAP.md
  → 正常运行
```

## Risks

- **Agent 忘记删 BOOTSTRAP.md**：下次启动检测到 Name 已有值，不会重新创建；BOOTSTRAP.md 仍存在但不影响功能（只会再次触发对话）。可接受。
- **用户绕过引导**：用户直接编辑 USER.md 填入 Name，BOOTSTRAP.md 不会再创建。符合预期。

## Implementation Tasks

- [ ] `src/process-runner.ts`：新增 `isUserProfileEmpty()` 函数
- [ ] `src/process-runner.ts`：在 `prepareGroupDirs()` 中添加 BOOTSTRAP.md 创建逻辑
- [ ] 定义 `BOOTSTRAP_MD_TEMPLATE` 常量（openclaw 原版内容去掉 frontmatter）
