/**
 * Browser-open helpers shared across channel setup flows.
 *
 * `openUrl` is best-effort — silent on failure, so headless/SSH/WSL
 * environments where `open`/`xdg-open` isn't wired up don't crash the
 * setup. The URL should always be visible in the clack note that calls
 * this so the user can copy-paste if the auto-open doesn't land.
 *
 * `confirmThenOpen` pauses for the operator before triggering the open —
 * the browser tends to steal focus when it pops, and a split-second
 * "wait what just happened" moment is worse than letting the user hit
 * Enter when they're ready.
 */
import { spawn } from 'child_process';

import * as p from '@clack/prompts';

import { ensureAnswer } from './runner.js';

/** Best-effort open of a URL in the user's default browser. Silent on failure. */
export function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Headless / no browser / unknown command — URL is printed in the
      // calling note so the user can copy-paste.
    });
    child.unref();
  } catch {
    // swallow — URL is visible in the note.
  }
}

/**
 * Gate a browser-open on a confirm so the user is ready for their browser
 * to take focus. Proceeds on cancel as well — the user can always copy the
 * URL from the note that precedes the prompt.
 */
export async function confirmThenOpen(
  url: string,
  message = 'Press Enter to open your browser',
): Promise<void> {
  ensureAnswer(
    await p.confirm({
      message,
      initialValue: true,
    }),
  );
  openUrl(url);
}
