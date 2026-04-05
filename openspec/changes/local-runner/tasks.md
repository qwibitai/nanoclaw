# Tasks

## Task 1: 打 Git Tag 保留 Docker 快照
**Requirements:** R1 (S1.1)

```bash
git tag docker-runtime-v1
git push origin docker-runtime-v1
```

## Task 2: agent-runner 路径可配置化
**Files:** `container/agent-runner/src/index.ts`, `container/agent-runner/src/ipc-mcp-stdio.ts`
**Requirements:** R3 (S3.1, S3.2)

### index.ts（5 处独立 + 1 处派生）

从 stdin 解析 `workspacePaths`（必传），定义 `PATHS` 对象替换所有硬编码路径：

| 行号 | 原始硬编码 | 替换为 |
|------|-----------|--------|
| 67 | `/workspace/ipc/input` | `PATHS.ipcInput`（行 68 `_close` 派生自动跟随） |
| 189 | `/workspace/group/conversations` | `PATHS.conversations` |
| 420 | `/workspace/global/CLAUDE.md` | `PATHS.globalClaudeMd` |
| 429 | `/workspace/extra` | `PATHS.extra` |
| 445 | `cwd: '/workspace/group'` | `cwd: PATHS.group` |

**MCP server env（关键）**：在 `mcpServers.nanoclaw.env` 中添加 `NANOCLAW_IPC_DIR: PATHS.ipc`。

### ipc-mcp-stdio.ts（1 处）

```typescript
const IPC_DIR = process.env.NANOCLAW_IPC_DIR!;
```

另外移除 Docker entrypoint 遗留代码：行 726 `fs.unlinkSync('/tmp/input.json')` 及其 try/catch。

改完后 `grep -r '/workspace' container/agent-runner/src/` 确认只剩注释。

## Task 3: ContainerInput 接口变更
**Files:** `src/container-runner.ts`, `container/agent-runner/src/index.ts`
**Requirements:** R3 (S3.1)

两处 `ContainerInput` 定义中 `workspacePaths` 改为必传：

```typescript
workspacePaths: {
  group: string;
  project?: string;
  global?: string;
  ipc: string;
  extra?: string;
};
```

## Task 4: 重构 container-runner.ts
**Files:** `src/container-runner.ts`
**Requirements:** R2, R4, R5

从现有代码中提取公共逻辑，移除 Docker 代码，实现 local spawn：

1. **提取 `pipeAgentOutput()`** — stdout 解析（marker 匹配、JSON parse、onOutput、timeout）
2. **提取 `prepareGroupSession()`** — per-group .claude 目录（settings.json + skills 同步）
3. **新增 `getCredentials()`** — OneCLI CLI → process.env → .env（用 `execFileSync` 防 shell 注入）
4. **新增 `parseEnvOutput()`** — 解析 `onecli agents get-env` 的 KEY=VALUE 输出为 `Record<string, string>`
5. **新增 `getFeishuToken(chatJid)`** — 提取自现有 `buildContainerArgs()` 行 393-407：User Token → Tenant Token fallback
6. **新增 `resolveWorkspacePaths()`** — 根据群组计算宿主真实路径
7. **新增 `buildLocalEnv()`** — 构建子进程 env（含 `CLAUDE_CONFIG_DIR`、`NANOCLAW_IPC_DIR`、`SSH_AUTH_SOCK`、`NODE_ENV` 等）
8. **新增 `checkAgentRunnerDist()`** — 检查 dist/index.js 存在
9. **新增 `killProcessTree()`** — SIGTERM → 5s 宽限 → SIGKILL，进程组清理
10. **改写 `runContainerAgent()`** — 直接 spawn node 子进程 + `detached: true`
11. **移除** `@onecli-sh/sdk` import + `new OneCLI()` 实例化 + `onecli.applyContainerConfig()`
12. **移除** `buildContainerArgs()`、`buildVolumeMounts()`、Docker 挂载逻辑、per-group source copy、`.env` shadow mount
13. **保留** `detectRateLimit()`、`rotateAccount()`（不依赖 Docker）、`writeTasksSnapshot()`、`writeGroupsSnapshot()`

## Task 5: 移除 Docker 依赖
**Files:** `src/container-runtime.ts`, `src/mount-security.ts`, `src/index.ts`, `src/config.ts`, `container/Dockerfile`, `container/build.sh`
**Requirements:** R8 (S8.1)

- 删除 `src/container-runtime.ts`
- 删除 `src/mount-security.ts`（`validateAdditionalMounts()` 等）
- 删除 `container/Dockerfile` 和 `container/build.sh`
- `src/index.ts`：移除 `ensureContainerSystemRunning()` 调用和 import
- `src/config.ts` 移除以下导出：
  - `CONTAINER_IMAGE`（行 44-45）
  - `CONTAINER_TIMEOUT`（行 46-49）— 改为 `AGENT_TIMEOUT`，保留 timeout 功能
  - `CONTAINER_MAX_OUTPUT_SIZE`（行 50-53）— 改为 `AGENT_MAX_OUTPUT_SIZE`
  - `MAX_CONCURRENT_CONTAINERS`（行 62-64）— 改为 `MAX_CONCURRENT_AGENTS`
  - `MOUNT_ALLOWLIST_PATH`（行 28-33）
  - 更新注释：行 23 "Absolute paths needed for container mounts" → "Absolute paths for agent workspace"
  - 更新注释：行 61 "how long to keep container alive" → "how long to keep agent alive"
- `package.json`：移除 `@onecli-sh/sdk` 依赖（如果是 devDependency 的话保留到 dependencies 清理后移除）

## Task 6: npm script 与构建
**Files:** `package.json`
**Requirements:** R6 (S6.1)

```json
"build:agent": "cd container/agent-runner && npm run build"
```

## Task 7: 文档更新
**Files:** `CLAUDE.md` 或 `README.md`
**Requirements:** R7 (S7.1, S7.2)

- 无沙箱隔离（agent 可写宿主文件系统）
- 不支持 per-group agent-runner 定制化
- `npm run build:agent` 编译 agent-runner
- Docker 方案保留在 git tag `docker-runtime-v1`

## Task 8: 自动化测试
**Files:** `src/container-runner.test.ts`（重写）, `container/agent-runner/src/index.test.ts`（新建）
**Requirements:** R2-R5

### 8A: agent-runner PATHS 解析

```typescript
describe('PATHS resolution', () => {
  it('workspacePaths 传入时使用真实路径', () => {
    const input = {
      prompt: 'test', groupFolder: 'main', chatJid: 'fs:x', isMain: true,
      workspacePaths: {
        group: '/real/groups/main',
        ipc: '/real/data/ipc/main',
        global: '/real/groups/global',
        extra: '/real/extra',
      },
    };
    const paths = resolvePaths(input);
    expect(paths.group).toBe('/real/groups/main');
    expect(paths.ipcInput).toBe('/real/data/ipc/main/input');
    expect(paths.conversations).toBe('/real/groups/main/conversations');
    expect(paths.globalClaudeMd).toBe('/real/groups/global/CLAUDE.md');
    expect(paths.extra).toBe('/real/extra');
  });

  it('可选字段未传时对应路径为 undefined', () => {
    const input = {
      prompt: 'test', groupFolder: 'team-a', chatJid: 'fs:x', isMain: false,
      workspacePaths: { group: '/g/team-a', ipc: '/ipc/team-a' },
    };
    const paths = resolvePaths(input);
    expect(paths.group).toBe('/g/team-a');
    expect(paths.global).toBeUndefined();
    expect(paths.extra).toBeUndefined();
    expect(paths.globalClaudeMd).toBeUndefined();
  });
});
```

### 8A-2: 派生路径完整性

```typescript
describe('PATHS 派生路径', () => {
  const wp = { group: '/g/main', ipc: '/ipc/main', global: '/g/global' };
  const input = { prompt: '', groupFolder: 'main', chatJid: '', isMain: true, workspacePaths: wp };

  it('ipcInput = ipc + /input', () => {
    expect(resolvePaths(input).ipcInput).toBe('/ipc/main/input');
  });

  it('_close 哨兵从 ipcInput 派生', () => {
    const paths = resolvePaths(input);
    // _close 路径应为 ipcInput + /_close（在 agent-runner 中用 path.join 实现）
    expect(path.join(paths.ipcInput, '_close')).toBe('/ipc/main/input/_close');
  });

  it('conversations = group + /conversations', () => {
    expect(resolvePaths(input).conversations).toBe('/g/main/conversations');
  });

  it('globalClaudeMd = global + /CLAUDE.md', () => {
    expect(resolvePaths(input).globalClaudeMd).toBe('/g/global/CLAUDE.md');
  });

  it('global 为 undefined 时 globalClaudeMd 也为 undefined', () => {
    const noGlobal = { ...input, workspacePaths: { group: '/g/x', ipc: '/ipc/x' } };
    expect(resolvePaths(noGlobal).globalClaudeMd).toBeUndefined();
  });
});
```

### 8A-3: 路径含特殊字符

```typescript
describe('PATHS 特殊字符处理', () => {
  it('群组名含中文时路径正确', () => {
    const input = {
      prompt: '', groupFolder: '测试群', chatJid: '', isMain: false,
      workspacePaths: { group: '/groups/测试群', ipc: '/data/ipc/测试群' },
    };
    const paths = resolvePaths(input);
    expect(paths.group).toBe('/groups/测试群');
    expect(paths.ipcInput).toBe('/data/ipc/测试群/input');
  });

  it('路径含空格时正确', () => {
    const input = {
      prompt: '', groupFolder: 'my group', chatJid: '', isMain: false,
      workspacePaths: { group: '/groups/my group', ipc: '/data/ipc/my group' },
    };
    const paths = resolvePaths(input);
    expect(paths.conversations).toBe('/groups/my group/conversations');
  });
});
```

### 8B: ipc-mcp-stdio.ts 环境变量

```typescript
describe('IPC_DIR from env', () => {
  it('读取 NANOCLAW_IPC_DIR', () => {
    process.env.NANOCLAW_IPC_DIR = '/real/ipc';
    expect(getIpcDir()).toBe('/real/ipc');
    delete process.env.NANOCLAW_IPC_DIR;
  });
});
```

### 8C: 宿主端函数

```typescript
describe('resolveWorkspacePaths', () => {
  it('main group 包含 project 路径', () => {
    const p = resolveWorkspacePaths({ folder: 'main', isMain: true });
    expect(p.project).toBeDefined();
    expect(p.group).toContain('/groups/main');
    expect(p.ipc).toContain('/data/ipc/main');
  });

  it('非 main group 不含 project', () => {
    const p = resolveWorkspacePaths({ folder: 'team-a', isMain: false });
    expect(p.project).toBeUndefined();
  });

  it('所有路径为绝对路径', () => {
    const p = resolveWorkspacePaths({ folder: 'main', isMain: true });
    for (const v of Object.values(p)) {
      if (v) expect(v).toMatch(/^\//);
    }
  });
});

describe('resolveWorkspacePaths 路径一致性', () => {
  it('global 指向 groups/global', () => {
    const p = resolveWorkspacePaths({ folder: 'main', isMain: true });
    expect(p.global).toMatch(/groups\/global$/);
  });

  it('group 和 ipc 都包含 group.folder', () => {
    const p = resolveWorkspacePaths({ folder: 'team-x', isMain: false });
    expect(p.group).toContain('team-x');
    expect(p.ipc).toContain('team-x');
  });

  it('含中文的 folder 也能正确拼接', () => {
    const p = resolveWorkspacePaths({ folder: '研发群', isMain: false });
    expect(p.group).toContain('研发群');
    expect(p.ipc).toContain('研发群');
  });
});

describe('prepareGroupSession', () => {
  it('不同群组返回不同路径', () => {
    const a = prepareGroupSession('group-a');
    const b = prepareGroupSession('group-b');
    expect(a).toContain('group-a');
    expect(b).toContain('group-b');
    expect(a).not.toBe(b);
  });

  it('返回路径与 CLAUDE_CONFIG_DIR 一致', () => {
    const dir = prepareGroupSession('main');
    // buildLocalEnv 中会把这个路径设为 CLAUDE_CONFIG_DIR
    expect(dir).toMatch(/sessions\/main\/\.claude$/);
  });

  it('IPC 子目录创建（messages/, input/, tasks/）', () => {
    // 由 runContainerAgent 在 spawn 前调用 mkdirSync
    // 验证 mkdirSync 被调用了正确的子路径
    prepareGroupSession('test');
    expect(fs.mkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('sessions/test/.claude'),
      expect.objectContaining({ recursive: true }),
    );
  });
});

describe('buildLocalEnv', () => {
  it('包含 CLAUDE_CONFIG_DIR', async () => {
    const env = await buildLocalEnv(testInput, '/sessions/.claude');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/sessions/.claude');
  });

  it('包含 NANOCLAW_IPC_DIR', async () => {
    const input = { ...testInput, workspacePaths: { group: '/g', ipc: '/real/ipc' } };
    const env = await buildLocalEnv(input, '/sessions/.claude');
    expect(env.NANOCLAW_IPC_DIR).toBe('/real/ipc');
  });

  it('不泄露无关环境变量', async () => {
    process.env.DATABASE_PASSWORD = 'secret';
    const env = await buildLocalEnv(testInput, '/sessions/.claude');
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    delete process.env.DATABASE_PASSWORD;
  });
});

describe('parseEnvOutput', () => {
  it('解析标准 KEY=VALUE 格式', () => {
    expect(parseEnvOutput('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('值中包含 = 时正确分割', () => {
    expect(parseEnvOutput('KEY=a=b=c')).toEqual({ KEY: 'a=b=c' });
  });

  it('跳过空行', () => {
    expect(parseEnvOutput('A=1\n\nB=2\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('killProcessTree', () => {
  it('优先杀进程组', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    killProcessTree(12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('进程组不存在时 fallback 到单进程', () => {
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementationOnce(() => { throw new Error('ESRCH'); })
      .mockImplementationOnce(() => true);
    killProcessTree(12345, 'SIGTERM');
    expect(killSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('进程已退出时不抛异常', () => {
    const killSpy = vi.spyOn(process, 'kill')
      .mockImplementation(() => { throw new Error('ESRCH'); });
    expect(() => killProcessTree(12345)).not.toThrow();
    killSpy.mockRestore();
  });
});

describe('checkAgentRunnerDist', () => {
  it('存在时不报错', () => {
    fs.existsSync.mockReturnValue(true);
    expect(() => checkAgentRunnerDist()).not.toThrow();
  });

  it('不存在时抛出含 build:agent 的错误', () => {
    fs.existsSync.mockReturnValue(false);
    expect(() => checkAgentRunnerDist()).toThrow(/build:agent/);
  });
});
```

### 8D: spawn 验证

```typescript
describe('runContainerAgent', () => {
  it('spawn node 子进程（非 docker）', async () => {
    fs.existsSync.mockReturnValue(true);
    runContainerAgent(testGroup, testInput, () => {}, vi.fn());
    expect(spawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['dist/index.js']),
      expect.objectContaining({ detached: true }),
    );
  });

  it('spawn 的 cwd 设为 workspacePaths.group', async () => {
    fs.existsSync.mockReturnValue(true);
    runContainerAgent(testGroup, testInput, () => {}, vi.fn());
    expect(spawn).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        cwd: expect.stringContaining(testGroup.folder),
      }),
    );
  });

  it('stdin 写入的 ContainerInput 包含 workspacePaths', async () => {
    fs.existsSync.mockReturnValue(true);
    runContainerAgent(testGroup, testInput, () => {}, vi.fn());
    const written = fakeProc.stdin.read()?.toString();
    const parsed = JSON.parse(written);
    expect(parsed.workspacePaths).toBeDefined();
    expect(parsed.workspacePaths.group).toContain(testGroup.folder);
    expect(parsed.workspacePaths.ipc).toContain(testGroup.folder);
  });

  it('stdin workspacePaths 路径全为绝对路径', async () => {
    fs.existsSync.mockReturnValue(true);
    runContainerAgent(testGroup, testInput, () => {}, vi.fn());
    const parsed = JSON.parse(fakeProc.stdin.read()?.toString());
    for (const [key, val] of Object.entries(parsed.workspacePaths)) {
      if (val) expect(val).toMatch(/^\//);
    }
  });

  it('main group stdin 包含 project 路径，非 main 不包含', async () => {
    fs.existsSync.mockReturnValue(true);

    // main group
    const mainGroup = { ...testGroup, isMain: true };
    runContainerAgent(mainGroup, { ...testInput, isMain: true }, () => {}, vi.fn());
    const mainParsed = JSON.parse(fakeProc.stdin.read()?.toString());
    expect(mainParsed.workspacePaths.project).toBeDefined();

    // 非 main
    fakeProc = createFakeProcess();  // 重置
    runContainerAgent(testGroup, testInput, () => {}, vi.fn());
    const nonMainParsed = JSON.parse(fakeProc.stdin.read()?.toString());
    expect(nonMainParsed.workspacePaths.project).toBeUndefined();
  });
});
```

### 8E: MCP server env

```typescript
describe('mcpServers.nanoclaw.env', () => {
  it('包含 NANOCLAW_IPC_DIR', () => {
    const env = buildMcpServerEnv(containerInput, paths);
    expect(env.NANOCLAW_IPC_DIR).toBe(paths.ipc);
  });
});
```

### 8F: 路径目录对照验证（手动）

| 原 Docker 容器路径 | 宿主真实路径 | 验证方法 |
|-------------------|-------------|---------|
| `/workspace/group` | `groups/{name}/` | agent 写 CLAUDE.md → 出现在 `groups/{name}/` |
| `/workspace/group/conversations` | `groups/{name}/conversations/` | 触发归档 → .md 出现 |
| `/workspace/project` | 项目根 | agent 读 `package.json` → 成功 |
| `/workspace/global` | `groups/global/` | 非 main 群 → 加载全局 CLAUDE.md |
| `/workspace/ipc` | `data/ipc/{name}/` | MCP send_message → 文件出现在 `data/ipc/{name}/messages/` |
| `/workspace/ipc/input` | `data/ipc/{name}/input/` | 后续消息 → IPC input 正确消费 |
| `/workspace/extra` | additionalMounts 路径 | 配额外挂载 → agent 读取其 CLAUDE.md |
| `/home/node/.claude` | `data/sessions/{name}/.claude` | settings.json 存在且配置正确 |

## Task 9: 端到端验证（手动）
**Requirements:** 全部

- [ ] 飞书发消息 → agent 正常回复
- [ ] API key 成功注入
- [ ] IPC 双向通信正常（send_message MCP 工具）
- [ ] 进度卡片、usage 脚注、typing indicator 正常
- [ ] Session 持久化跨请求
- [ ] 子进程退出后无残留进程
- [ ] dist/index.js 不存在 → 明确错误
- [ ] 无 Docker 环境 → 正常启动
- [ ] 两个群同时消息 → 各自独立

## 执行顺序
Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 6 → Task 7 → Task 8 → Task 9

全部完成后：`npm run build && npm run build:agent && npm test` 必须通过。
