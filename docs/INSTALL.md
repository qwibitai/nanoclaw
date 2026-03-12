# NanoClaw 安装手册

> 本文涵盖所有常见安装场景：全新安装、从 fork 安装（含自定义功能）、升级、以及在官方未合并 PR 时如何保留自定义功能。

---

## 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | ≥ 20 | 推荐通过 nvm 安装 |
| Docker / OrbStack | 最新稳定版 | 运行 agent 容器 |
| Claude Code (`claude`) | 最新版 | `/setup` 等 skill 依赖 |
| GitHub CLI (`gh`) | 可选 | 简化 fork 操作 |

---

## 场景一：全新安装（官方仓库）

适用于：第一次安装，无自定义需求。

```bash
# 1. Fork 并克隆（推荐用 gh）
gh repo fork qwibitai/nanoclaw --clone
cd nanoclaw

# 2. 启动 Claude Code 并运行安装向导
claude
# 在 claude 提示符里输入：
/setup
```

`/setup` 会自动完成：依赖安装、容器构建、Telegram/WhatsApp channel 配置、launchd 服务注册。

<details>
<summary>不使用 GitHub CLI 的方式</summary>

1. 在 GitHub 页面点 Fork：https://github.com/qwibitai/nanoclaw
2. `git clone https://github.com/<your-username>/nanoclaw.git`
3. `cd nanoclaw && claude`，然后 `/setup`

</details>

---

## 场景二：从 fork 安装（含自定义功能）

适用于：官方未合并某个 PR，但你想用 fork 分支上的功能。

以 **智能 Token 优化** 功能为例（PR #988，分支 `feat/token-optimization-clean`）：

```bash
# 1. 克隆你的 fork 的指定分支
git clone -b feat/token-optimization-clean \
  https://github.com/gm4leejun-stack/nanoclaw.git nanoclaw
cd nanoclaw

# 2. 添加官方上游（方便后续同步）
git remote add upstream https://github.com/qwibitai/nanoclaw.git

# 3. 安装依赖并构建
npm install && npm run build

# 4. 构建 Docker 镜像
docker build -t nanoclaw-agent:latest ./container/

# 5. 启动 Claude Code 完成配置
claude
# 在 claude 提示符里输入：
/setup
```

> **注意**：`/setup` 只需运行一次。后续更新只需 `git pull`、`npm run build`、重建镜像、重启服务即可。

---

## 场景三：升级（已安装，官方发布新版）

```bash
cd nanoclaw

# 1. 拉取官方最新代码
git fetch upstream
git merge upstream/main

# 2. 解决冲突（如有）
# git status 查看冲突文件，解决后 git add && git merge --continue

# 3. 安装新依赖
npm install

# 4. 重新构建
npm run build
docker build -t nanoclaw-agent:latest ./container/

# 5. 重启服务
launchctl stop com.nanoclaw && sleep 2 && launchctl start com.nanoclaw
```

---

## 场景四：升级时保留自定义功能（fork 分支 + upstream 同步）

适用于：你在 fork 分支上有自定义代码，同时想跟进官方更新。

```bash
cd nanoclaw

# 1. 拉取官方最新
git fetch upstream

# 2. 将官方 main rebase 到你的功能分支上
git checkout feat/token-optimization-clean
git rebase upstream/main

# 3. 解决冲突（如有），然后继续
# git add <冲突文件> && git rebase --continue

# 4. 重新构建
npm install && npm run build
docker build -t nanoclaw-agent:latest ./container/

# 5. 推送更新到你的 fork（强制推送 rebase 后的分支）
git push origin feat/token-optimization-clean --force-with-lease

# 6. 重启服务
launchctl stop com.nanoclaw && sleep 2 && launchctl start com.nanoclaw
```

---

## 场景五：重装系统后一键恢复

适用于：重装 macOS 后，从你的 fork 完整恢复 NanoClaw。

```bash
# 1. 安装前置工具（nvm、node、docker/orbstack、claude、gh）

# 2. 克隆你的 fork（含自定义功能的分支）
git clone -b feat/token-optimization-clean \
  https://github.com/gm4leejun-stack/nanoclaw.git nanoclaw
cd nanoclaw
git remote add upstream https://github.com/qwibitai/nanoclaw.git

# 3. 构建
npm install && npm run build
docker build -t nanoclaw-agent:latest ./container/

# 4. 恢复配置
# 将备份的 .env 文件放回 nanoclaw/.env

# 5. 恢复群组数据（如有备份）
# 将 groups/ 目录内容恢复

# 6. 重新注册 launchd 服务
claude
/setup --step service
```

---

## 服务管理

```bash
# 查看服务状态
launchctl list com.nanoclaw

# 重启
launchctl stop com.nanoclaw && sleep 2 && launchctl start com.nanoclaw

# 查看日志
tail -50 ~/nanoclaw/logs/nanoclaw.log
tail -50 ~/nanoclaw/logs/nanoclaw.error.log
```

---

## 常见问题

### `No channels connected` 启动报错

Telegram channel skill 文件丢失（通常发生在 `npm run build` 覆盖了 skill 安装写入的文件后）。

```bash
# 检查 channels 目录
ls src/channels/

# 如果缺少 telegram.ts，重新安装 channel
claude
/add-telegram
```

### Docker 镜像构建失败（网络超时）

需要设置代理：

```bash
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  docker build --build-arg HTTPS_PROXY=http://127.0.0.1:7897 \
               --build-arg HTTP_PROXY=http://127.0.0.1:7897 \
  -t nanoclaw-agent:latest ./container/
```

### `gh` CLI 无法连接 GitHub

确保 shell 代理已配置（`.zshrc` 或 `.bashrc`）：

```bash
export https_proxy=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
export no_proxy=127.0.0.1,localhost,192.168.0.0/16,10.0.0.0/8,*.local
```

然后重新认证：

```bash
gh auth login -h github.com
```

---

## 自定义功能说明

### 智能 Token 优化（PR #988）

分支：`gm4leejun-stack/nanoclaw:feat/token-optimization-clean`

包含三个机制：

| 机制 | 说明 | 额外成本 |
|------|------|----------|
| Inline Compaction | 对话超 80KB 时自动压缩历史，下次 session 轻装启动 | ~300 output token |
| 响应长度控制 | 动态注入简洁性约束，抑制 output 漂移 | ~30 token/次 |
| CLAUDE.md 自动压缩 | CLAUDE.md 超 10KB 时自动 inline 压缩，永久减少 system prompt | 0 额外成本 |

详细设计见 [TOKEN-OPTIMIZATION.md](TOKEN-OPTIMIZATION.md)。
