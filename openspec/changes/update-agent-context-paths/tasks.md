# Tasks: Update Agent Context Files to Process-Based Paths

## 1. 更新 groups/global/CLAUDE.md

- [x] 1.1 将 "Your Workspace" 节的 `/workspace/group/` 改为 `.`（当前工作目录即 group folder）

## 2. 更新 groups/main/CLAUDE.md

- [x] 2.1 将 "Container Mounts" 节标题改为 "File System"，更新节开头描述
- [x] 2.2 更新路径表：移除 "Container Path" 列，改为以真实路径为主的表格
- [x] 2.3 更新 Key paths 列表（3 条 `/workspace/project/...` 引用）
- [x] 2.4 更新 "Finding Available Groups" 节的 IPC 文件路径：`/workspace/ipc/available_groups.json` → `$NANOCLAW_IPC_DIR/available_groups.json`
- [x] 2.5 更新 refresh_groups 命令：`/workspace/ipc/tasks/` → `$NANOCLAW_IPC_DIR/tasks/`
- [x] 2.6 更新 sqlite3 命令：`/workspace/project/store/messages.db` → `../../store/messages.db`
- [x] 2.7 更新 "Adding a Group" 步骤 4：`/workspace/project/groups/{folder-name}/` → `groups/{folder-name}/`
- [x] 2.8 更新 "Adding Additional Directories" 示例：移除 `containerPath` 字段，更新说明为 `NANOCLAW_EXTRA_DIR`
- [x] 2.9 更新 "Removing a Group" 步骤：改为 MCP 工具或 SQLite 直接操作
- [x] 2.10 更新 "Listing Groups" 节：改为 MCP 工具或 SQLite 直接查询
- [x] 2.11 更新 "Global Memory" 节：`/workspace/project/groups/global/CLAUDE.md` → `../../groups/global/CLAUDE.md`

## 3. 验证

- [x] 3.1 全文搜索确认无残留 `/workspace` 引用：`grep -n "/workspace" groups/global/CLAUDE.md groups/main/CLAUDE.md`
