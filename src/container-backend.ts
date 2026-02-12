import { execFileSync } from 'node:child_process';

export type ContainerBackend = 'apple' | 'docker';

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

interface AppleContainerInfo {
  status: string;
  configuration: {
    id: string;
  };
}

function parseBackend(value: string | undefined): ContainerBackend {
  const normalized = (value || '').trim().toLowerCase();
  if (normalized === 'docker') return 'docker';
  if (
    normalized === 'apple' ||
    normalized === 'apple-container' ||
    normalized === 'container'
  ) {
    return 'apple';
  }
  return 'apple';
}

export function getContainerBackend(): ContainerBackend {
  return parseBackend(process.env.CONTAINER_BACKEND);
}

export function getContainerCommand(backend = getContainerBackend()): string {
  return backend === 'docker' ? 'docker' : 'container';
}

export function buildContainerRunInvocation(
  mounts: VolumeMount[],
  containerName: string,
  image: string,
  backend = getContainerBackend(),
): { command: string; args: string[] } {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  for (const mount of mounts) {
    if (backend === 'apple') {
      if (mount.readonly) {
        args.push(
          '--mount',
          `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
        );
      } else {
        args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
      }
      continue;
    }

    const mode = mount.readonly ? 'ro' : 'rw';
    args.push('-v', `${mount.hostPath}:${mount.containerPath}:${mode}`);
  }

  args.push(image);
  return { command: getContainerCommand(backend), args };
}

export function ensureContainerBackendReady(
  backend = getContainerBackend(),
): void {
  if (backend === 'apple') {
    try {
      execFileSync('container', ['system', 'status'], { stdio: 'pipe' });
      return;
    } catch {
      execFileSync('container', ['system', 'start'], {
        stdio: 'pipe',
        timeout: 30000,
      });
      return;
    }
  }

  execFileSync('docker', ['info'], { stdio: 'pipe', timeout: 30000 });
}

export function listRunningNanoclawContainers(
  backend = getContainerBackend(),
): string[] {
  if (backend === 'apple') {
    const output = execFileSync('container', ['ls', '--format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers = JSON.parse(output || '[]') as AppleContainerInfo[];
    return containers
      .filter(
        (c) =>
          c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'),
      )
      .map((c) => c.configuration.id);
  }

  const output = execFileSync('docker', ['ps', '--format', '{{.Names}}'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return output
    .split('\n')
    .map((n) => n.trim())
    .filter((n) => n.startsWith('nanoclaw-'));
}

export function stopContainerByName(
  containerName: string,
  backend = getContainerBackend(),
): void {
  execFileSync(getContainerCommand(backend), ['stop', containerName], {
    stdio: 'pipe',
  });
}
