/**
 * NanoClaw 用コンテナランナー
 * コンテナ内でのエージェントの実行を開始し、IPC を処理します
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CREDENTIAL_PROXY_PORT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  TIMEZONE,
} from './config.js';
import {
  encodeIpcNamespaceKey,
  resolveGroupFolderPath,
  resolveGroupIpcPathByJid,
} from './group-folder.js';
import { logger } from './logger.js';
import {
  CONTAINER_HOST_GATEWAY,
  CONTAINER_RUNTIME_BIN,
  hostGatewayArgs,
  readonlyMountArgs,
  stopContainer,
} from './container-runtime.js';
import { detectAuthMode } from './credential-proxy.js';
import { validateAdditionalMounts } from './mount-security.js';
import { getDefaultAllowedTools } from './group-type.js';
import { GroupType, RegisteredGroup } from './types.js';

// 堅牢な出力パースのためのセンチネルマーカー (agent-runner と一致させる必要があります)
const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  // NOTE: isMain (boolean) は意図的に削除。後方互換性は不要（個人プロジェクトのため、ホスト・コンテナは常にセットで更新する運用）。
  groupType: GroupType;
  isScheduledTask?: boolean;
  assistantName?: string;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function resolveSessionNamespace(
  group: RegisteredGroup,
  groupType: GroupType,
  chatJid: string,
): string {
  // main / override は共有せず、chatJid ごとに分離する
  if (groupType === 'main' || groupType === 'override') {
    return `jid-${encodeIpcNamespaceKey(chatJid)}`;
  }
  // chat / thread は同一 folder 内で共有する
  return `folder-${group.folder}`;
}

function buildVolumeMounts(
  group: RegisteredGroup,
  groupType: GroupType,
  chatJid: string,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  // parent_folder が設定されている場合（thread グループ）は親の workspace を使う
  const workspaceFolder = group.parent_folder ?? group.folder;
  const groupDir = resolveGroupFolderPath(workspaceFolder);
  const isPrivileged = groupType === 'main' || groupType === 'override';

  if (isPrivileged) {
    // メイングループにはプロジェクトルートを読み取り専用でマウントします。
    // エージェントが必要とする書き込み可能なパス（グループフォルダ、IPC、.claude/）は、
    // 以下で個別にマウントされます。読み取り専用にすることで、エージェントが
    // ホスト上のアプリケーションコード（src/, dist/, package.json など）を
    // 修正し、次回の起動時にサンドボックスを完全に回避するのを防ぎます。
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // エージェントがマウントされたプロジェクトルートからシークレットを読み取れないように
    // .env を隠します。認証情報は認証情報プロキシによって注入され、
    // コンテナに直接さらされることはありません。
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({
        hostPath: '/dev/null',
        containerPath: '/workspace/project/.env',
        readonly: true,
      });
    }

    // メイングループは、自身のグループフォルダを作業ディレクトリとしても取得します
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // その他のグループは、自身のフォルダのみを取得します
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // グローバルメモリディレクトリ（メイン以外には読み取り専用）
    // ディレクトリマウントのみがサポートされており、ファイルマウントはサポートされていません
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Claude セッションディレクトリの分離ポリシー:
  // - main/override: chatJid ごとに分離
  // - chat/thread: folder 単位で共有
  const sessionNamespace = resolveSessionNamespace(group, groupType, chatJid);
  const groupSessionsRoot = path.join(DATA_DIR, 'sessions', sessionNamespace);
  const groupSessionsDir = path.join(groupSessionsRoot, '.claude');
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  const defaultSettingsEnv: Record<string, string> = {
    // エージェントスウォーム（サブエージェントのオーケストレーション）を有効にする
    // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    // 追加マウントされたディレクトリから CLAUDE.md を読み込む
    // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
    CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
    // Claude のメモリ機能を有効にする（セッション間でユーザー設定を永続化）
    // https://code.claude.com/docs/en/memory#manage-auto-memory
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
  };

  // settings.json が存在する場合は読み込む、存在しない場合やパース失敗時は
  // 「ファイルが無い」と同様に空オブジェクトから始め、後で必須 env を補完する
  let settingsContent: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settingsContent = parsed as Record<string, unknown>;
      }
    } catch (err) {
      logger.warn(
        { group: group.folder, settingsFile, err },
        'Failed to parse settings.json; starting from empty object (existing user settings lost)',
      );
    }
  }

  // env はデフォルト値をベースに既存値で上書きする
  // （新規作成・パース失敗・既存ファイルいずれの場合も CLAUDE_CODE_* フラグが必ず設定される）
  const existingEnv =
    settingsContent.env &&
    typeof settingsContent.env === 'object' &&
    !Array.isArray(settingsContent.env)
      ? (settingsContent.env as Record<string, unknown>)
      : {};
  const dangerousEnvKeys = new Set(['__proto__', 'constructor', 'prototype']);
  const sanitizedExistingEnv = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(existingEnv)) {
    if (typeof value === 'string' && !dangerousEnvKeys.has(key)) {
      sanitizedExistingEnv[key] = value;
    }
  }
  const mergedEnv = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(defaultSettingsEnv)) {
    if (!dangerousEnvKeys.has(key)) {
      mergedEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(sanitizedExistingEnv)) {
    mergedEnv[key] = value;
  }
  settingsContent.env = mergedEnv;
  // permissions を groupType に基づいて常に同期する
  // （既存環境のアップグレードや groupType 変更時も反映されるようにするため）
  const allowedTools = getDefaultAllowedTools(groupType);
  if (allowedTools !== undefined) {
    settingsContent.permissions = { allow: allowedTools, deny: [] };
  } else {
    // main/override: permissions 制限なし → フィールドを削除
    delete settingsContent.permissions;
  }
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(settingsContent, null, 2) + '\n',
  );

  // container/skills/ から各グループの .claude/skills/ にスキルを同期
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
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // グループごとの IPC ネームスペース: 各グループは独自の IPC ディレクトリを持ちます
  // これにより、IPC を介したグループを跨ぐ権限昇格を防ぎます
  const groupIpcDir = resolveGroupIpcPathByJid(chatJid);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // agent-runner のソースをグループごとの書き込み可能な場所にコピーし、エージェントが他のグループに影響を与えずにカスタマイズ（ツールの追加、動作の変更）できるようにします。コンテナ起動時に entrypoint.sh を介して再コンパイルされます。
  const agentRunnerSrc = path.join(
    projectRoot,
    'container',
    'agent-runner',
    'src',
  );
  const groupAgentRunnerDir = path.join(groupSessionsRoot, 'agent-runner-src');
  if (!fs.existsSync(groupAgentRunnerDir) && fs.existsSync(agentRunnerSrc)) {
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // 外部許可リスト（コンテナから改ざん不能）に対して検証された追加マウント
  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isPrivileged,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // コンテナのローカル時間がユーザーと一致するようにホストのタイムゾーンを渡す
  args.push('-e', `TZ=${TIMEZONE}`);

  // API トラフィックを認証情報プロキシ経由でルーティング（コンテナは実際のシークレットを関知しない）
  args.push(
    '-e',
    `ANTHROPIC_BASE_URL=http://${CONTAINER_HOST_GATEWAY}:${CREDENTIAL_PROXY_PORT}`,
  );

  // ホストの認証方法をプレースホルダー値でミラーリング
  // API キーモード: SDK は x-api-key を送信し、プロキシが本物のキーに置き換える
  // OAuth モード:   SDK はプレースホルダー・トークンを一時的な API キーに交換し、プロキシはその交換リクエストに実際の OAuth トークンを注入する
  const authMode = detectAuthMode();
  if (authMode === 'api-key') {
    args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
  } else {
    args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
  }

  // ホストゲートウェイ解決のためのランタイム固有の引数
  args.push(...hostGatewayArgs());

  // バインドマウントされたファイルにアクセスできるよう、ホストユーザーとして実行。root (uid 0)、コンテナの node ユーザー (uid 1000)、またはgetuid が利用できない場合（WSL ではないネイティブ Windows）はスキップ。
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(group, input.groupType, input.chatJid);
  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `nanoclaw-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName);

  logger.debug(
    {
      group: group.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: group.name,
      containerName,
      mountCount: mounts.length,
      groupType: input.groupType,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    // ストリーミング出力: 到着した OUTPUT_START/END マーカーのペアをパース
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // 常にログ用に蓄積
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: group.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // 出力マーカーをストリームパース
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // 不完全なペア。次のデータを待つ

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
            // アクティビティを検出 — ハードタイムアウトをリセット
            resetTimeout();
            // 「サイレント」なクエリ完了でもアイドルタイマーが開始されるよう、すべてのマーカー（null 結果を含む）に対して onOutput を呼び出す。
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

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line);
      }
      // stderr ではタイムアウトをリセットしない — SDK はデバッグログを常に出力するため。タイムアウトは、実際の出力（stdout 内の OUTPUT_MARKER）に対してのみリセットされる。
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: group.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let timedOut = false;
    let hadStreamingOutput = false;
    const configTimeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;
    // 猶予期間: ハード kill が発動する前に、グレースフルな _close センチネルが発動する時間を確保するため、ハードタイムアウトは少なくとも IDLE_TIMEOUT + 30秒である必要があります。
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const killOnTimeout = () => {
      timedOut = true;
      logger.error(
        { group: group.name, containerName },
        'Container timeout, stopping gracefully',
      );
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn(
            { group: group.name, containerName, err },
            'Graceful stop failed, force killing',
          );
          container.kill('SIGKILL');
        }
      });
    };

    let timeout = setTimeout(killOnTimeout, timeoutMs);

    // アクティビティ（ストリーミング出力）があるたびにタイムアウトをリセット
    const resetTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(killOnTimeout, timeoutMs);
    };

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (timedOut) {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const timeoutLog = path.join(logsDir, `container-${ts}.log`);
        fs.writeFileSync(
          timeoutLog,
          [
            `=== Container Run Log (TIMEOUT) ===`,
            `Timestamp: ${new Date().toISOString()}`,
            `Group: ${group.name}`,
            `Container: ${containerName}`,
            `Duration: ${duration}ms`,
            `Exit Code: ${code}`,
            `Had Streaming Output: ${hadStreamingOutput}`,
          ].join('\n'),
        );

        // 出力後のタイムアウト = 失敗ではなく、アイドルのクリーンアップ。
        // エージェントはすでに応答を送信済み。これはアイドル期間が経過した後にコンテナが回収されただけである。
        if (hadStreamingOutput) {
          logger.info(
            { group: group.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain.then(() => {
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
          return;
        }

        logger.error(
          { group: group.name, containerName, duration, code },
          'Container timed out with no output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container timed out after ${configTimeout}ms`,
        });
        return;
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `GroupType: ${input.groupType}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
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
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr,
            stdout,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // ストリーミングモード: 出力チェーンが落ち着くのを待ち、完了マーカーを返す
      if (onOutput) {
        outputChain.then(() => {
          logger.info(
            { group: group.name, duration, newSessionId },
            'Container completed (streaming mode)',
          );
          resolve({
            status: 'success',
            result: null,
            newSessionId,
          });
        });
        return;
      }

      // レガシーモード: 蓄積された stdout から最後の出力マーカーペアをパース
      try {
        // 堅牢なパースのため、センチネルマーカー間の JSON を抽出
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // フォールバック: 最後の空でない行（後方互換性）
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
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      logger.error(
        { group: group.name, containerName, error: err },
        'Container spawn error',
      );
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}

export function writeTasksSnapshot(
  groupJid: string,
  isPrivileged: boolean,
  tasks: Array<{
    id: string;
    groupJid: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>,
): void {
  // フィルタリングされたタスクをグループの IPC ディレクトリに書き込む
  const groupIpcDir = resolveGroupIpcPathByJid(groupJid);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // 特権グループ（main/override）はすべてのタスクを表示でき、非特権グループは自身のタスクのみを表示できる
  const filteredTasks = isPrivileged
    ? tasks
    : tasks.filter((t) => t.groupJid === groupJid);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

/**
 * コンテナが読み取るための利用可能なグループのスナップショットを書き込みます。
 * 特権グループ（main/override）のみが全グループを表示できます。
 * 非特権グループにはこのファイルは空リストとして書き込まれます。
 */
export function writeGroupsSnapshot(
  groupJid: string,
  isPrivileged: boolean,
  groups: AvailableGroup[],
): void {
  const groupIpcDir = resolveGroupIpcPathByJid(groupJid);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  // 特権グループ（main/override）はすべてのグループを表示でき、他は何も表示できない（グループをアクティブ化できないため）
  const visibleGroups = isPrivileged ? groups : [];

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
