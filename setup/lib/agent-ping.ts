/**
 * Round-trip check against the CLI Unix socket.
 *
 * Shared by `setup/verify.ts` (end-of-run health check) and `setup/auto.ts`
 * (confirm the freshly-wired agent actually responds before prompting the
 * user to chat with it).
 *
 * Exit-code contract follows `scripts/chat.ts`:
 *   0  → got a reply on stdout
 *   2  → socket unreachable (service not running or wrong checkout)
 *   3  → no reply before chat.ts's own 120s hard stop
 * This wrapper also guards with its own timeout in case chat.ts hangs.
 */
import { spawn } from 'child_process';
import fs from 'fs';

export type PingResult = 'ok' | 'no_reply' | 'socket_error' | 'auth_error';

/**
 * Wait for the host's CLI socket to appear on disk. Cheaper than `pingCliAgent`
 * (no subprocess), used by the service step to confirm the host actually
 * bound its socket before declaring success, and by the centralised restart
 * helper after kicking the service.
 *
 * Polls every 200ms until the socket exists or `timeoutMs` elapses.
 */
export async function waitForSocket(
  socketPath: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(socketPath);
}

export function classifyPingResult(exitCode: number | null, stdout: string, stderr = ''): PingResult {
  const output = `${stdout}\n${stderr}`;
  if (
    /Invalid bearer token/i.test(output) ||
    /authentication[_ ]error/i.test(output) ||
    /Failed to authenticate/i.test(output)
  ) {
    return 'auth_error';
  }
  if (exitCode === 2) return 'socket_error';
  if (exitCode === 0 && stdout.trim().length > 0) return 'ok';
  return 'no_reply';
}

export function pingCliAgent(timeoutMs = 30_000): Promise<PingResult> {
  return new Promise((resolve) => {
    const child = spawn('pnpm', ['run', 'chat', 'ping'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve('no_reply');
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(classifyPingResult(code, stdout, stderr));
    });
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve('socket_error');
    });
  });
}
