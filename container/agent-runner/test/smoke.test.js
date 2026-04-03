import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const runnerEntryPoint = path.join(packageRoot, 'dist', 'index.js');

function runRunner(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runnerEntryPoint], {
      cwd: packageRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(input));
  });
}

function readOutput(stdout) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const start = lines.indexOf('---NANOCLAW_OUTPUT_START---');
  const end = lines.indexOf('---NANOCLAW_OUTPUT_END---');

  assert.notStrictEqual(start, -1, 'expected output start marker');
  assert.notStrictEqual(end, -1, 'expected output end marker');
  assert.ok(end > start + 1, 'expected JSON payload between output markers');

  return JSON.parse(lines[start + 1]);
}

test('agent runner exits cleanly when a scheduled task script suppresses wake-up', async () => {
  // Arrange
  const ipcDir = mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-agent-runner-'));
  const originalIpcDir = process.env.NANOCLAW_IPC_DIR;
  process.env.NANOCLAW_IPC_DIR = ipcDir;
  const input = {
    prompt: 'Check whether anything needs to be sent.',
    groupFolder: 'smoke-group',
    chatJid: 'smoke@g.us',
    isMain: false,
    isScheduledTask: true,
    script: 'printf \'{"wakeAgent":false}\\n\'',
  };

  try {
    // Act
    const result = await runRunner(input);
    const output = readOutput(result.stdout);

    // Assert
    assert.equal(existsSync(runnerEntryPoint), true);
    assert.equal(result.code, 0);
    assert.deepEqual(output, {
      status: 'success',
      result: null,
    });
    assert.match(result.stderr, /Script decided not to wake agent/);
  } finally {
    if (originalIpcDir === undefined) {
      delete process.env.NANOCLAW_IPC_DIR;
    } else {
      process.env.NANOCLAW_IPC_DIR = originalIpcDir;
    }
    rmSync(ipcDir, { recursive: true, force: true });
  }
});
