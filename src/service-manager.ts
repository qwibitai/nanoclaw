import { execFileSync } from 'child_process';

import { logger } from './logger.js';

export type ServiceState = 'running' | 'stopped' | 'unknown';
type ServiceManagerId = 'launchd' | 'systemd' | 'none';

export interface ServiceManagerProvider {
  id: ServiceManagerId;
  displayName: string;
  defaultServiceName: string;
  status(serviceName?: string): ServiceState;
  start(serviceName?: string): void;
  stop(serviceName?: string): void;
  restart(serviceName?: string): void;
}

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function getLaunchdDomain(): string {
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new Error('Cannot determine user id for launchd domain');
  }
  return `gui/${uid}`;
}

const launchdProvider: ServiceManagerProvider = {
  id: 'launchd',
  displayName: 'launchd',
  defaultServiceName: 'com.nanoclaw',
  status(serviceName) {
    const label = serviceName || this.defaultServiceName;
    try {
      execFileSync('launchctl', ['list', label], { stdio: 'pipe' });
      return 'running';
    } catch {
      return 'stopped';
    }
  },
  start(serviceName) {
    const label = serviceName || this.defaultServiceName;
    const domain = getLaunchdDomain();
    execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], {
      stdio: 'pipe',
    });
  },
  stop(serviceName) {
    const label = serviceName || this.defaultServiceName;
    const domain = getLaunchdDomain();
    execFileSync('launchctl', ['bootout', `${domain}/${label}`], {
      stdio: 'pipe',
    });
  },
  restart(serviceName) {
    const label = serviceName || this.defaultServiceName;
    const domain = getLaunchdDomain();
    execFileSync('launchctl', ['kickstart', '-k', `${domain}/${label}`], {
      stdio: 'pipe',
    });
  },
};

function toSystemdServiceName(serviceName?: string): string {
  const name = serviceName || 'nanoclaw';
  return name.endsWith('.service') ? name : `${name}.service`;
}

const systemdProvider: ServiceManagerProvider = {
  id: 'systemd',
  displayName: 'systemd (user)',
  defaultServiceName: 'nanoclaw',
  status(serviceName) {
    const unit = toSystemdServiceName(serviceName || this.defaultServiceName);
    try {
      const output = execFileSync(
        'systemctl',
        ['--user', 'is-active', unit],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf-8',
        },
      )
        .trim()
        .toLowerCase();
      return output === 'active' ? 'running' : 'stopped';
    } catch {
      return 'stopped';
    }
  },
  start(serviceName) {
    const unit = toSystemdServiceName(serviceName || this.defaultServiceName);
    execFileSync('systemctl', ['--user', 'start', unit], { stdio: 'pipe' });
  },
  stop(serviceName) {
    const unit = toSystemdServiceName(serviceName || this.defaultServiceName);
    execFileSync('systemctl', ['--user', 'stop', unit], { stdio: 'pipe' });
  },
  restart(serviceName) {
    const unit = toSystemdServiceName(serviceName || this.defaultServiceName);
    execFileSync('systemctl', ['--user', 'restart', unit], { stdio: 'pipe' });
  },
};

const noServiceManagerProvider: ServiceManagerProvider = {
  id: 'none',
  displayName: 'No service manager',
  defaultServiceName: 'nanoclaw',
  status() {
    return 'unknown';
  },
  start() {
    throw new Error('No service manager available on this host');
  },
  stop() {
    throw new Error('No service manager available on this host');
  },
  restart() {
    throw new Error('No service manager available on this host');
  },
};

function resolveServiceManagerId(): ServiceManagerId {
  const configured = (process.env.SERVICE_MANAGER || '').trim().toLowerCase();
  if (configured === 'launchd') return 'launchd';
  if (configured === 'systemd') return 'systemd';
  if (configured === 'none' || configured === 'off' || configured === 'noop') {
    return 'none';
  }
  if (configured && configured !== 'auto') {
    logger.warn(
      { configured },
      'Unknown SERVICE_MANAGER value, auto-detecting provider',
    );
  }

  if (process.platform === 'darwin' && commandExists('launchctl')) {
    return 'launchd';
  }
  if (process.platform === 'linux' && commandExists('systemctl')) {
    return 'systemd';
  }
  return 'none';
}

const serviceManagerId = resolveServiceManagerId();
const serviceManager =
  serviceManagerId === 'launchd'
    ? launchdProvider
    : serviceManagerId === 'systemd'
      ? systemdProvider
      : noServiceManagerProvider;

logger.info(
  { serviceManager: serviceManager.id, displayName: serviceManager.displayName },
  'Service manager selected',
);

export function getServiceManagerProvider(): ServiceManagerProvider {
  return serviceManager;
}
