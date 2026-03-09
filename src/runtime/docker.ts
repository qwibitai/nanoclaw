/**
 * Docker runtime implementation.
 * Wraps the Docker CLI to implement the Runtime interface.
 */
import { ChildProcess, execSync, spawn } from 'child_process';

import { logger } from '../logger.js';
import {
  Runtime,
  RuntimeConfig,
  RuntimeInstance,
  VolumeMount,
} from './runtime.js';

const DOCKER_BIN = 'docker';

/**
 * Wraps a Docker container ChildProcess as a RuntimeInstance.
 */
class DockerInstance implements RuntimeInstance {
  name: string;
  private proc: ChildProcess;

  constructor(name: string, proc: ChildProcess) {
    this.name = name;
    this.proc = proc;
  }

  writeInput(data: string): void {
    this.proc.stdin!.write(data);
  }

  closeInput(): void {
    this.proc.stdin!.end();
  }

  kill(signal?: string): void {
    this.proc.kill(signal as NodeJS.Signals);
  }

  onStdout(handler: (data: Buffer) => void): void {
    this.proc.stdout!.on('data', handler);
  }

  onStderr(handler: (data: Buffer) => void): void {
    this.proc.stderr!.on('data', handler);
  }

  onClose(handler: (code: number | null) => void): void {
    this.proc.on('close', handler);
  }

  onError(handler: (err: Error) => void): void {
    this.proc.on('error', handler);
  }

  async stop(): Promise<void> {
    try {
      execSync(`${DOCKER_BIN} stop ${this.name}`, {
        stdio: 'pipe',
        timeout: 15000,
      });
    } catch {
      this.proc.kill('SIGKILL');
    }
  }
}

export class DockerRuntime implements Runtime {
  readonly type = 'docker';

  ensureRunning(): void {
    try {
      execSync(`${DOCKER_BIN} info`, { stdio: 'pipe', timeout: 10000 });
      logger.debug('Container runtime already running');
    } catch (err) {
      logger.error({ err }, 'Failed to reach container runtime');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Container runtime failed to start                      ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without a container runtime. To fix:        ║',
      );
      console.error(
        '║  1. Ensure Docker is installed and running                     ║',
      );
      console.error(
        '║  2. Run: docker info                                           ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                           ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Container runtime is required but failed to start');
    }
  }

  cleanupOrphans(): void {
    try {
      const output = execSync(
        `${DOCKER_BIN} ps --filter name=nanoclaw- --format '{{.Names}}'`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
      );
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) {
        try {
          execSync(this.stopCommand(name), { stdio: 'pipe' });
        } catch {
          /* already stopped */
        }
      }
      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned containers',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned containers');
    }
  }

  stopCommand(name: string): string {
    return `${DOCKER_BIN} stop ${name}`;
  }

  /** Returns CLI args for a readonly bind mount. */
  readonlyMountArgs(hostPath: string, containerPath: string): string[] {
    return ['-v', `${hostPath}:${containerPath}:ro`];
  }

  async start(
    name: string,
    mounts: VolumeMount[],
    env: Record<string, string>,
    config: RuntimeConfig,
  ): Promise<RuntimeInstance> {
    const args: string[] = ['run', '-i', '--rm', '--name', name];

    // Run as host user so bind-mounted files are accessible.
    // These internal env vars are set by buildRuntimeEnv() and consumed here.
    const hostUid = env._NANOCLAW_HOST_UID;
    const hostGid = env._NANOCLAW_HOST_GID;
    if (hostUid) {
      args.push('--user', `${hostUid}:${hostGid}`);
      env.HOME = '/home/node';
      delete env._NANOCLAW_HOST_UID;
      delete env._NANOCLAW_HOST_GID;
    }

    // Pass environment variables
    for (const [key, value] of Object.entries(env)) {
      args.push('-e', `${key}=${value}`);
    }

    // Mount volumes
    for (const mount of mounts) {
      if (mount.readonly) {
        args.push(
          ...this.readonlyMountArgs(mount.hostPath, mount.containerPath),
        );
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
    }

    // Image name
    args.push(config.image || 'nanoclaw-agent:latest');

    const proc = spawn(DOCKER_BIN, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new DockerInstance(name, proc);
  }
}
