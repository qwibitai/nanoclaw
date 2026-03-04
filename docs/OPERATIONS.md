# NanoClaw 启动与停止

## 开发模式

```bash
npm run dev          # tsx 热重载运行（直接执行 TypeScript）
npm run build        # 编译 TypeScript → dist/
npm run start        # 运行编译产物 node dist/index.js
```

## 生产环境

NanoClaw 通过系统服务管理器在后台运行，开机自启、崩溃自动重启。

### macOS（launchd）

plist 模板位于 `launchd/com.nanoclaw.plist`，安装后复制到 `~/Library/LaunchAgents/`。

```bash
# 注册并启动（首次或 plist 更新后）
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.nanoclaw.plist

# 停止并注销
launchctl bootout gui/$(id -u)/com.nanoclaw

# 重启（不注销，直接杀进程重拉）
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

> **旧版兼容**：`launchctl load / unload` 在新版 macOS 中仍可用，但官方推荐使用 `bootstrap / bootout`。

### Linux（systemd）

```bash
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
systemctl --user status nanoclaw   # 查看运行状态
```

## 代码变更后重新部署

```bash
# 编译 + 重启（一条命令）
npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 如果修改了容器镜像
./container/build.sh
```

## 日志

| 文件 | 内容 |
|------|------|
| `logs/nanoclaw.log` | 标准输出（主日志） |
| `logs/nanoclaw.error.log` | 标准错误 |
| `groups/*/logs/container-*.log` | 各群容器日志 |

```bash
# 实时查看日志
tail -f logs/nanoclaw.log

# 查看最近错误
grep -E 'ERROR|WARN' logs/nanoclaw.log | tail -20
```

## 快速健康检查

```bash
# 服务是否在运行？（有 PID 表示运行中）
launchctl list | grep nanoclaw

# 有无运行中的容器？
container ls --format '{{.Names}} {{.Status}}' 2>/dev/null | grep nanoclaw

# 群组是否加载？
grep 'groupCount' logs/nanoclaw.log | tail -3
```

## 注意事项

- **停止服务不会杀死运行中的容器**，已启动的 agent 容器会继续执行直到超时
- plist 配置了 `KeepAlive: true` 和 `RunAtLoad: true`，即崩溃后自动重启、开机自动启动
- 生产环境始终使用 `npm run build` 编译后运行，不要使用 `npm run dev`
