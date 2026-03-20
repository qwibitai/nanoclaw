#!/usr/bin/env node
/**
 * host-browser — IPC proxy for agent-browser
 *
 * Drop-in replacement for `agent-browser` that relays commands to the host
 * via IPC task files. The host runs `agent-browser --headed <args>` and
 * writes the result back. This lets container agents use a foreground
 * browser window on the host machine.
 *
 * Usage: host-browser open https://example.com
 *        host-browser snapshot -i
 *        host-browser click @e1
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const IPC_DIR = '/workspace/ipc';
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const RESULTS_DIR = path.join(IPC_DIR, 'browser_results');
const POLL_INTERVAL = 500;
const MAX_WAIT = 120_000;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: host-browser <command> [args...]');
  process.exit(1);
}

const requestId = `browser-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

// Write task file (atomic via rename)
fs.mkdirSync(TASKS_DIR, { recursive: true });
fs.mkdirSync(RESULTS_DIR, { recursive: true });

const task = {
  type: 'browser_command',
  requestId,
  args,
  timestamp: new Date().toISOString(),
};

const tmpPath = path.join(TASKS_DIR, `${requestId}.json.tmp`);
const taskPath = path.join(TASKS_DIR, `${requestId}.json`);
fs.writeFileSync(tmpPath, JSON.stringify(task));
fs.renameSync(tmpPath, taskPath);

// Poll for result
const resultPath = path.join(RESULTS_DIR, `${requestId}.json`);
let elapsed = 0;

const poll = setInterval(() => {
  elapsed += POLL_INTERVAL;

  if (fs.existsSync(resultPath)) {
    clearInterval(poll);
    try {
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf-8'));
      fs.unlinkSync(resultPath);

      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exit(result.exitCode ?? 0);
    } catch (err) {
      console.error(`Failed to read result: ${err}`);
      process.exit(1);
    }
  }

  if (elapsed >= MAX_WAIT) {
    clearInterval(poll);
    console.error('host-browser: timed out waiting for host response');
    process.exit(1);
  }
}, POLL_INTERVAL);
