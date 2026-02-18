/**
 * Local Backend for NanoClaw
 * Runs agents in Apple Container (or Docker) on the local machine.
 * Extracted from container-runner.ts.
 */

import { $ } from 'bun';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_MEMORY,
  CONTAINER_STARTUP_TIMEOUT,
  CONTAINER_TIMEOUT,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
} from '../config.js';
import { logger } from '../logger.js';
import { validateAdditionalMounts } from '../mount-security.js';
import { ContainerProcess } from '../types.js';
import { StreamParser } from './stream-parser.js';
import {
  AgentBackend,
  AgentOrGroup,
  ContainerInput,
  ContainerOutput,
  VolumeMount,
  getContainerConfig,
  getFolder,
  getName,
  getServerFolder,
} from './types.js';

function assertPathWithin(resolved: string, parent: string, label: string): void {
  const normalizedResolved = path.resolve(resolved);
  const normalizedParent = path.resolve(parent);
  if (
    !normalizedResolved.startsWith(normalizedParent + path.sep) &&
    normalizedResolved !== normalizedParent
  ) {
    throw new Error(
      `Path traversal detected in ${label}: ${resolved} escapes ${parent}`,
    );
  }
}

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error(
      'Unable to determine home directory: HOME environment variable is not set and os.homedir() returned empty',
    );
  }
  return home;
}

function buildVolumeMounts(
  group: AgentOrGroup,
  isMain: boolean,
  isScheduledTask: boolean = false,
): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const homeDir = getHomeDir();
  const projectRoot = process.cwd();

  const folder = getFolder(group);
  const srvFolder = getServerFolder(group);

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    });

    // Main also gets its group folder as the working directory
    const groupPath = path.join(GROUPS_DIR, folder);
    assertPathWithin(groupPath, GROUPS_DIR, 'group folder');

    mounts.push({
      hostPath: groupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    const groupPath = path.join(GROUPS_DIR, folder);
    assertPathWithin(groupPath, GROUPS_DIR, 'group folder');

    mounts.push({
      hostPath: groupPath,
      containerPath: '/workspace/group',
      readonly: false,
    });

    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }

    if (srvFolder) {
      const serverDir = path.join(GROUPS_DIR, srvFolder);
      assertPathWithin(serverDir, GROUPS_DIR, 'server folder');
      if (fs.existsSync(serverDir)) {
        mounts.push({
          hostPath: serverDir,
          containerPath: '/workspace/server',
          readonly: false,
        });
      }
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
  const sessionsBase = path.join(DATA_DIR, 'sessions');
  const groupSessionsDir = path.join(sessionsBase, folder, '.claude');
  assertPathWithin(groupSessionsDir, sessionsBase, 'sessions directory');

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

  // Sync skills
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.mkdirSync(dstDir, { recursive: true });
      for (const file of fs.readdirSync(srcDir)) {
        const srcFile = path.join(srcDir, file);
        const dstFile = path.join(dstDir, file);
        fs.copyFileSync(srcFile, dstFile);
      }
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/bun/.claude',
    readonly: false,
  });

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const ipcBase = path.join(DATA_DIR, 'ipc');
  const groupIpcDir = path.join(ipcBase, folder);
  assertPathWithin(groupIpcDir, ipcBase, 'IPC directory');
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input-task'), { recursive: true });

  // Mount the full IPC directory. For scheduled tasks, override the input/
  // subdirectory with input-task/ so follow-up messages don't cross lanes.
  // Note: Apple Container doesn't support file-level bind mounts, so we
  // mount the whole directory and override only the input subdirectory.
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });
  if (isScheduledTask) {
    mounts.push({
      hostPath: path.join(groupIpcDir, 'input-task'),
      containerPath: '/workspace/ipc/input',
      readonly: false,
    });
  }

  // Environment file
  const envDir = path.join(DATA_DIR, 'env');
  fs.mkdirSync(envDir, { recursive: true });
  const envFile = path.join(projectRoot, '.env');
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8');
    const allowedVars = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'CLAUDE_MODEL'];
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return false;
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
    });

    if (filteredLines.length > 0) {
      fs.writeFileSync(
        path.join(envDir, 'env'),
        filteredLines.join('\n') + '\n',
      );
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      });
    }
  }

  // Agent-runner source mount
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
  });

  // Additional mounts
  const containerCfg = getContainerConfig(group);
  if (containerCfg?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      containerCfg.additionalMounts,
      getName(group),
      isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--memory', CONTAINER_MEMORY, '--name', containerName];

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's bun user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/bun');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);
  return args;
}

export class LocalBackend implements AgentBackend {
  readonly name = 'apple-container';

  async runAgent(
    group: AgentOrGroup,
    input: ContainerInput,
    onProcess: (proc: ContainerProcess, containerName: string) => void,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ): Promise<ContainerOutput> {
    const startTime = Date.now();
    const folder = getFolder(group);
    const groupName = getName(group);
    const containerCfg = getContainerConfig(group);

    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });

    const mounts = buildVolumeMounts(group, input.isMain, input.isScheduledTask);
    const safeName = folder.replace(/[^a-zA-Z0-9-]/g, '-');
    const containerName = `nanoclaw-${safeName}-${Date.now()}`;
    const containerArgs = buildContainerArgs(mounts, containerName);
    const configTimeout = containerCfg?.timeout || CONTAINER_TIMEOUT;
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    logger.debug(
      {
        group: groupName,
        containerName,
        mounts: mounts.map(
          (m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
        ),
        containerArgs: containerArgs.join(' '),
      },
      'Container mount configuration',
    );

    logger.info(
      {
        group: groupName,
        containerName,
        mountCount: mounts.length,
        isMain: input.isMain,
      },
      'Spawning container agent',
    );

    const logsDir = path.join(GROUPS_DIR, folder, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    let container: ReturnType<typeof Bun.spawn>;
    try {
      container = Bun.spawn(['container', ...containerArgs], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
    } catch (err) {
      logger.error({ group: groupName, containerName, error: err }, 'Container spawn error');
      return {
        status: 'error',
        result: null,
        error: `Container spawn error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    onProcess(container, containerName);

    // Write input and close stdin
    if (typeof container.stdin === 'number' || !container.stdin) {
      throw new Error('Container stdin is not a writable stream');
    }
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    const killOnTimeout = () => {
      logger.error({ group: groupName, containerName }, 'Container timeout, stopping gracefully');
      const stopProc = Bun.spawn(['container', 'stop', containerName]);
      const killTimer = setTimeout(() => container.kill(9), 15000);
      stopProc.exited.then((code) => {
        if (code === 0) {
          clearTimeout(killTimer);
        } else {
          clearTimeout(killTimer);
          container.kill(9);
        }
      }).catch(() => {
        clearTimeout(killTimer);
        container.kill(9);
      });
    };

    const parser = new StreamParser({
      groupName: groupName,
      containerName,
      timeoutMs,
      startupTimeoutMs: CONTAINER_STARTUP_TIMEOUT,
      maxOutputSize: CONTAINER_MAX_OUTPUT_SIZE,
      onOutput,
      onTimeout: killOnTimeout,
    });

    // Read stderr concurrently
    if (typeof container.stderr === 'number' || !container.stderr) {
      throw new Error('Container stderr is not a readable stream');
    }
    const stderrReader = container.stderr.getReader();
    const stderrDecoder = new TextDecoder();
    const stderrPromise = (async () => {
      try {
        while (true) {
          const { done, value } = await stderrReader.read();
          if (done) break;
          const chunk = stderrDecoder.decode(value, { stream: true });
          parser.feedStderr(chunk);
        }
      } catch {
        // stream closed
      }
    })();

    // Read stdout
    if (typeof container.stdout === 'number' || !container.stdout) {
      throw new Error('Container stdout is not a readable stream');
    }
    const stdoutReader = container.stdout.getReader();
    const stdoutDecoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await stdoutReader.read();
        if (done) break;
        const chunk = stdoutDecoder.decode(value, { stream: true });
        parser.feedStdout(chunk);
      }
    } catch {
      // stream closed
    }

    // Wait for process exit
    const exitCode = await container.exited;
    await stderrPromise;
    parser.cleanup();

    const duration = Date.now() - startTime;
    const state = parser.getState();

    if (state.timedOut) {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const timeoutLog = path.join(logsDir, `container-${ts}.log`);
      fs.writeFileSync(timeoutLog, [
        `=== Container Run Log (TIMEOUT) ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${groupName}`,
        `Container: ${containerName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${exitCode}`,
        `Had Streaming Output: ${state.hadStreamingOutput}`,
      ].join('\n'));

      if (state.hadStreamingOutput) {
        logger.info(
          { group: groupName, containerName, duration, code: exitCode },
          'Container timed out after output (idle cleanup)',
        );
        await state.outputChain;
        return { status: 'success', result: null, newSessionId: state.newSessionId };
      }

      logger.error(
        { group: groupName, containerName, duration, code: exitCode },
        'Container timed out with no output',
      );
      return {
        status: 'error',
        result: null,
        error: `Container timed out after ${configTimeout}ms`,
      };
    }

    // Write log file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `container-${timestamp}.log`);
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

    const logLines = [
      `=== Container Run Log ===`,
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${groupName}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${duration}ms`,
      `Exit Code: ${exitCode}`,
      `Stdout Truncated: ${state.stdoutTruncated}`,
      `Stderr Truncated: ${state.stderrTruncated}`,
      ``,
    ];

    const isError = exitCode !== 0;

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
          .map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
          .join('\n'),
        ``,
        `=== Stderr${state.stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
        state.stderr,
        ``,
        `=== Stdout${state.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
        state.stdout,
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

    if (exitCode !== 0) {
      logger.error(
        {
          group: groupName,
          code: exitCode,
          duration,
          stderr: state.stderr,
          stdout: state.stdout,
          logFile,
        },
        'Container exited with error',
      );
      return {
        status: 'error',
        result: null,
        error: `Container exited with code ${exitCode}: ${state.stderr.slice(-200)}`,
      };
    }

    // Streaming mode
    if (onOutput) {
      await state.outputChain;
      logger.info(
        { group: groupName, duration, newSessionId: state.newSessionId },
        'Container completed (streaming mode)',
      );
      return { status: 'success', result: null, newSessionId: state.newSessionId };
    }

    // Legacy mode: parse last output marker pair
    try {
      const output = parser.parseFinalOutput();
      logger.info(
        {
          group: groupName,
          duration,
          status: output.status,
          hasResult: !!output.result,
        },
        'Container completed',
      );
      return output;
    } catch (err) {
      logger.error(
        { group: groupName, stdout: state.stdout, stderr: state.stderr, error: err },
        'Failed to parse container output',
      );
      return {
        status: 'error',
        result: null,
        error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  sendMessage(groupFolder: string, text: string): boolean {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  closeStdin(groupFolder: string, inputSubdir: string = 'input'): void {
    const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, inputSubdir);
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  writeIpcData(groupFolder: string, filename: string, data: string): void {
    const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
    fs.mkdirSync(groupIpcDir, { recursive: true });
    fs.writeFileSync(path.join(groupIpcDir, filename), data);
  }

  async readFile(groupFolder: string, relativePath: string): Promise<Buffer | null> {
    const fullPath = path.join(GROUPS_DIR, groupFolder, relativePath);
    try {
      return fs.readFileSync(fullPath);
    } catch {
      return null;
    }
  }

  async writeFile(groupFolder: string, relativePath: string, content: Buffer | string): Promise<void> {
    const fullPath = path.join(GROUPS_DIR, groupFolder, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }

  async initialize(): Promise<void> {
    // Kill any orphaned NanoClaw containers from a previous run
    await $`pkill -f 'container run.*nanoclaw-'`.quiet().nothrow();

    // Idempotent start — fast no-op if already running
    logger.info('Starting Apple Container system...');
    const start = await $`container system start`.quiet().nothrow();
    if (start.exitCode !== 0) {
      logger.error({ stderr: start.stderr.toString() }, 'Failed to start Apple Container system');
      this.printContainerSystemError();
      throw new Error('Apple Container system is required but failed to start');
    }

    // Probe to verify containers actually work
    const probe = await $`container run --rm --entrypoint /bin/echo ${CONTAINER_IMAGE} ok`.quiet().nothrow();
    if (probe.exitCode === 0 && probe.text().trim() === 'ok') {
      logger.info('Container system ready (probe passed)');
      await this.cleanupOrphanedContainers();
      return;
    }

    // Probe failed — fall back to full stop/sleep/start cycle
    logger.warn({ exitCode: probe.exitCode, output: probe.text().trim() }, 'Container probe failed, performing full restart cycle...');
    await $`container system stop`.quiet().nothrow();
    await Bun.sleep(3000);

    const retry = await $`container system start`.quiet().nothrow();
    if (retry.exitCode !== 0) {
      logger.error({ stderr: retry.stderr.toString() }, 'Failed to start Apple Container system on retry');
      this.printContainerSystemError();
      throw new Error('Apple Container system failed to start on retry');
    }

    const probe2 = await $`container run --rm --entrypoint /bin/echo ${CONTAINER_IMAGE} ok`.quiet().nothrow();
    if (probe2.exitCode !== 0 || probe2.text().trim() !== 'ok') {
      logger.error('Container probe still failing after full restart');
      this.printContainerSystemError();
      throw new Error('Container system probe failed after restart');
    } else {
      logger.info('Container probe succeeded after full restart');
    }

    await this.cleanupOrphanedContainers();
  }

  private printContainerSystemError(): void {
    console.error(
      '\nFATAL: Container system failed to start.',
      '\nRun `container system start` and restart the application.',
      '\nSee the project README for installation instructions.\n',
    );
  }

  private async cleanupOrphanedContainers(): Promise<void> {
    try {
      const lsResult = await $`container ls --format json`.quiet();
      const containers: { status: string; configuration: { id: string } }[] = JSON.parse(lsResult.text() || '[]');
      const orphans = containers
        .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
        .map((c) => c.configuration.id);
      await Promise.all(orphans.map((name) => $`container stop ${name}`.quiet().nothrow()));
      if (orphans.length > 0) {
        logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  async shutdown(): Promise<void> {
    // Containers clean themselves up via --rm flag
  }
}
