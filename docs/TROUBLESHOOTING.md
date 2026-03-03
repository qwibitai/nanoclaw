# NanoClaw 故障排查指南

## 问题：一条消息启动两个容器

### 症状
- 每次发送消息时，docker ps 显示有两个容器同时运行
- 容器名称时间戳相差约 1 秒
- 两个容器接收到完全相同的输入

### 根本原因
**有两个 systemd 服务同时运行**

1. **用户级服务**: `~/.config/systemd/user/nanoclaw.service`
2. **系统级服务**: `/etc/systemd/system/nanoclaw.service`

两个服务都在启动 nanoclaw 进程，导致：
- 两个进程同时监听 Feishu 消息
- 每条消息被两个进程同时处理
- 每个进程启动一个容器 = 两个容器

### 诊断步骤

1. **检查进程数量**
```bash
ps aux | grep "node.*dist/index.js" | grep -v grep
```

2. **检查 systemd 服务**
```bash
# 用户级服务
systemctl --user status nanoclaw

# 系统级服务
systemctl status nanoclaw

# 查找所有服务文件
find ~/.config/systemd /etc/systemd -name "*nanoclaw*" 2>/dev/null
```

3. **检查容器的父进程**
```bash
# 找到 docker run 进程
ps aux | grep "docker run.*nanoclaw" | grep -v grep

# 查看父进程关系
ps -o pid,ppid,cmd -p <docker_pid>
```

### 解决方案

**停止并禁用系统级服务**
```bash
sudo systemctl stop nanoclaw
sudo systemctl disable nanoclaw
```

**只保留用户级服务**
```bash
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

**验证**
```bash
# 应该只有一个进程
ps aux | grep "node.*dist/index.js" | grep -v grep | wc -l

# 应该只显示用户级服务
systemctl --user status nanoclaw
```

## 问题：main group 报模型错误，private-chat 正常

### 症状
- private-chat 可以正常工作
- main group 返回错误：`claude-sonnet-4-5-20250929 负载已经达到上限`
- 明明使用的是同样的代码和配置

### 根本原因
**旧会话使用了旧模型**

Claude Code 的会话一旦创建，模型就固定了。即使更新了 .env 配置，旧会话仍然使用创建时的模型。

- **private-chat**: 会话是最近创建的，使用新模型 `claude-sonnet-4-6`（可用）
- **main**: 会话是很久之前创建的，使用旧模型 `claude-sonnet-4-5-20250929`（负载已满）

### 诊断步骤

1. **检查会话使用的模型**
```bash
# 查看遥测事件中的模型信息
cat /home/maiscrm/workspace/nanoclaw/data/sessions/main/.claude/telemetry/*.json | jq -r '.event_data.model' | head -1
```

2. **检查当前配置的模型**
```bash
cat /home/maiscrm/workspace/nanoclaw/.env | grep MODEL
```

### 解决方案

**删除旧会话，让系统创建新会话**
```bash
# 删除会话文件
rm -rf /home/maiscrm/workspace/nanoclaw/data/sessions/main/.claude/projects/*

# 删除数据库中的会话记录
sqlite3 /home/maiscrm/workspace/nanoclaw/store/messages.db \
  "DELETE FROM sessions WHERE group_folder = 'main';"
```

下次向该群组发送消息时，会创建新会话并使用新模型。

## 预防措施

### 1. 避免重复服务

**安装时只创建一种服务**
- 个人使用：只创建用户级服务 (`systemctl --user`)
- 系统服务：只在需要开机自启且多用户共享时使用

### 2. 定期清理旧会话

当模型配置更新后，清理旧会话：
```bash
# 列出所有群组的会话
sqlite3 /home/maiscrm/workspace/nanoclaw/store/messages.db \
  "SELECT group_folder, session_id FROM sessions;"

# 删除特定群组的会话
rm -rf /home/maiscrm/workspace/nanoclaw/data/sessions/<group>/.claude/projects/*
sqlite3 /home/maiscrm/workspace/nanoclaw/store/messages.db \
  "DELETE FROM sessions WHERE group_folder = '<group>';"
```

### 3. 监控进程数量

添加到 crontab 或监控脚本：
```bash
#!/bin/bash
count=$(ps aux | grep "node.*nanoclaw.*dist/index.js" | grep -v grep | wc -l)
if [ $count -gt 1 ]; then
  echo "WARNING: Multiple nanoclaw processes detected: $count"
  # 发送告警或自动清理
fi
```

## 调试工具

### nanoclaw CLI
```bash
nanoclaw status    # 查看服务状态
nanoclaw ps        # 查看进程数量
nanoclaw logs      # 查看日志
nanoclaw restart   # 重启服务
```

### 查看容器
```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}" | grep nanoclaw
```

### 查看日志
```bash
# 应用日志
tail -f /home/maiscrm/workspace/nanoclaw/logs/nanoclaw.log

# systemd 日志
journalctl --user -u nanoclaw -f
```

## 经验教训

1. **简单的问题可能有复杂的原因**
   - 表面上是容器重复，实际是服务重复
   - 需要系统性地排查，不能只看表象

2. **状态持久化会带来隐藏问题**
   - 会话状态保存了模型信息
   - 配置更新不会自动应用到旧会话

3. **多层服务管理需要注意**
   - systemd 有用户级和系统级两种
   - 安装时要明确只创建一种

4. **调试日志很重要**
   - 添加详细的调试日志帮助快速定位问题
   - 记录调用栈、时间戳、PID 等关键信息
