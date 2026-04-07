/**
 * Agent Runner for NanoClaw
 * Spawns agent execution as Node.js child processes and handles IPC
 */
import { ChildProcess, execFileSync, execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import os from 'os';
import {
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  ONECLI_URL,
  TIMEZONE,
} from './config.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { OneCLI } from '@onecli-sh/sdk';
import { RegisteredGroup } from './types.js';

const onecli = new OneCLI({ url: ONECLI_URL });
import {
  getLastRotateAt,
  getRotateEnabled,
  getRotateIndex,
  setLastRotateAt,
  setRotateIndex,
} from './db.js';

// agent-runner 编译产物路径
const AGENT_RUNNER_DIST = path.join(
  process.cwd(),
  'container',
  'agent-runner',
  'dist',
  'index.js',
);

// Agent 输出大小限制（10MB）
const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE ||
    process.env.CONTAINER_MAX_OUTPUT_SIZE ||
    '10485760',
  10,
);

// Agent 超时时间（默认 30 分钟）
const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);

/**
 * 检测容器输出中的 429/rate-limit 错误。
 * 覆盖 Anthropic API 常见错误格式。
 */
export function detectRateLimit(text: string): boolean {
  const patterns = [
    /429/i,
    /rate.?limit/i,
    /overloaded/i,
    /quota.?exceeded/i,
    /too.?many.?requests/i,
  ];
  return patterns.some((p) => p.test(text));
}

// 全部耗尽后的 cooldown（10 分钟）
const EXHAUSTED_COOLDOWN_MS = 10 * 60 * 1000;
// 单次轮换防抖（60 秒）
const ROTATE_DEBOUNCE_MS = 60 * 1000;

/**
 * 尝试轮换到下一个 Anthropic 账号。
 * 返回 { success, newSecretName } 或 null（未开启/防抖/全部耗尽）。
 */
export function rotateAccount(agentId: string): {
  success: boolean;
  newSecretName: string;
} | null {
  if (!getRotateEnabled()) return null;

  const now = Date.now();
  const lastRotate = getLastRotateAt();
  if (lastRotate && now - lastRotate < ROTATE_DEBOUNCE_MS) {
    logger.info('轮换防抖中，跳过');
    return null;
  }

  let secrets: Array<{ id: string; name: string }>;
  try {
    secrets = JSON.parse(
      execSync('onecli secrets list', { encoding: 'utf-8', timeout: 5000 }),
    );
  } catch (err) {
    logger.error({ err }, 'rotateAccount: 无法获取 secrets 列表');
    return null;
  }

  if (secrets.length < 2) {
    logger.warn('只有一个 secret，无法轮换');
    return null;
  }

  const currentIndex = getRotateIndex();
  const nextIndex = (currentIndex + 1) % secrets.length;

  if (
    nextIndex === 0 &&
    lastRotate &&
    now - lastRotate < EXHAUSTED_COOLDOWN_MS
  ) {
    logger.warn('所有账号配额已耗尽');
    return { success: false, newSecretName: '' };
  }

  let agents: Array<{ id: string; identifier: string; isDefault?: boolean }>;
  try {
    agents = JSON.parse(
      execSync('onecli agents list', { encoding: 'utf-8', timeout: 5000 }),
    );
  } catch (err) {
    logger.error({ err }, 'rotateAccount: 无法获取 agents 列表');
    return null;
  }

  const agent =
    agents.find((a) => a.identifier === agentId) ||
    agents.find((a) => 'isDefault' in a && a.isDefault);

  if (!agent) {
    logger.error({ agentId }, 'rotateAccount: 找不到 agent');
    return null;
  }

  const nextSecret = secrets[nextIndex];
  try {
    execSync(
      `onecli agents set-secrets --id ${agent.id} --secret-ids ${nextSecret.id}`,
      { encoding: 'utf-8', timeout: 5000 },
    );
  } catch (err) {
    logger.error({ err, secret: nextSecret.name }, 'rotateAccount: 切换失败');
    return null;
  }

  setRotateIndex(nextIndex);
  setLastRotateAt(now);

  logger.info(
    { agent: agent.id, secret: nextSecret.name, index: nextIndex },
    '账号已自动轮换',
  );

  return { success: true, newSecretName: nextSecret.name };
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /** 由 runContainerAgent 内部填充，调用方无需设置 */
  workspacePaths?: {
    group: string;
    project?: string;
    global?: string;
    ipc: string;
    extra?: string;
  };
}

export interface ContainerOutput {
  status: 'success' | 'error' | 'progress';
  result: string | null;
  newSessionId?: string | null;
  error?: string;
  progressType?: 'tool_use' | 'tool_result' | 'thinking';
  /** 步骤标题（进度推送用） */
  title?: string;
  /** 可折叠面板的展开内容（markdown 格式） */
  detail?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    numTurns: number;
    durationMs: number;
    totalCostUsd: number;
    /** 各模型的实际 context window 大小（tokens），key 为模型名 */
    modelContextWindows?: Record<string, number>;
  };
}

// ---- 路径与环境 ----

export interface WorkspacePaths {
  group: string;
  project?: string;
  global?: string;
  ipc: string;
  extra?: string;
}

/** 根据群组计算宿主真实路径 */
export function resolveWorkspacePaths(
  group: RegisteredGroup,
  isMain: boolean,
): WorkspacePaths {
  const projectRoot = process.cwd();
  return {
    group: resolveGroupFolderPath(group.folder),
    project: isMain ? projectRoot : undefined,
    global: path.join(GROUPS_DIR, 'global'),
    ipc: resolveGroupIpcPath(group.folder),
    extra: group.containerConfig?.additionalMounts?.[0]?.hostPath,
  };
}

/** 准备 per-group .claude 配置目录（settings.json + skills 同步） */
export function prepareGroupSession(groupFolder: string): string {
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    groupFolder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });

  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // 同步 container/skills/ → per-group .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }

  return groupSessionsDir;
}

/** 解析 onecli agents get-env 输出的 KEY=VALUE 格式 */
export function parseEnvOutput(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return result;
}

// OneCLI CA 证书临时文件路径
const ONECLI_CA_PATH = path.join(os.tmpdir(), 'onecli-gateway-ca.pem');
const ONECLI_COMBINED_CA_PATH = path.join(
  os.tmpdir(),
  'onecli-combined-ca.pem',
);

/**
 * 获取 OneCLI 代理配置（HTTPS_PROXY + CA 证书），用于凭证注入。
 * OneCLI 网关拦截到 api.anthropic.com 的请求并注入 API key。
 * local 模式下把 host.docker.internal 替换为 localhost。
 */
async function getOneCLIProxyEnv(): Promise<Record<string, string>> {
  try {
    const config = await onecli.getContainerConfig();
    if (!config?.env) return {};

    // 写 CA 证书到临时文件
    if (config.caCertificate) {
      fs.writeFileSync(ONECLI_CA_PATH, config.caCertificate);
      // combined CA = system CA + OneCLI CA (for git etc.)
      const systemCa = process.env.SSL_CERT_FILE
        ? fs.readFileSync(process.env.SSL_CERT_FILE, 'utf-8')
        : '';
      fs.writeFileSync(
        ONECLI_COMBINED_CA_PATH,
        systemCa
          ? `${systemCa}\n${config.caCertificate}`
          : config.caCertificate,
      );
    }

    // 把 host.docker.internal 替换为 localhost（local 模式不走 Docker 网络）
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.env)) {
      env[key] = value.replace(/host\.docker\.internal/g, 'localhost');
    }
    // 修正 CA 证书路径（容器内路径 → 宿主临时文件）
    env.NODE_EXTRA_CA_CERTS = ONECLI_CA_PATH;
    env.SSL_CERT_FILE = ONECLI_COMBINED_CA_PATH;

    logger.info('OneCLI proxy config applied for local agent');
    return env;
  } catch (err) {
    logger.warn(
      { err },
      'OneCLI proxy not available — agent will have no credentials',
    );
    return {};
  }
}

/** 获取非代理凭证（GitHub token、SSH 等） */
function getStaticCredentials(): Record<string, string | undefined> {
  return {
    GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    GITHUB_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    SSH_AGENT_PID: process.env.SSH_AGENT_PID,
  };
}

/** 获取飞书 token — User Token → Tenant Token fallback */
async function getFeishuToken(chatJid?: string): Promise<string | undefined> {
  if (!chatJid?.startsWith('fs:')) return undefined;

  // 优先 User Token（feishu-oauth 为可选 skill，可能未安装）
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const feishuOauth = await import('./channels/feishu-oauth.js' as any);
    const db = await import('./db.js');
    const lastSender = (db as any).getLastSenderForChat?.(chatJid);
    if (lastSender) {
      const userToken = await feishuOauth.getFeishuUserToken(
        lastSender,
        chatJid,
      );
      if (userToken) return userToken;
    }
  } catch {
    /* feishu-oauth 未导入或无 user token */
  }

  // Fallback: Tenant Access Token
  const feishuEnv = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || feishuEnv.FEISHU_APP_ID;
  const appSecret =
    process.env.FEISHU_APP_SECRET || feishuEnv.FEISHU_APP_SECRET;
  if (appId && appSecret) {
    try {
      const resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        },
      );
      const data = (await resp.json()) as { tenant_access_token?: string };
      return data.tenant_access_token;
    } catch {
      /* 非致命 */
    }
  }
  return undefined;
}

/** 构建子进程环境变量（精确过滤，不泄露宿主无关变量） */
async function buildLocalEnv(
  input: ContainerInput,
  groupSessionsDir: string,
): Promise<NodeJS.ProcessEnv> {
  // OneCLI 代理注入（HTTPS_PROXY + CA 证书）
  const proxyEnv = await getOneCLIProxyEnv();
  const staticCreds = getStaticCredentials();

  return {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    NODE_PATH: process.env.NODE_PATH,
    NODE_ENV: process.env.NODE_ENV || 'production',
    TZ: process.env.TZ || TIMEZONE,

    // SSH（纯透传）
    ...staticCreds,

    // OneCLI 代理（HTTPS_PROXY, NODE_EXTRA_CA_CERTS 等）
    ...proxyEnv,

    // Claude SDK
    CLAUDE_CONFIG_DIR: groupSessionsDir,

    // 飞书
    FEISHU_TENANT_TOKEN: await getFeishuToken(input.chatJid),

    // NanoClaw IPC 路径（agent-runner 传给 MCP server）
    NANOCLAW_IPC_DIR: input.workspacePaths!.ipc,

    // Agent SDK 配置 — 与 settings.json 双保险
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
  };
}

/** 检查 agent-runner 编译产物是否存在 */
export function checkAgentRunnerDist(): void {
  if (!fs.existsSync(AGENT_RUNNER_DIST)) {
    throw new Error(
      `agent-runner 未编译: ${AGENT_RUNNER_DIST} 不存在。请运行 npm run build:agent`,
    );
  }
}

/** 杀进程组（包括 MCP server、浏览器等孙进程） */
function killProcessTree(
  pid: number,
  signal: NodeJS.Signals = 'SIGTERM',
): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* 已退出 */
    }
  }
}

// ---- 主函数 ----

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, name: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const isMain = input.isMain;

  // 确保群组目录存在
  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // 准备路径
  const workspacePaths = resolveWorkspacePaths(group, isMain);
  input.workspacePaths = workspacePaths;

  // 准备 per-group .claude 目录
  const groupSessionsDir = prepareGroupSession(group.folder);

  // 准备 IPC 目录
  const groupIpcDir = resolveGroupIpcPath(group.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });

  // 检查 agent-runner 编译产物
  checkAgentRunnerDist();

  // 构建环境变量
  const localEnv = await buildLocalEnv(input, groupSessionsDir);

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const agentName = `nanoclaw-${safeName}-${Date.now()}`;

  logger.info(
    {
      group: group.name,
      agentName,
      isMain,
      cwd: workspacePaths.group,
    },
    'Spawning agent process',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const child = spawn('node', [AGENT_RUNNER_DIST], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: localEnv,
      cwd: workspacePaths.group,
      detached: true,
    });

    // detached 后 unref 让子进程不阻止宿主退出（timeout 时 kill 会处理清理）
    child.unref();

    onProcess(child, agentName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    child.stdin.write(JSON.stringify(input));
    child.stdin.end();

    // 流式解析 stdout 中的 OUTPUT_START/END 标记
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    child.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (!stdoutTruncated) {
        const remaining = AGENT_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Agent stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break;

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed));
          } catch (err) {
            logger.warn(
              { group: group.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ agent: group.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = AGENT_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Agent stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || AGENT_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, agentName },
        'Agent timeout, sending SIGTERM',
      );
      if (child.pid) {
        killProcessTree(child.pid, 'SIGTERM');
        // 5 秒宽限期后 SIGKILL
        setTimeout(() => {
          if (child.pid) killProcessTree(child.pid, 'SIGKILL');
        }, 5000);
      }
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    child.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `agent-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Agent Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, agentName, duration, code },
            'Agent timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({ status: 'success', result: null, newSessionId });
          });
          return;
        }

        logger.error(
          { group: group.name, agentName, duration, code },
          'Agent timed out with no output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `agent-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Agent Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        if (isVerbose) {
          logLines.push(`=== Input ===`, JSON.stringify(input, null, 2), ``);
        } else {
          logLines.push(
            `=== Input Summary ===`,
            `Prompt length: ${input.prompt.length} chars`,
            `Session ID: ${input.sessionId || 'new'}`,
            ``,
          );
        }
        logLines.push(
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Agent log written');

      if (code !== 0) {
        logger.error(
          { group: group.name, code, duration, stderr, stdout, logFile },
          'Agent exited with error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Agent exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // 流式模式：等待 output chain 完成
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Agent completed (streaming mode)',
          );
          resolve({ status: 'success', result: null, newSessionId });
        });
        return;
      }

      // Legacy 模式：从累积 stdout 解析
      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Agent completed',
        );
        resolve(output);
      } catch (err) {
        logger.error(
          { group: group.name, stdout, stderr, error: err },
          'Failed to parse agent output',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse agent output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, agentName, error: err },
        'Agent spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Agent spawn error: ${err.message}`,
      });
    });
  });
}

// ---- IPC 快照（保留不变） ----

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    script?: string | null;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  _registeredJids: Set<string>,
): void {
  const groupIpcDir = resolveGroupIpcPath(groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}
