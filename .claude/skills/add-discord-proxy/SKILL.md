# Add Discord Proxy Support

为 NanoClaw 的 Discord 频道添加代理支持，适用于网络受限环境（如中国大陆）。

## 问题背景

Discord API 在某些地区（如中国大陆）无法直接访问。此 skill 为 discord.js 的 HTTP 和 WebSocket 连接配置代理，使 NanoClaw 能够在这些环境中正常连接 Discord。

## 使用方法

在 NanoClaw 项目目录下运行：

```
/add-discord-proxy
```

## 前置条件

1. 已运行 `/add-discord` 配置好 Discord 频道
2. 有一个可用的 HTTP 代理服务器（如 Clash、V2rayU 等）

## 实施步骤

### 1. 安装依赖

```bash
npm install https-proxy-agent undici --save
```

### 2. 创建预加载脚本

创建 `src/preload-proxy.ts` 文件，用于在模块加载前配置代理：

```typescript
// src/preload-proxy.ts
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Read proxy from .env or environment
function getProxy(): string | undefined {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (envProxy) return envProxy;

  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HTTPS_PROXY=') || trimmed.startsWith('HTTP_PROXY=')) {
        const eqIdx = trimmed.indexOf('=');
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch { /* .env not found */ }
  return undefined;
}

const proxy = getProxy();
if (proxy) {
  console.log(`[Preload] Setting up proxy: ${proxy}`);

  // Set up undici proxy for HTTP requests
  const proxyAgent = new ProxyAgent(proxy);
  setGlobalDispatcher(proxyAgent);

  // Set environment variables
  process.env.HTTPS_PROXY = proxy;
  process.env.HTTP_PROXY = process.env.HTTP_PROXY || proxy;

  // Patch ws module for WebSocket proxy
  const httpsAgent = new HttpsProxyAgent(proxy);
  const Module = require('module');
  const originalLoad = Module._load;

  Module._load = function(request: string, parent: any, isMain: boolean) {
    const result = originalLoad.apply(this, [request, parent, isMain]);

    if (request === 'ws') {
      const OriginalWebSocket = result.WebSocket || result;
      const proxiedWs = class extends OriginalWebSocket {
        constructor(address: any, protocols?: any, options?: any) {
          super(address, protocols, { ...options, agent: httpsAgent });
        }
      };
      return { ...result, WebSocket: proxiedWs, default: proxiedWs };
    }

    return result;
  };

  console.log(`[Preload] Proxy setup complete`);
}
```

### 3. 修改 src/index.ts

在文件最开头（所有其他 import 之前）添加代理配置：

```typescript
// Configure proxy support BEFORE any other imports
import fs from 'fs';
import path from 'path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket from 'ws';

function readProxyFromEnv(): string | undefined {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  if (envProxy) return envProxy;

  try {
    const envPath = path.join(process.cwd(), '.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('HTTPS_PROXY=') || trimmed.startsWith('HTTP_PROXY=')) {
        const eqIdx = trimmed.indexOf('=');
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        return value;
      }
    }
  } catch { /* ignore */ }
  return undefined;
}

const HTTPS_PROXY = readProxyFromEnv();

if (HTTPS_PROXY) {
  const proxyAgent = new HttpsProxyAgent(HTTPS_PROXY);
  console.log(`[Proxy] Proxy configured: ${HTTPS_PROXY}`);

  // Configure proxy for undici (HTTP requests)
  const { ProxyAgent, setGlobalDispatcher } = await import('undici');
  const undiciProxyAgent = new ProxyAgent(HTTPS_PROXY);
  setGlobalDispatcher(undiciProxyAgent);

  // Patch global WebSocket to use proxy
  const OriginalWebSocket = WebSocket as any;
  global.WebSocket = class extends OriginalWebSocket {
    constructor(address: string | URL, protocols?: any, options?: any) {
      super(address, protocols, { ...options, agent: proxyAgent });
    }
  };
  console.log(`[Proxy] WebSocket patched`);
}

// ... rest of the original imports
import fs from 'fs';
// ... etc
```

### 4. 添加断线重连事件处理（可选但推荐）

在 `src/channels/discord.ts` 的 `connect()` 方法中，在 `Events.Error` 处理之后添加：

```typescript
// Handle disconnection — log and let discord.js auto-reconnect
this.client.on(Events.ShardDisconnect, (closeEvent, shardId) => {
  logger.warn(
    { shardId, code: closeEvent.code, reason: closeEvent.reason },
    'Discord shard disconnected, auto-reconnect enabled',
  );
});

// Handle reconnecting events
this.client.on(Events.ShardReconnecting, (shardId) => {
  logger.info({ shardId }, 'Discord shard reconnecting...');
});

// Handle successful resume after reconnect
this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
  logger.info({ shardId, replayedEvents }, 'Discord shard resumed connection');
});

// Handle shard ready
this.client.on(Events.ShardReady, (shardId) => {
  logger.info({ shardId }, 'Discord shard ready');
});
```

### 5. 配置 .env 文件

在项目根目录的 `.env` 文件中添加代理配置：

```env
# Proxy for Discord (required in restricted networks like China)
HTTPS_PROXY=http://127.0.0.1:7890
HTTP_PROXY=http://127.0.0.1:7890
```

将 `127.0.0.1:7890` 替换为你的代理地址和端口。常见代理端口：
- Clash: `7890`
- V2rayU: `1087`
- Surge: `6152`
- Shadowsocks: `1080`

### 6. 修改启动方式

使用 `--import` 标志启动，确保代理在模块加载前配置：

```bash
node --import ./dist/preload-proxy.js dist/index.js
```

或修改 `package.json` 的启动脚本：

```json
{
  "scripts": {
    "start": "node --import ./dist/preload-proxy.js dist/index.js"
  }
}
```

### 7. 重新构建并启动

```bash
npm run build
npm start
```

## 验证

启动后检查日志，应该看到：

```
[Preload] Setting up proxy: http://127.0.0.1:7890
[Preload] Proxy setup complete
[Proxy] Proxy configured: http://127.0.0.1:7890
[Proxy] WebSocket patched
INFO: Discord bot connected
```

## 故障排除

### 连接超时

如果仍然看到 `ConnectTimeoutError`，检查：
1. 代理服务是否正在运行
2. 代理端口是否正确
3. 代理是否支持 HTTPS 和 WebSocket

### TLS 证书错误

如果看到证书不匹配错误，可能是代理配置问题。确保代理正确转发 TLS 连接。

### 测试代理

```bash
# 测试 HTTP 代理
curl -x http://127.0.0.1:7890 https://discord.com/api/v10/gateway

# 测试 WebSocket 代理
node -e "
const { HttpsProxyAgent } = require('https-proxy-agent');
const WebSocket = require('ws');
const agent = new HttpsProxyAgent('http://127.0.0.1:7890');
const ws = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json', { agent });
ws.on('open', () => console.log('WebSocket connected!'));
ws.on('error', (e) => console.log('Error:', e.message));
setTimeout(() => process.exit(0), 10000);
"
```

## 技术细节

- **undici**: 用于 HTTP 请求的代理，discord.js 使用 undici 进行 REST API 调用
- **https-proxy-agent**: 用于 WebSocket 连接的代理
- **Module._load 补丁**: 拦截 `ws` 模块加载，注入代理 agent
- **全局 WebSocket 补丁**: 部分环境使用全局 WebSocket，需要同时补丁

## 回滚

如需移除代理支持：

1. 删除 `src/preload-proxy.ts`
2. 移除 `src/index.ts` 开头的代理配置代码
3. 从 `.env` 中删除 `HTTPS_PROXY` 和 `HTTP_PROXY`
4. 直接运行 `node dist/index.js` 启动
