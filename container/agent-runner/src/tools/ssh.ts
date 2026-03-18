// SSH execution layer — abstracts SSH command execution for testability.

import { execFile } from 'node:child_process';
import { SSH_CONNECT_TIMEOUT, SSH_COMMAND_TIMEOUT } from './config.js';

export interface SshResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SshOptions {
  connectTimeout?: number;
  commandTimeout?: number;
}

export type SshExecutor = (
  target: string,
  command: string,
  options?: SshOptions,
) => Promise<SshResult>;

// SSH config path — set by the container environment.
// Inside NanoClaw container: /workspace/extra/service-ssh/config
// On host directly: ~/.config/nanoclaw/service-ssh/config
// Unset: use system defaults (for backward compat / tests)
const SSH_CONFIG_PATH = process.env.SERVICE_BOT_SSH_CONFIG || '';

/**
 * Execute a command on a remote host via SSH.
 * This is the real implementation — tests should mock this.
 */
export const sshExec: SshExecutor = (
  target: string,
  command: string,
  options?: SshOptions,
): Promise<SshResult> => {
  const connectTimeout = options?.connectTimeout ?? SSH_CONNECT_TIMEOUT;
  const commandTimeout = options?.commandTimeout ?? SSH_COMMAND_TIMEOUT;

  return new Promise((resolve, reject) => {
    const args: string[] = [];

    // Use dedicated SSH config if available (Service Bot mode)
    if (SSH_CONFIG_PATH) {
      args.push('-F', SSH_CONFIG_PATH);
    }

    args.push(
      '-o', `ConnectTimeout=${connectTimeout}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      target,
      command,
    );

    const proc = execFile('ssh', args, {
      timeout: commandTimeout * 1000,
      maxBuffer: 1024 * 1024, // 1MB
    }, (error, stdout, stderr) => {
      if (error && 'killed' in error && error.killed) {
        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: `Command timed out after ${commandTimeout}s. Partial output may be available.`,
          exitCode: 124,
        });
        return;
      }

      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? ((error as any).code as number | undefined) ?? 1 : 0,
      });
    });
  });
};

/**
 * Shell-escape a string to prevent injection when passed to SSH commands.
 */
export function shellEscape(str: string): string {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}
