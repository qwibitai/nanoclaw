## ADDED Requirements

### Requirement: TOOLS.md Auto-Initialization

在 main group agent 运行前，系统 SHALL 检查群组目录下是否存在 `TOOLS.md`，若不存在则自动创建含模板结构的初始文件（`writeFileIfMissing` 语义，已存在不覆盖）。

模板结构参照 openclaw 原版：包含 "What Goes Here" 说明（摄像头、SSH 主机、TTS 声音、设备别名等使用示例）。

#### Scenario: TOOLS.md 不存在时自动创建

- **WHEN** main group 首次运行且群组目录下没有 `TOOLS.md`
- **THEN** 系统在启动 agent 前创建 `TOOLS.md`，内容为 openclaw 原版模板
- **AND** 已存在的 `TOOLS.md` 不被覆盖

#### Scenario: 仅对 main group 创建

- **WHEN** 非 main group 的 agent 运行
- **THEN** 系统不为该群组创建 `TOOLS.md`

---

### Requirement: TOOLS.md System Prompt Injection

当 main group 的 `TOOLS.md` 存在时，agent-runner SHALL 在 agent 启动时将其内容注入 system prompt，与 IDENTITY.md、BOOTSTRAP.md 并列传入，使 agent 无需手动读取即可感知本地环境配置。

#### Scenario: TOOLS.md 存在时注入

- **WHEN** main group agent 启动且 `TOOLS.md` 存在
- **THEN** `TOOLS.md` 内容出现在 system prompt 的 append 部分
- **AND** agent 无需主动 Read 即可直接使用其中信息

#### Scenario: TOOLS.md 不存在时不影响启动

- **WHEN** main group agent 启动且 `TOOLS.md` 不存在
- **THEN** system prompt 正常构建，无错误
