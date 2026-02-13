import { execFile, execFileSync } from 'child_process';

import { logger } from './logger.js';

type NotifierId = 'macos' | 'linux' | 'none';

export interface HostNotifierProvider {
  id: NotifierId;
  displayName: string;
  notify(title: string, message: string): void;
}

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const macNotifier: HostNotifierProvider = {
  id: 'macos',
  displayName: 'macOS notifications',
  notify(title, message) {
    const escapedTitle = escapeAppleScriptString(title);
    const escapedMessage = escapeAppleScriptString(message);
    const script = `display notification "${escapedMessage}" with title "${escapedTitle}" sound name "Basso"`;
    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        logger.debug({ err }, 'Failed to send macOS notification');
      }
    });
  },
};

const linuxNotifier: HostNotifierProvider = {
  id: 'linux',
  displayName: 'Linux desktop notifications',
  notify(title, message) {
    execFile('notify-send', [title, message], (err) => {
      if (err) {
        logger.debug({ err }, 'Failed to send Linux notification');
      }
    });
  },
};

const noopNotifier: HostNotifierProvider = {
  id: 'none',
  displayName: 'No host notifications',
  notify(title, message) {
    logger.debug({ title, message }, 'Host notifications are disabled');
  },
};

function resolveNotifierId(): NotifierId {
  const configured = (process.env.HOST_NOTIFIER || '').trim().toLowerCase();
  if (configured === 'none' || configured === 'noop' || configured === 'off') {
    return 'none';
  }
  if (configured === 'macos' || configured === 'osascript') {
    return 'macos';
  }
  if (configured === 'linux' || configured === 'notify-send') {
    return 'linux';
  }
  if (configured && configured !== 'auto') {
    logger.warn(
      { configured },
      'Unknown HOST_NOTIFIER value, auto-detecting provider',
    );
  }

  if (process.platform === 'darwin' && commandExists('osascript')) {
    return 'macos';
  }
  if (commandExists('notify-send')) {
    return 'linux';
  }
  return 'none';
}

const notifierId = resolveNotifierId();
const notifier =
  notifierId === 'macos'
    ? macNotifier
    : notifierId === 'linux'
      ? linuxNotifier
      : noopNotifier;

logger.info(
  { notifier: notifier.id, displayName: notifier.displayName },
  'Host notifier selected',
);

export function getHostNotifierProvider(): HostNotifierProvider {
  return notifier;
}
