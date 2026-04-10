import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CodexRunResult {
  ok: boolean;
  text?: string;
  error?: string;
}

const CODEX_TIMEOUT_MS = 20 * 60 * 1000;

export async function runCodexExec(
  prompt: string,
  cwd: string,
): Promise<CodexRunResult> {
  const outputFile = path.join(
    os.tmpdir(),
    `nanoclaw-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
  );

  return new Promise((resolve) => {
    const args = [
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--cd',
      cwd,
      '--output-last-message',
      outputFile,
      prompt,
    ];

    const proc = spawn('codex', args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, CODEX_TIMEOUT_MS);

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        error: `Failed to start Codex: ${err.message}`,
      });
    });

    proc.on('close', (code) => {
      clearTimeout(timeout);

      let text = '';
      try {
        if (fs.existsSync(outputFile)) {
          text = fs.readFileSync(outputFile, 'utf8').trim();
          fs.unlinkSync(outputFile);
        }
      } catch {
        // Ignore cleanup/read failures and fall back to stderr.
      }

      if (timedOut) {
        resolve({
          ok: false,
          error: 'Codex timed out before completing the task.',
        });
        return;
      }

      if (code !== 0) {
        resolve({
          ok: false,
          error:
            stderr.trim() ||
            `Codex exited with code ${code === null ? 'unknown' : code}.`,
        });
        return;
      }

      resolve({
        ok: true,
        text: text || 'Codex completed, but returned no final message.',
      });
    });
  });
}
