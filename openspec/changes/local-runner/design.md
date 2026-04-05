## Architecture

### 整体流程

```
用户消息 → processGroupMessages()
  → runAgent()
    → prepareGroupSession()   // per-group .claude 目录 + skills 同步
    → buildLocalEnv()         // 构建子进程环境变量
    → checkAgentRunnerDist()  // 检查 dist/index.js 存在
    → spawn('node', ['container/agent-runner/dist/index.js'])
    → stdin 写入 ContainerInput（含 workspacePaths）
    → pipeAgentOutput()       // stdout 解析 OUTPUT_START/END 标记
```

### 启动流程变化

```
main()
  → 移除 ensureContainerSystemRunning()（不再需要 Docker 检查）
  → initDatabase()
  → loadState()
  → ...
```

### 模块变化

**移除：**
- `container-runtime.ts` — Docker 运行时检测、`stopContainer()`、`cleanupOrphans()`
- `@onecli-sh/sdk` import 和 `new OneCLI()` 实例化 — 不再需要容器网关注入（改用 OneCLI CLI 模式）
- `onecli.applyContainerConfig()` 调用
- `buildContainerArgs()` — Docker `-e`/`-v` 参数构建
- `buildVolumeMounts()` — Docker 挂载逻辑（per-group .claude 准备提取为 `prepareGroupSession()`）
- per-group agent-runner 源码拷贝机制（行 314-345）
- `.env` shadow mount（行 206-214，Docker 用 `/dev/null` 遮蔽 `.env`）— local 模式下 agent 可读宿主 `.env`，见 Risks
- `mount-security.ts` — Docker 挂载安全验证，local 模式不适用
- `MOUNT_ALLOWLIST_PATH`（config.ts）— 随 `mount-security.ts` 一起移除
- `container/Dockerfile` 和 `container/build.sh` — 删除（git tag 中保留）

**保留不变：**
- `detectRateLimit()` / `rotateAccount()` — 账号轮换逻辑不依赖 Docker，保留
- `writeTasksSnapshot()` / `writeGroupsSnapshot()` — IPC 快照写入，保留

**保留并重构 `container-runner.ts`：**
```
container-runner.ts
├── runContainerAgent()         // 入口，直接 spawn node 子进程
│   ├── prepareGroupSession()   // 提取：per-group .claude 目录准备
│   ├── resolveWorkspacePaths() // 新增：计算宿主真实路径
│   ├── buildLocalEnv()         // 新增：构建子进程 env
│   ├── checkAgentRunnerDist()  // 新增：检查 dist 存在
│   └── pipeAgentOutput()       // 提取：stdout 解析 + timeout（从现有代码提取）
├── getCredentials()            // 提取：凭证获取
├── getFeishuToken()            // 提取自 buildContainerArgs()：飞书 token 获取（User Token → Tenant Token fallback）
├── parseEnvOutput()            // 新增：解析 `onecli agents get-env` 的 KEY=VALUE 输出为 Record<string, string>
├── killProcessTree()           // 新增：信号处理 + 进程组清理
├── detectRateLimit()           // 保留不变
├── rotateAccount()             // 保留不变
├── writeTasksSnapshot()        // 保留不变
└── writeGroupsSnapshot()       // 保留不变
```

### 路径映射

Docker 挂载（移除） → 宿主真实路径（新）：

| 原 Docker 容器路径 | 宿主真实路径 | 传递方式 |
|-------------------|-------------|---------|
| `/workspace/group` | `groups/{name}/` | `workspacePaths.group` |
| `/workspace/project` | 项目根目录 | `workspacePaths.project`（可选） |
| `/workspace/global` | `groups/global/` | `workspacePaths.global`（可选） |
| `/workspace/ipc` | `data/ipc/{name}/` | `workspacePaths.ipc` |
| `/workspace/extra` | additionalMounts 路径 | `workspacePaths.extra`（可选） |
| `/home/node/.claude` | `data/sessions/{name}/.claude` | env `CLAUDE_CONFIG_DIR` |

```typescript
function resolveWorkspacePaths(group: RegisteredGroup, isMain: boolean): WorkspacePaths {
  const projectRoot = process.cwd();
  return {
    group: path.join(projectRoot, 'groups', group.folder),
    project: isMain ? projectRoot : undefined,
    global: path.join(projectRoot, 'groups', 'global'),
    ipc: path.join(projectRoot, 'data', 'ipc', group.folder),
    extra: group.containerConfig?.additionalMounts?.[0]?.hostPath,
  };
}
```

### agent-runner 路径适配

**index.ts 中 5 处独立硬编码 + 1 处派生，全部改为从 workspacePaths 读取（不需要 fallback）：**

```typescript
const config: ContainerInput = JSON.parse(stdinData);
const wp = config.workspacePaths!;  // local 模式下必传
const PATHS = {
  group:         wp.group,
  project:       wp.project,    // 当前 agent-runner 代码不直接引用，保留供未来使用
  global:        wp.global,
  ipc:           wp.ipc,
  extra:         wp.extra,
  ipcInput:      path.join(wp.ipc, 'input'),
  conversations: path.join(wp.group, 'conversations'),
  globalClaudeMd: wp.global ? path.join(wp.global, 'CLAUDE.md') : undefined,
};
```

原始引用位置对照：

| 行号 | 原始值 | 替换为 |
|------|--------|--------|
| 67 | `/workspace/ipc/input` | `PATHS.ipcInput` |
| 189 | `/workspace/group/conversations` | `PATHS.conversations` |
| 420 | `/workspace/global/CLAUDE.md` | `PATHS.globalClaudeMd` |
| 429 | `/workspace/extra` | `PATHS.extra` |
| 445 | `cwd: '/workspace/group'` | `cwd: PATHS.group` |

行 68（`_close` 哨兵）从 `PATHS.ipcInput` 派生，自动跟随。

**ipc-mcp-stdio.ts（MCP server 独立子进程）：**

```typescript
const IPC_DIR = process.env.NANOCLAW_IPC_DIR!;  // 必须由 agent-runner 通过 mcpServers.env 传入
```

agent-runner 的 mcpServers 配置中显式添加：

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
      NANOCLAW_IPC_DIR: PATHS.ipc,  // 新增
    },
  },
},
```

### Per-group .claude 配置隔离

从现有 `buildVolumeMounts()` 提取为独立函数：

```typescript
function prepareGroupSession(groupFolder: string): string {
  const groupSessionsDir = path.join(DATA_DIR, 'sessions', groupFolder, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  syncSkills(groupSessionsDir);
  return groupSessionsDir;
}
```

通过 env `CLAUDE_CONFIG_DIR=groupSessionsDir` 让 SDK 使用 per-group 目录。

### 辅助函数

```typescript
/** 解析 `onecli agents get-env` 输出的 KEY=VALUE 格式为 Record */
function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

/** 获取飞书 token — 提取自现有 buildContainerArgs() 行 393-407 */
async function getFeishuToken(chatJid?: string): Promise<string | undefined> {
  if (!chatJid?.startsWith('fs:')) return undefined;

  // 优先 User Token（有文档读写权限）
  try {
    const { getFeishuUserToken } = await import('./channels/feishu-oauth.js');
    const { getLastSenderForChat } = await import('./db.js');
    const lastSender = getLastSenderForChat(chatJid);
    if (lastSender) {
      const userToken = await getFeishuUserToken(lastSender, chatJid);
      if (userToken) return userToken;
    }
  } catch { /* feishu-oauth 未导入或无 user token */ }

  // Fallback: Tenant Access Token
  const feishuEnv = (await import('./env.js')).readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || feishuEnv.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || feishuEnv.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    try {
      const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      });
      const data = (await resp.json()) as { tenant_access_token?: string };
      return data.tenant_access_token;
    } catch { /* 非致命 */ }
  }
  return undefined;
}
```

### 凭证注入

```typescript
async function getCredentials(agentId?: string): Promise<{
  anthropicApiKey?: string;
  ghToken?: string;
  sshAuthSock?: string;
}> {
  // 注意：飞书 token 需要 chatJid 参数，在 buildLocalEnv() 中单独获取。
  // SSH_AGENT_PID 为纯透传，也在 buildLocalEnv() 中直接读取 process.env。

  let anthropicApiKey: string | undefined;
  if (agentId) {
    try {
      const out = execFileSync('onecli', ['agents', 'get-env', '--id', agentId], { encoding: 'utf8' });
      anthropicApiKey = parseEnvOutput(out).ANTHROPIC_API_KEY;
    } catch { /* OneCLI 不可用 */ }
  }
  anthropicApiKey ??= process.env.ANTHROPIC_API_KEY;
  anthropicApiKey ??= readEnvFile(['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY;

  return {
    anthropicApiKey,
    ghToken: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    sshAuthSock: process.env.SSH_AUTH_SOCK,
  };
}

async function buildLocalEnv(
  input: ContainerInput,
  groupSessionsDir: string,
  agentId?: string,
): Promise<NodeJS.ProcessEnv> {
  const creds = await getCredentials(agentId);

  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    NODE_ENV: process.env.NODE_ENV || 'production',
    TZ: process.env.TZ || 'Asia/Shanghai',

    SSH_AUTH_SOCK: creds.sshAuthSock,
    SSH_AGENT_PID: process.env.SSH_AGENT_PID,

    ANTHROPIC_API_KEY: creds.anthropicApiKey,
    CLAUDE_CONFIG_DIR: groupSessionsDir,

    GH_TOKEN: creds.ghToken,
    GITHUB_TOKEN: creds.ghToken,

    FEISHU_TENANT_TOKEN: await getFeishuToken(input.chatJid),

    NANOCLAW_IPC_DIR: input.workspacePaths.ipc,

    // 与 settings.json 双保险：env 优先于 settings.json
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
}
```

### 子进程管理

```typescript
function killProcessTree(pid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  try {
    process.kill(-pid, signal);  // 杀进程组
  } catch {
    try { process.kill(pid, signal); } catch { /* 已退出 */ }
  }
}

// spawn 配置
const child = spawn('node', [agentRunnerPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: localEnv,
  cwd: workspacePaths.group,
  detached: true,  // 创建新进程组
});

// timeout: SIGTERM → 5s → SIGKILL
```

### stdout 解析复用

从现有 Docker 模式的 stdout 解析逻辑提取为独立函数：

```typescript
function pipeAgentOutput(
  stdout: Readable,
  onOutput: (output: ContainerOutput) => Promise<void>,
  opts: { groupName: string; maxSize: number; onActivity: () => void },
): { getNewSessionId: () => string | null }
```

## Data Model

### ContainerInput 变化

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  // 新增（必传）
  workspacePaths: {
    group: string;
    project?: string;
    global?: string;
    ipc: string;
    extra?: string;
  };
}
```

注意：`workspacePaths` 从可选变为**必传**（不再需要 Docker fallback）。

## 关键设计说明

### sdkEnv 安全性

agent-runner 内部 `const sdkEnv = { ...process.env }` 会把子进程的完整 env 透传给 SDK。在 Docker 模式下容器 env 已被隔离，但 local 模式下需要关注：

**结论：安全。** 因为 `spawnLocalAgent()` 中 `spawn('node', ..., { env: localEnv })` 传入的是 `buildLocalEnv()` 精心过滤后的 env 对象。子进程的 `process.env` 就是 `localEnv`（不是宿主进程的完整 env），所以 agent-runner 内 `{ ...process.env }` 只能看到已过滤的变量。

### .env 文件暴露

Docker 模式用 `/dev/null` shadow mount 遮蔽了 `.env`，防止容器读取 secrets。local 模式下 agent 子进程继承了宿主 `HOME`，且 cwd 设为 `workspacePaths.group`（非项目根），但 agent 仍可通过 `Read` 工具读取项目根下的 `.env`。这是 local 模式已知的安全降级，在 R7 文档中标注。

### timeout 重置机制

timeout 从启动或上次收到 `OUTPUT_MARKER` 时重置（活动检测），而非固定倒计时。超时后 SIGTERM → 5s 宽限 → SIGKILL。

## Risks

1. **文件系统安全**: agent 可访问宿主任意文件（含 project 目录可写、`.env` 可读）→ 依赖 Claude SDK 工具白名单，无沙箱隔离，文档标注
2. **路径硬编码遗漏**: agent-runner 中 7 处 `/workspace` 引用需修改 + `/tmp/input.json` 清理代码需移除 → grep 全量确认
3. **MCP server 环境变量**: SDK spawn MCP server 时仅传 mcpServers.env 中列出的变量 → 必须显式添加 `NANOCLAW_IPC_DIR`
4. **OneCLI 凭证**: 不再走容器网关 → 移除 `@onecli-sh/sdk`，改用 `execFileSync('onecli', ...)` CLI 模式 + fallback
5. **子进程泄漏**: `detached: true` + `killProcessTree(-pid)` 清理进程组
6. **并发安全**: IPC 和 .claude 目录已按群隔离，风险低
7. **回退风险**: git tag `docker-runtime-v1` 保留完整 Docker 代码快照
