# NanoClaw on Apple Container — Setup Notes

记录首次在 macOS Apple Silicon 上使用 Apple Container 运行 NanoClaw 的完整过程，
包括踩过的坑、解法和当前运行状态。

---

## 当前运行状态

| 组件 | 状态 |
|------|------|
| NanoClaw 主进程 | `PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev` |
| Node.js 版本 | **22 LTS**（必须，见下文） |
| Container runtime | Apple Container 0.10.0 |
| Container 镜像 | `nanoclaw-agent:latest` |
| Telegram channel | `@twcai_bot`，已注册 chat `tg:116373986` |
| API | Kimi gateway（`https://api.kimi.com/coding/`） |
| Credential proxy | 启动但容器**不走** proxy（见问题 #6） |

### 启动命令

```bash
cd ~/workspace/twcai/nanoclaw
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev
```

### .env 配置

```
TELEGRAM_BOT_TOKEN=<telegram bot token>
ANTHROPIC_API_KEY=<kimi api key>
ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
```

---

## 踩坑记录

### 问题 1：Node.js 25 与 better-sqlite3 不兼容

**现象**：`npm run dev` 报错 `NODE_MODULE_VERSION` 不匹配，`better-sqlite3` native 模块无法加载。

**原因**：系统安装了 Node 25，`better-sqlite3` 没有 Node 25 的预编译 binary，
且 node-gyp 从源码编译时 TLS 连接失败（`gyp ERR! stack Error: aborted`）。

**解法**：
```bash
brew install node@22
# 运行时始终用：
PATH="/opt/homebrew/opt/node@22/bin:$PATH" npm run dev
```

---

### 问题 2：Docker 未安装，改用 Apple Container

**现象**：启动时报 `docker: command not found`。

**解法**：
```bash
brew install container
container system kernel set --recommended   # 配置 Kata 内核
container system start
```

然后 merge Apple Container skill 分支：
```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream skill/apple-container
git merge upstream/skill/apple-container
# 冲突文件直接取本地版本
git checkout --ours repo-tokens/badge.svg
git add repo-tokens/badge.svg
git merge --continue
npm install   # 合并后有新依赖（grammy 等）
```

---

### 问题 3：容器镜像构建时间极长

**现象**：`./container/build.sh` 卡在下载 Chromium（63.5 MB），
网络慢时需要 40–60 分钟。

**解法**：后台运行，等待完成：
```bash
./container/build.sh &
# 完成后验证：
container image ls | grep nanoclaw
```

---

### 问题 4：`/dev/null` 文件挂载失败

**现象**：容器每次启动立即退出，stderr 为：
```
Error: path '/dev/null' is not a directory
```

**原因**：`src/container-runner.ts` 原本通过 `--mount type=bind,source=/dev/null,...`
把宿主机的 `/dev/null` 挂载到容器内的 `/workspace/project/.env`，
以防容器读取宿主机 `.env`。但 Apple Container（VirtioFS）**只支持目录挂载**，不支持文件挂载。

**解法**：删除该 mount，改用 Dockerfile entrypoint 内部的 `mount --bind` 处理（Apple Container skill 已包含此逻辑）。

`src/container-runner.ts` 修改：移除以下代码块：
```typescript
// 删除
if (fs.existsSync(envFile)) {
  mounts.push({
    hostPath: '/dev/null',
    containerPath: '/workspace/project/.env',
    readonly: true,
  });
}
```

---

### 问题 5：Credential proxy 绑定在 127.0.0.1，容器无法访问

**现象**：容器内 `curl http://host.docker.internal:3001` 返回 `Empty reply from server`。

**原因**：`detectProxyBindHost()` 在 macOS 上硬编码返回 `127.0.0.1`。
Docker Desktop 的 VM 把 `host.docker.internal` 路由到宿主机 loopback，
但 Apple Container 的 `host.docker.internal` 解析到 `198.18.0.188`（虚拟网络 IP），
不走 loopback，因此容器连不上 proxy。

**解法**：`src/container-runtime.ts` 修改 `detectProxyBindHost()`：
```typescript
// Apple Container 需要 0.0.0.0
if (os.platform() === 'darwin' && CONTAINER_RUNTIME_BIN === 'container')
  return '0.0.0.0';
```

---

### 问题 6：Credential proxy 收到容器请求后 socket hang up

**现象**：绑定改为 `0.0.0.0` 后，从宿主机 localhost 测试 proxy 完全正常（返回有效 Kimi 响应），
但容器内 Node.js 请求仍报 `socket hang up` / ECONNRESET，持续约 3 分钟后超时。

**原因**：Apple Container 虚拟网络（VirtioFS）的 TCP 回路存在问题——
容器→宿主机的请求可建立 TCP 连接，但宿主机→容器的响应数据流不通，
导致 proxy 读取到上游 Kimi 响应后无法回写给容器，最终连接被重置。

**解法**：绕过 credential proxy，对 Apple Container 运行时直接把真实 API key 和 base URL
作为环境变量传入容器。

`src/container-runner.ts` 修改：
```typescript
import { readEnvFile } from './env.js';

// Apple Container 中直接透传凭证
const directSecrets = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
if (CONTAINER_RUNTIME_BIN === 'container' && directSecrets.ANTHROPIC_API_KEY) {
  args.push('-e', `ANTHROPIC_API_KEY=${directSecrets.ANTHROPIC_API_KEY}`);
  if (directSecrets.ANTHROPIC_BASE_URL) {
    args.push('-e', `ANTHROPIC_BASE_URL=${directSecrets.ANTHROPIC_BASE_URL}`);
  }
} else {
  // 原有 credential proxy 逻辑（Docker / Linux）
  ...
}
```

---

### 问题 7：Credential proxy 丢失 base URL 路径前缀

**现象**：proxy 对上游的请求路径错误，返回 `404 Not Found`（nginx）。

**原因**：`src/credential-proxy.ts` 转发时用的是 `req.url`（如 `/v1/messages`），
忽略了 `ANTHROPIC_BASE_URL` 中的路径前缀（如 `/coding/`），
导致请求发到 `https://api.kimi.com/v1/messages` 而非 `https://api.kimi.com/coding/v1/messages`。

**解法**（仍保留，对 Docker 模式有效）：
```typescript
const basePath = upstreamUrl.pathname.replace(/\/$/, '');
path: basePath + req.url,
```

---

### 问题 8：注册 chat 后进程不感知（需重启）

**现象**：用 `npx tsx setup/index.ts --step register` 注册 Telegram chat 后，
发消息没有反应，log 显示 "Message from unregistered Telegram chat"。

**原因**：`registeredGroups` 是运行时的内存对象，只在进程**启动时**从 SQLite 加载一次。
setup 脚本是独立进程，只写 SQLite，不更新运行中进程的内存状态。

**解法**：注册后重启 NanoClaw 进程即可。

---

## 已修改文件汇总

| 文件 | 修改内容 |
|------|----------|
| `src/container-runner.ts` | 移除 `/dev/null` 文件 mount；Apple Container 模式直接透传 API 凭证 |
| `src/container-runtime.ts` | `detectProxyBindHost()` Apple Container 返回 `0.0.0.0` |
| `src/credential-proxy.ts` | 转发路径拼接 base URL pathname 前缀 |

---

## 注意事项

- **Node 版本**：必须用 Node 22。系统默认 Node 25 每次都会报错。
  建议写入 shell 配置或用 `.node-version` 文件固定。
- **容器镜像**：修改 `container/` 目录后需重新 `./container/build.sh`。
- **Apple Container 与 Docker 的差异**：
  - 只支持目录 bind mount，不支持文件 mount
  - `host.docker.internal` 解析到 `198.18.0.x`，不是 loopback
  - 宿主机→容器的 TCP 数据流在某些场景下不稳定
- **credential proxy 在 Apple Container 下实际未生效**：容器直接持有明文 API key，
  与原设计的安全隔离不符。个人使用场景可接受，如需恢复安全隔离需另行调试虚拟网络。
