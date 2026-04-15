import { execSync } from 'child_process';

import { logger } from './logger.js';

export type RuntimeKind = 'tmux-host';

export interface RuntimeDescriptor {
  kind: RuntimeKind;
  displayName: string;
  isolation: 'host-process';
  dependency: string;
  proxyBindHost: string;
  preferredTarget: 'micro-vm';
}

export interface RuntimeStatus {
  descriptor: RuntimeDescriptor;
  ready: boolean;
  activeSessions: string[];
}

export interface AgentRuntimeAdapter {
  readonly descriptor: RuntimeDescriptor;
  stopSession(name: string): string;
  hasSession(name: string): boolean;
  ensureReady(): void;
  cleanupOrphans(): void;
  listSessionNames(prefix?: string): string[];
  getStatus(): RuntimeStatus;
}

export const PROXY_BIND_HOST = process.env.CREDENTIAL_PROXY_HOST || '127.0.0.1';

class TmuxRuntimeAdapter implements AgentRuntimeAdapter {
  readonly descriptor: RuntimeDescriptor = {
    kind: 'tmux-host',
    displayName: 'tmux host sessions',
    isolation: 'host-process',
    dependency: 'tmux',
    proxyBindHost: PROXY_BIND_HOST,
    preferredTarget: 'micro-vm',
  };

  stopSession(name: string): string {
    return `tmux kill-session -t ${name}`;
  }

  hasSession(name: string): boolean {
    try {
      execSync(`tmux has-session -t ${name}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  ensureReady(): void {
    try {
      execSync('tmux -V', {
        stdio: 'pipe',
        timeout: 10000,
      });
      logger.debug('Tmux runtime available');
    } catch (err) {
      logger.error({ err }, 'Failed to find tmux');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: tmux is not installed or not in PATH                  ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without tmux. To fix:                      ║',
      );
      console.error(
        '║  1. Install tmux (apt install tmux / brew install tmux)       ║',
      );
      console.error(
        '║  2. Run: tmux -V                                              ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('tmux is required but not found', {
        cause: err,
      });
    }
  }

  cleanupOrphans(): void {
    try {
      const orphans = this.listSessionNames('nanoclaw-');
      for (const name of orphans) {
        try {
          execSync(this.stopSession(name), { stdio: 'pipe' });
        } catch {
          // already stopped
        }
      }

      if (orphans.length > 0) {
        logger.info(
          { count: orphans.length, names: orphans },
          'Stopped orphaned tmux sessions',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to clean up orphaned sessions');
    }
  }

  listSessionNames(prefix?: string): string[] {
    const output = execSync(
      `tmux list-sessions -F '#{session_name}' 2>/dev/null || true`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );

    return output
      .trim()
      .split('\n')
      .filter((name) => name.length > 0)
      .filter((name) => (prefix ? name.startsWith(prefix) : true));
  }

  getStatus(): RuntimeStatus {
    try {
      this.ensureReady();
      return {
        descriptor: this.descriptor,
        ready: true,
        activeSessions: this.listSessionNames('nanoclaw-'),
      };
    } catch {
      return {
        descriptor: this.descriptor,
        ready: false,
        activeSessions: [],
      };
    }
  }
}

const tmuxRuntimeAdapter = new TmuxRuntimeAdapter();

export function getAgentRuntime(): AgentRuntimeAdapter {
  return tmuxRuntimeAdapter;
}

export function getRuntimeStatus(): RuntimeStatus {
  return getAgentRuntime().getStatus();
}
