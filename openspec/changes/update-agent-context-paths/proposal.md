# Change: Update Agent Context Files to Process-Based Paths

## Why

`groups/main/CLAUDE.md` 和 `groups/global/CLAUDE.md` 是 agent 每次启动时读取的上下文文件，描述 agent 所处环境和操作方式。这些文件中大量使用 `/workspace/project`、`/workspace/group`、`/workspace/ipc` 等 Docker 容器挂载路径。容器层移除后，agent 现在以 Node.js 子进程运行，`cwd = groups/{folder}/`（真实 host 路径），路径引用全部过时，会导致 agent 使用错误路径操作文件。

## What Changes

**`groups/global/CLAUDE.md`**
- 将 "Your Workspace" 节的 `/workspace/group/` 更新为 `.`（cwd 即 group folder）

**`groups/main/CLAUDE.md`**
- 将 "Container Mounts" 节重命名为 "File System"，更新路径表和描述
- 新路径对应关系：
  - `/workspace/project` → `../..`（project root，cwd 上两级）
  - `/workspace/group` → `.`（cwd = `groups/main/`）
  - `/workspace/ipc` → `$NANOCLAW_IPC_DIR`（env var，绝对路径）
  - `/workspace/extra/{name}` → `$NANOCLAW_EXTRA_DIR`（env var，单个额外目录）
- 更新所有内联路径引用（sqlite3 命令、IPC 任务写入、groups 目录、global CLAUDE.md 路径）
- 更新 "Adding Additional Directories" 示例：移除 `containerPath` 字段（已从类型中删除），说明额外目录通过 `NANOCLAW_EXTRA_DIR` 访问
- 更新 "Removing/Listing Groups" 操作：`registered_groups.json` 文件引用改为 SQLite 直接查询（与实际实现一致）

## Impact

- Affected specs: `agent-context`（新建）
- Affected code: 无（纯文档变更）
- Affected files:
  - `groups/global/CLAUDE.md`
  - `groups/main/CLAUDE.md`
