# account-auto-rotate

## Requirements

### R1: `/account auto` 指令
- R1.1: `/account auto on` 开启自动轮换，持久化到 SQLite
- R1.2: `/account auto off` 关闭自动轮换，持久化到 SQLite
- R1.3: `/account` 列表显示当前自动轮换状态（`🔄 自动轮换: 开启/关闭`）
- R1.4: 重启后设置保留

### R2: 429 错误检测
- R2.1: 在 container-runner.ts 的容器输出中检测 429/rate_limit/overloaded 错误
- R2.2: 检测模式覆盖 Anthropic API 的常见错误格式：`429`、`rate_limit_error`、`overloaded_error`、`quota exceeded`
- R2.3: 只在 autoRotateEnabled=true 时触发轮换

### R3: 账号轮换
- R3.1: 检测到 429 后，调用 `onecli secrets list` 获取所有 secrets
- R3.2: 按顺序切到下一个 secret：`(currentIndex + 1) % total`
- R3.3: 调用 `onecli agents set-secrets --id <agentId> --secret-ids <nextSecretId>` 绑定新 secret
- R3.4: 切换后清除当前群的 session（下次用新 token 启动容器）
- R3.5: 切换后自动重试当前用户的消息（重新调用 runAgent）
- R3.6: 向用户发送通知：`🔄 账号已自动切换到 <secret-name>`

### R4: 全部耗尽处理
- R4.1: 当轮换一圈回到起始 secret 时，判定全部耗尽
- R4.2: 全部耗尽时通知用户：`⚠️ 所有账号配额已耗尽，请等待恢复或添加新账号`
- R4.3: 全部耗尽后 10 分钟内不再尝试轮换（cooldown）

### R5: 防抖
- R5.1: 同一 secret 60 秒内只触发一次轮换
- R5.2: 使用 lastRotateAt 时间戳判断

## Acceptance Criteria

1. `/account auto on` 后，容器返回 429 时自动切换到下一个 secret 并重试
2. `/account auto off` 后，429 不触发轮换（正常报错）
3. 所有 secrets 耗尽时通知用户并停止轮换
4. 重启后轮换设置保留
5. 60 秒内不重复轮换同一 secret
