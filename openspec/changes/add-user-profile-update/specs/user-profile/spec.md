## ADDED Requirements

### Requirement: User Profile Auto-Initialization

在 agent 运行前，系统 SHALL 检查群组目录下是否存在 `USER.md`，若不存在则自动创建含结构化字段的初始模板（仅 main group）。已存在的文件不得被覆盖。

模板字段包括：Name、What to call them、Timezone、Notes、Context（随对话积累用途说明）。

#### Scenario: USER.md 不存在时自动创建

- **WHEN** agent 首次运行且群组目录下没有 `USER.md`
- **THEN** 系统在启动 agent 前创建 `USER.md`，内容为结构化初始模板
- **AND** agent 读取到有意义的模板内容而非空文件

#### Scenario: USER.md 已存在时不覆盖

- **WHEN** 群组目录下已有 `USER.md`（无论内容是模板还是已填充信息）
- **THEN** 系统不修改该文件，保留已有内容

#### Scenario: 仅对 main group 创建

- **WHEN** 非 main group 的 agent 运行
- **THEN** 系统不为该群组创建 `USER.md`
