# OpenSpec CLI 使用指南

`openspec` 是 spec-driven 开发的 CLI 工具。默认工作流：proposal → specs → design → tasks。

**重要**：运行前需要加载 nvm 环境：
```bash
export NVM_DIR="$HOME/.nvm" && [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

## 项目定位

openspec 基于当前目录工作，**必须 `cd` 到目标项目根目录再执行**。

已知项目：
| 项目 | 路径 |
|------|------|
| NanoClaw | `~/AI_Workspace/nanoclaw` |
| Nine | `~/AI_Workspace/nine` |

规则：
1. 用户提到改哪个项目，就 `cd` 到那个项目目录
2. 如果项目还没初始化 openspec，先运行 `openspec init`
3. 变更文件存在项目自己的 `openspec/changes/` 下
4. 不确定哪个项目时，问用户

## 常用命令

### 初始化（新项目首次使用）
```bash
cd ~/AI_Workspace/<project> && openspec init
```

### 列出所有变更
```bash
openspec list
```

### 创建新变更
```bash
openspec new change <name> --description "一句话描述"
```
创建后会生成 `openspec/changes/<name>/` 目录结构。

### 查看变更详情
```bash
openspec show <change-name>
openspec change show <change-name>        # 显示 JSON/Markdown 格式
```

### 获取写作指引（核心功能）
```bash
openspec instructions --change <name> <artifact>
```
- `<artifact>` 可选值：`proposal`、`specs`、`design`、`tasks`
- 返回模板、依赖关系、输出路径和写作规范
- **写每个 artifact 前必须先运行这个命令获取指引**

### 查看任务完成状态
```bash
openspec status --change <name>
```

### 验证变更
```bash
openspec validate <change-name>
```

### 归档已完成的变更
```bash
openspec archive <change-name>
```

## 工作流

### 创建新规范

1. `cd` 到目标项目根目录
2. `openspec new change <name> --description "描述"`
3. `openspec instructions --change <name> proposal` → 按指引写 proposal.md
4. 等用户确认 proposal
5. `openspec instructions --change <name> specs` → 按指引写 specs/
6. `openspec instructions --change <name> design` → 按指引写 design.md
7. **在 design.md 末尾追加 `## 测试计划`**（见下方"可测试性要求"）
8. `openspec instructions --change <name> tasks` → 按指引写 tasks.md

### 可测试性要求

写 design.md 时，**必须**在末尾包含 `## 测试计划` 章节：

1. **测试分层**：哪些函数/模块适合纯逻辑单测（零 mock），哪些需要 mock 外部依赖
2. **优先级**：按 P0（核心逻辑必测）、P1（重要路径）、P2（锦上添花）分级
3. **预估范围**：大约多少个测试用例，覆盖哪些文件

原则：
- 设计阶段就考虑可测试性 — 复杂逻辑拆成纯函数，不要全部耦合在 I/O 层
- 每个新增/修改的模块都必须有对应的单元测试
- 纯函数优先（零 mock、跑得快、不 flaky）
- 测试是编码完成的必要条件，不是可选项

### 实现阶段

1. `openspec instructions --change <name> tasks` → 获取任务列表
2. 按任务顺序实现
3. 完成的任务勾选 `- [x]`
4. `openspec status --change <name>` → 查看进度

## 配置

```bash
openspec config list          # 查看当前配置
openspec schemas              # 查看可用 schema
openspec config profile       # 切换工作流 profile
```
