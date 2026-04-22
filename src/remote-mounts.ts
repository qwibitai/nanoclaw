import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DATA_DIR } from './config.js';

export interface RemoteMount {
  type: string;
  url: string;
  remotePath: string;
  mountPoint: string;
  rcloneRemote: string;
  createdAt: string;
}

export type MountRegistry = Record<string, RemoteMount>;

const DEFAULT_REGISTRY_PATH = join(DATA_DIR, 'remote-mounts.json');

export function loadRegistry(
  registryPath: string = DEFAULT_REGISTRY_PATH,
): MountRegistry {
  if (!existsSync(registryPath)) return {};
  try {
    return JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveRegistry(
  registry: MountRegistry,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n');
}

export function addMount(
  name: string,
  mount: RemoteMount,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  const registry = loadRegistry(registryPath);
  registry[name] = mount;
  saveRegistry(registry, registryPath);
}

export function removeMount(
  name: string,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): void {
  const registry = loadRegistry(registryPath);
  delete registry[name];
  saveRegistry(registry, registryPath);
}

export function getMount(
  name: string,
  registryPath: string = DEFAULT_REGISTRY_PATH,
): RemoteMount | undefined {
  return loadRegistry(registryPath)[name];
}

export function checkRemoteMounts(
  registryPath: string = DEFAULT_REGISTRY_PATH,
): Map<string, boolean> {
  const registry = loadRegistry(registryPath);
  const status = new Map<string, boolean>();

  for (const [name] of Object.entries(registry)) {
    try {
      const unitName = `nanoclaw-mount-${name}.service`;
      const result = execFileSync('systemctl', ['is-active', unitName], {
        encoding: 'utf-8',
      }).trim();
      status.set(name, result === 'active');
    } catch {
      status.set(name, false);
    }
  }
  return status;
}
