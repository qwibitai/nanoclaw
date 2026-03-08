## ADDED Requirements

### Requirement: Agent Debug Directory Pre-creation
在启动 agent 子进程前，系统 SHALL 确保 `$HOME/.claude/debug/` 目录已存在，其中 `HOME` 为 `data/sessions/{group.folder}`，以防止 Claude Code SDK 初始化时因目录缺失而崩溃。

#### Scenario: 目录不存在时自动创建
- **WHEN** `prepareGroupDirs()` 被调用，且 `data/sessions/{group}/.claude/debug/` 目录不存在
- **THEN** 系统自动创建该目录（含所有父级目录）

#### Scenario: 目录已存在时幂等
- **WHEN** `prepareGroupDirs()` 被调用，且 `data/sessions/{group}/.claude/debug/` 目录已存在
- **THEN** 系统不抛出异常，目录内容不受影响

### Requirement: Session ID Error Output Guard
当 agent 子进程以错误状态退出时，系统 SHALL NOT 将错误输出中携带的 `newSessionId` 持久化到数据库，以防止未完整初始化的 session ID 触发无法自愈的 resume 崩溃死循环。

#### Scenario: 崩溃输出携带 session ID 时不写入 DB
- **WHEN** agent 子进程输出 `{"status":"error","newSessionId":"<id>","error":"..."}`
- **THEN** 宿主进程不将该 `newSessionId` 写入 sessions 表，也不更新内存中的 sessions 映射

#### Scenario: 成功输出携带 session ID 时正常写入
- **WHEN** agent 子进程输出 `{"status":"success","newSessionId":"<id>"}`
- **THEN** 宿主进程将该 `newSessionId` 写入 sessions 表并更新内存映射
