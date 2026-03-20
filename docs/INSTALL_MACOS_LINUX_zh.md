# NanoClaw 安装指南（macOS / Linux）

本文档说明如何在 macOS 和 Linux 上安装 NanoClaw。

内容包括：

- 推荐安装方式
- macOS 安装步骤
- Linux 安装步骤
- 不依赖 `/setup` 的手工安装路径
- 安装完成后的验证方法
- 常见问题排查

如果你已经在本仓库中接入了钉钉，可继续参考：

- `docs/DINGTALK_zh.md`
- `docs/DINGTALK.md`

---

## 1. 安装方式概览

NanoClaw 当前有两种安装方式：

### 方式 A：推荐方式

使用 Claude Code 进入仓库后运行：

```bash
claude
```

然后在 Claude Code 里执行：

```text
/setup
```

这是推荐路径。`/setup` 会按当前代码实际情况引导并执行：

- Node.js 与依赖安装
- 容器运行时检测
- Claude 凭据配置
- 消息渠道安装与认证
- 挂载白名单配置
- 后台服务启动
- 最终验证

### 方式 B：手工安装

适合以下场景：

- 你想完全控制每一步
- 你在排查 `/setup` 失败原因
- 你要写内部部署文档

本文档会同时给出这种路径。

---

## 2. 适用平台与要求

### 支持的平台

- macOS
- Linux

### 基本要求

- Node.js 20+，建议 Node.js 22
- Git
- Claude Code
- 容器运行时

运行时说明：

- Linux：使用 Docker
- macOS：默认使用 Docker，也可以改成 Apple Container

补充说明：

- macOS 上如果要使用 Apple Container，需要额外做 runtime 转换；当前默认代码路径仍然是 Docker 方案
- 本文档面向原生 macOS 和原生 Linux，不专门覆盖 WSL

---

## 3. 推荐安装流程

先克隆仓库：

```bash
git clone <your-fork-or-upstream-url>
cd nanoclaw
```

然后进入 Claude Code：

```bash
claude
```

在 Claude Code 中执行：

```text
/setup
```

`/setup` 内部大致会做这些事：

1. 运行 `bash setup.sh` 安装 Node 依赖并检查原生模块
2. 运行 `npx tsx setup/index.ts --step environment`
3. 配置 Docker 或 Apple Container
4. 配置 Claude 认证
5. 安装并配置消息渠道，例如：
   - `/add-whatsapp`
   - `/add-telegram`
   - `/add-slack`
   - `/add-discord`
   - 你当前 fork 中也可以使用 `/add-dingtalk`
6. 配置 mount allowlist
7. 安装后台服务
8. 运行最终验证

如果你只是正常使用 NanoClaw，一般到这里就够了。

---

## 4. macOS 安装

## 4.1 推荐组合

最稳妥的组合是：

- Homebrew
- Node.js 22
- Docker Desktop
- Claude Code

如果你已经熟悉 Apple Container，也可以用它，但默认推荐 Docker 路径，因为当前仓库默认运行时就是 Docker。

---

## 4.2 安装前准备

### 安装 Xcode Command Line Tools

```bash
xcode-select --install
```

NanoClaw 依赖里有 `better-sqlite3`，需要原生编译工具链。

### 安装 Homebrew（如果还没有）

参考 Homebrew 官方安装方式。

### 安装 Node.js 22

如果使用 Homebrew：

```bash
brew install node@22
```

确认版本：

```bash
node -v
npm -v
```

### 安装 Docker Desktop

如果使用 Homebrew：

```bash
brew install --cask docker
```

然后启动 Docker Desktop：

```bash
open -a Docker
```

确认 Docker 已可用：

```bash
docker info
```

### 安装 Claude Code

按官方方式安装 Claude Code，确认命令可用：

```bash
claude --version
```

---

## 4.3 macOS 推荐安装命令

```bash
git clone <your-fork-or-upstream-url>
cd nanoclaw
claude
```

然后在 Claude Code 中执行：

```text
/setup
```

---

## 4.4 macOS 可选：Apple Container

如果你已经安装 Apple Container，并且想不用 Docker，可以在安装时切换到 Apple Container。

注意：

- 当前仓库默认运行时是 Docker
- 如果选择 Apple Container，需要先做 runtime 转换
- 仓库里已有相关 skill：`/convert-to-apple-container`

因此，macOS 上推荐策略是：

- 想省心：Docker
- 想更贴近苹果原生容器：Apple Container + `/convert-to-apple-container`

---

## 4.5 macOS 服务管理

安装完成后，NanoClaw 默认使用 `launchd` 管理后台服务。

相关文件：

- `~/Library/LaunchAgents/com.nanoclaw.plist`
- `logs/nanoclaw.log`
- `logs/nanoclaw.error.log`

常用命令：

重启服务：

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

卸载服务：

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
```

查看是否已加载：

```bash
launchctl list | grep nanoclaw
```

---

## 5. Linux 安装

## 5.1 推荐组合

推荐组合是：

- Node.js 22
- Docker
- Claude Code
- systemd 用户服务

Linux 下当前只考虑 Docker 作为容器运行时。

---

## 5.2 安装前准备

### 安装基础工具

以 Debian / Ubuntu 为例：

```bash
sudo apt-get update
sudo apt-get install -y git curl build-essential
```

这些工具用于：

- 拉取仓库
- 下载安装依赖
- 编译 `better-sqlite3` 等原生模块

### 安装 Node.js 22

Debian / Ubuntu 示例：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

确认版本：

```bash
node -v
npm -v
```

如果你更习惯 `nvm`，也可以使用 `nvm` 安装 Node.js 22。

### 安装 Docker

常见方式：

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

完成后建议重新登录 shell，或者重新登录系统，让 docker group 生效。

确认 Docker 可用：

```bash
docker info
```

### 安装 Claude Code

按官方方式安装 Claude Code，并确认：

```bash
claude --version
```

---

## 5.3 Linux 推荐安装命令

```bash
git clone <your-fork-or-upstream-url>
cd nanoclaw
claude
```

然后在 Claude Code 中执行：

```text
/setup
```

---

## 5.4 Linux 服务管理

安装完成后，NanoClaw 通常使用 `systemd --user` 作为后台服务管理器。

常用命令：

重启服务：

```bash
systemctl --user restart nanoclaw
```

查看状态：

```bash
systemctl --user status nanoclaw
```

停止服务：

```bash
systemctl --user stop nanoclaw
```

如果系统环境没有可用的用户级 systemd，代码会退回到 `nohup` wrapper 方案。

日志文件依然在项目目录下：

- `logs/nanoclaw.log`
- `logs/nanoclaw.error.log`

---

## 6. 手工安装流程

如果你不想通过 Claude Code 的 `/setup` 来完成，也可以手工一步步执行。

下面步骤适用于：

- macOS
- Linux

前提是：

- Node.js 已安装
- 容器运行时已安装并能正常工作

---

## 6.1 克隆仓库

```bash
git clone <your-fork-or-upstream-url>
cd nanoclaw
```

---

## 6.2 运行 bootstrap

```bash
bash setup.sh
```

这个脚本会做三件事：

- 检查 Node.js 版本
- 执行 `npm install`
- 验证 `better-sqlite3` 原生模块是否可用

如果它失败，先看：

```bash
tail -f logs/setup.log
```

---

## 6.3 检查环境

```bash
npx tsx setup/index.ts --step environment
```

它会输出：

- 平台信息
- Docker 是否存在、是否在运行
- Apple Container 是否存在
- 是否已有 `.env`
- 是否已有已注册群组

---

## 6.4 构建容器镜像

### Linux

```bash
npx tsx setup/index.ts --step container -- --runtime docker
```

### macOS 使用 Docker

```bash
npx tsx setup/index.ts --step container -- --runtime docker
```

### macOS 使用 Apple Container

如果你已经把运行时切换到 Apple Container：

```bash
npx tsx setup/index.ts --step container -- --runtime apple-container
```

---

## 6.5 配置 Claude 凭据

NanoClaw 至少需要以下两种方式中的一种：

### 方式 1：Claude Code 订阅令牌

把 `CLAUDE_CODE_OAUTH_TOKEN` 写入 `.env`。

### 方式 2：Anthropic API Key

把 `ANTHROPIC_API_KEY` 写入 `.env`。

例如：

```bash
cat > .env << 'EOF'
ANTHROPIC_API_KEY=your_api_key_here
EOF
```

如果你还要使用兼容 Anthropic API 的第三方接口，也可以继续添加：

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
ANTHROPIC_MODEL=your-model-id
```

如果第三方服务把 Anthropic 兼容接口挂在子路径下，例如：

```bash
ANTHROPIC_BASE_URL=https://your-provider.example.com/apps/anthropic
```

也可以直接这样配置。

然后同步运行时环境：

```bash
mkdir -p data/env
cp .env data/env/env
```

---

## 6.6 安装消息渠道

NanoClaw 的渠道是通过 skill 增加的，不建议直接手写代码接进去。

常见渠道：

- `/add-whatsapp`
- `/add-telegram`
- `/add-slack`
- `/add-discord`

你当前 fork 还额外有：

- `/add-dingtalk`

推荐做法：

```bash
claude
```

然后在 Claude Code 中执行相应 skill。

如果你已经把某个 skill 应用到当前 fork，那只需要把对应 token 或认证信息写入 `.env`，再重启服务即可。

---

## 6.7 配置挂载白名单

如果你不希望 agent 访问额外目录，可以直接创建空 allowlist：

```bash
npx tsx setup/index.ts --step mounts -- --empty
```

如果你要让 agent 访问额外目录，则需要按 JSON 形式配置允许挂载的路径。

---

## 6.8 安装后台服务

```bash
npx tsx setup/index.ts --step service
```

这个步骤会自动：

- 构建 TypeScript
- 生成服务配置
- 在 macOS 上写入 `launchd` 配置
- 在 Linux 上写入 `systemd` 用户服务，或回退到 `nohup`

---

## 6.9 最终验证

```bash
npx tsx setup/index.ts --step verify
```

它会检查：

- 服务是否正在运行
- 容器运行时是否可用
- Claude 凭据是否已配置
- 渠道凭据是否已配置
- 群组是否已经注册
- 挂载白名单是否存在

---

## 7. 安装完成后的验证

最简单的验证方式是：

1. 给你已注册的主会话或群发一条消息
2. 查看是否收到 NanoClaw 回复

同时看日志：

```bash
tail -f logs/nanoclaw.log
```

如果是渠道层问题，也可以先检查该渠道是否已接上。

例如你当前 fork 的钉钉文档见：

- `docs/DINGTALK_zh.md`

---

## 8. 常见问题

## 8.1 `setup.sh` 失败

先看：

```bash
tail -f logs/setup.log
```

最常见原因：

- Node.js 版本过低
- 原生编译工具缺失
- `better-sqlite3` 编译失败

macOS 优先检查：

```bash
xcode-select -p
```

Linux 优先检查：

```bash
gcc --version
make --version
```

---

## 8.2 `docker info` 失败

说明 Docker 没安装好，或者服务没启动。

macOS：

```bash
open -a Docker
docker info
```

Linux：

```bash
sudo systemctl start docker
docker info
```

如果 `docker` 命令存在但普通用户权限不够，检查当前用户是否已加入 docker group，并重新登录会话。

---

## 8.3 服务启动了，但消息没有回复

优先检查：

- `.env` 是否已同步到 `data/env/env`
- 渠道是否真的已安装
- 渠道 token / 认证是否存在
- 目标群组是否已注册
- 非 main 群组是否带了正确 trigger

用下面命令看状态：

```bash
npx tsx setup/index.ts --step verify
```

---

## 8.4 macOS 想从 Docker 切到 Apple Container

当前代码默认还是 Docker 运行时，因此不能只装好 Apple Container 就直接切过去。

正确做法是：

1. 在 Claude Code 中执行 `/convert-to-apple-container`
2. 再执行 container build/test
3. 再重启服务

---

## 8.5 Linux 上 systemd 用户服务不可用

这种情况下代码会回退到 `nohup` wrapper。

如果你希望使用用户级 systemd，需要保证：

- 系统启用了用户 session
- `systemctl --user` 可用

否则就接受 fallback 方案即可。

---

## 9. 推荐安装结论

如果你只是想尽快把项目跑起来，建议按下面做：

### macOS

1. 安装 Xcode Command Line Tools
2. 安装 Node.js 22
3. 安装 Docker Desktop
4. 安装 Claude Code
5. `git clone`
6. `claude`
7. `/setup`

### Linux

1. 安装 `git curl build-essential`
2. 安装 Node.js 22
3. 安装 Docker
4. 安装 Claude Code
5. `git clone`
6. `claude`
7. `/setup`

如果后面你希望，我可以继续补：

- 一份英文版安装文档
- 把这份文档加入 README 或 docs 索引
- 针对你当前 fork 再补一份“带钉钉的安装指南”
