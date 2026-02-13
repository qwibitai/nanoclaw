import {
  ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from 'child_process';

import { logger } from './logger.js';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

type RuntimeId = 'apple' | 'docker';

export interface ContainerRuntimeProvider {
  id: RuntimeId;
  command: string;
  displayName: string;
  buildRunArgs(
    mounts: VolumeMount[],
    containerName: string,
    image: string,
  ): string[];
  spawnContainer(args: string[]): ChildProcess;
  stopContainer(
    containerName: string,
    timeoutMs: number,
    cb: (err: Error | null) => void,
  ): void;
  stopContainerSync(containerName: string): void;
  ensureSystemRunning(): void;
  listRunningContainers(prefix: string): string[];
  startupHelpLines(): string[];
}

const appleContainerProvider: ContainerRuntimeProvider = {
  id: 'apple',
  command: 'container',
  displayName: 'Apple Container',
  buildRunArgs(mounts, containerName, image) {
    const args: string[] = ['run', '-i', '--rm', '--name', containerName];

    // Apple Container: --mount for readonly, -v for read-write
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

    args.push(image);
    return args;
  },
  spawnContainer(args) {
    return spawn('container', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  },
  stopContainer(containerName, timeoutMs, cb) {
    execFile(
      'container',
      ['stop', containerName],
      { timeout: timeoutMs },
      (err) => cb(err as Error | null),
    );
  },
  stopContainerSync(containerName) {
    execFileSync('container', ['stop', containerName], { stdio: 'pipe' });
  },
  ensureSystemRunning() {
    try {
      execFileSync('container', ['system', 'status'], { stdio: 'pipe' });
      return;
    } catch {
      execFileSync('container', ['system', 'start'], {
        stdio: 'pipe',
        timeout: 30000,
      });
    }
  },
  listRunningContainers(prefix) {
    const output = execFileSync('container', ['ls', '--format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    const parsed = JSON.parse(output || '[]') as Array<{
      status?: string;
      configuration?: { id?: string };
    }>;

    return parsed
      .filter(
        (c) =>
          c.status === 'running' &&
          !!c.configuration?.id &&
          c.configuration.id.startsWith(prefix),
      )
      .map((c) => c.configuration!.id!);
  },
  startupHelpLines() {
    return [
      '1. Install: https://github.com/apple/container/releases',
      '2. Run: container system start',
      '3. Restart NanoClaw',
    ];
  },
};

const dockerProvider: ContainerRuntimeProvider = {
  id: 'docker',
  command: 'docker',
  displayName: 'Docker',
  buildRunArgs(mounts, containerName, image) {
    const args: string[] = ['run', '-i', '--rm', '--name', containerName];

    for (const mount of mounts) {
      const spec = mount.readonly
        ? `${mount.hostPath}:${mount.containerPath}:ro`
        : `${mount.hostPath}:${mount.containerPath}`;
      args.push('-v', spec);
    }

    args.push(image);
    return args;
  },
  spawnContainer(args) {
    return spawn('docker', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  },
  stopContainer(containerName, timeoutMs, cb) {
    execFile(
      'docker',
      ['stop', containerName],
      { timeout: timeoutMs },
      (err) => cb(err as Error | null),
    );
  },
  stopContainerSync(containerName) {
    execFileSync('docker', ['stop', containerName], { stdio: 'pipe' });
  },
  ensureSystemRunning() {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
  },
  listRunningContainers(prefix) {
    const output = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });

    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name.startsWith(prefix));
  },
  startupHelpLines() {
    return [
      '1. Install Docker Desktop/Engine',
      '2. Start Docker so `docker info` works',
      '3. Restart NanoClaw',
    ];
  },
};

function isCommandAvailable(command: string): boolean {
  try {
    execFileSync(command, ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeId(): RuntimeId {
  const configured = (process.env.CONTAINER_RUNTIME || '')
    .trim()
    .toLowerCase();

  if (configured === 'apple' || configured === 'container') return 'apple';
  if (configured === 'docker') return 'docker';

  if (configured) {
    logger.warn(
      { configured },
      'Unknown CONTAINER_RUNTIME value, auto-detecting runtime',
    );
  }

  // Backward-compatible preference: Apple Container first, then Docker
  if (isCommandAvailable('container')) return 'apple';
  if (isCommandAvailable('docker')) return 'docker';
  return 'apple';
}

const provider =
  resolveRuntimeId() === 'docker' ? dockerProvider : appleContainerProvider;

logger.info(
  { runtime: provider.id, command: provider.command },
  'Container runtime selected',
);

export function getContainerRuntimeProvider(): ContainerRuntimeProvider {
  return provider;
}
