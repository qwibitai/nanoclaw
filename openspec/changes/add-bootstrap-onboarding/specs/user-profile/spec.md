## ADDED Requirements

### Requirement: Bootstrap Onboarding

当 main group 的 `USER.md` Name 字段为空时，系统 SHALL 在 agent 启动前自动创建 `BOOTSTRAP.md`（仅当该文件不存在时）。Agent 读到 `BOOTSTRAP.md` 后 SHALL 以自然对话方式引导用户介绍自己，将收集到的信息写入 `USER.md`，并在完成后删除 `BOOTSTRAP.md`。

触发信号：`USER.md` 中 `- **Name:**` 行后无值（模板状态）视为未完成引导。Name 有值后不再触发。

#### Scenario: 首次启动时创建 BOOTSTRAP.md

- **WHEN** main group 首次运行，`USER.md` Name 字段为空，且 `BOOTSTRAP.md` 不存在
- **THEN** 系统在启动 agent 前创建 `BOOTSTRAP.md`，内容为 openclaw 原版引导模板
- **AND** agent 读到文件后主动发起对话

#### Scenario: 引导完成后不再触发

- **WHEN** agent 完成引导，将用户姓名写入 `USER.md` Name 字段，并删除 `BOOTSTRAP.md`
- **THEN** 下次启动时检测到 Name 有值，系统不再创建 `BOOTSTRAP.md`

#### Scenario: 引导进行中不重复创建

- **WHEN** `USER.md` Name 仍为空，但 `BOOTSTRAP.md` 已存在（引导对话尚未完成）
- **THEN** 系统不重复创建 `BOOTSTRAP.md`，保留现有文件

#### Scenario: 非 main group 不触发

- **WHEN** 非 main group 的 agent 启动
- **THEN** 系统不检查 USER.md 也不创建 `BOOTSTRAP.md`
