## Why

NanoClaw 用户通常有多个 Anthropic 账号（个人号、工作号、备用号）。当一个账号的 API 配额耗尽（429 Too Many Requests）时，需要手动切换到另一个账号。这打断了工作流程，尤其在长时间编码任务中。

需要自动轮换机制：检测到 429 后自动切到下一个可用账号，无缝继续。

## What Changes

- 新增 `/account auto on|off` 指令，开关自动轮换模式
- 容器运行时检测 429/overloaded 错误，自动切换到下一个 OneCLI secret
- 切换后自动重试当前请求（清除 session，启动新容器）
- 所有 secrets 耗尽时通知用户
- `/account` 列表显示自动轮换状态
- 轮换状态持久化到 SQLite（重启后保留设置）

## Capabilities

### New Capabilities
- `account-auto-rotate`: 自动检测 429 错误并轮换 Anthropic 账号。包含：指令解析、状态持久化、错误检测、账号切换、重试逻辑、用户通知。

### Modified Capabilities
- （无已有 spec 需要修改）

## Impact

- **src/index.ts**: `/account auto on|off` 指令解析 + 轮换状态管理
- **src/container-runner.ts**: 容器 stderr/stdout 中检测 429 错误，触发轮换
- **src/db.ts**: 新增轮换配置持久化（auto_rotate_enabled, current_secret_index）
- **OneCLI CLI**: 通过 `onecli agents set-secrets` 切换绑定
- **依赖**: 无新依赖，使用已有的 `child_process.execSync` 调用 onecli CLI
