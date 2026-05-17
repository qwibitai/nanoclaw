/**
 * Minimal NanoClaw central stub for runner integration testing.
 *
 * Creates an in-process SQLite DB, seeds a test runner row, starts the
 * runner registry, then polls until both milestones are hit:
 *   1. RUNNER_REGISTER → RUNNER_ACK handshake (runner.status = 'connected')
 *   2. HEARTBEAT → HEARTBEAT_ACK (runner.last_heartbeat set)
 *
 * Exits 0 on success, 1 on timeout.
 *
 * Run from the nanoclaw root:
 *   RUNNER_WS_PORT=3031 pnpm exec tsx runner/test/central-stub.ts
 *
 * Prints two lines on stdout before the server starts:
 *   RUNNER_TOKEN=<hex>
 *   RUNNER_NAME=<name>
 * smoke.sh parses these to pass to the runner binary.
 */
import { createHash, randomBytes } from 'crypto';
import os from 'os';
import path from 'path';

import { initDb } from '../../src/db/connection.js';
import { log } from '../../src/log.js';
import { startRunnerRegistry, stopRunnerRegistry } from '../../src/runner-registry.js';

// ── Temp DB ───────────────────────────────────────────────────────────────────

const dbPath = path.join(os.tmpdir(), `nanoclaw-runner-test-${process.pid}.db`);
const db = initDb(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS runners (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
    runner_type TEXT NOT NULL DEFAULT 'persistent',
    runner_token_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'disconnected',
    last_heartbeat TEXT, runner_version TEXT, protocol_version TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS agent_groups (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
    agent_provider TEXT, runner_id TEXT REFERENCES runners(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS container_configs (
    agent_group_id TEXT PRIMARY KEY,
    provider TEXT, model TEXT, effort TEXT, image_tag TEXT,
    assistant_name TEXT, max_messages_per_prompt INTEGER,
    skills TEXT NOT NULL DEFAULT '"all"',
    mcp_servers TEXT NOT NULL DEFAULT '{}',
    packages_apt TEXT NOT NULL DEFAULT '[]',
    packages_npm TEXT NOT NULL DEFAULT '[]',
    additional_mounts TEXT NOT NULL DEFAULT '[]',
    cli_scope TEXT NOT NULL DEFAULT 'group',
    updated_at TEXT NOT NULL
  );
`);

// ── Seed test runner ──────────────────────────────────────────────────────────

const RUNNER_NAME = 'integration-test-runner';
const TOKEN = randomBytes(16).toString('hex');
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');

db.prepare(
  `INSERT INTO runners (id, name, runner_type, runner_token_hash, status, created_at)
   VALUES ('runner-integration-test', ?, 'persistent', ?, 'disconnected', ?)`,
).run(RUNNER_NAME, TOKEN_HASH, new Date().toISOString());

// Emit credentials on stdout for smoke.sh to parse.
process.stdout.write(`RUNNER_TOKEN=${TOKEN}\n`);
process.stdout.write(`RUNNER_NAME=${RUNNER_NAME}\n`);

// ── Start registry ────────────────────────────────────────────────────────────

startRunnerRegistry();
log.info('Central stub started', { port: process.env.RUNNER_WS_PORT ?? '3031' });

// ── Poll for round-trip completion ────────────────────────────────────────────

const TIMEOUT_MS = parseInt(process.env.INTEGRATION_TIMEOUT_SEC ?? '30', 10) * 1000;
const startTime = Date.now();
let registered = false;
// Captures last_heartbeat as set during RUNNER_REGISTER (upsertRunnerStatus also
// writes last_heartbeat on registration). We wait for a value strictly newer than
// this to confirm a real HEARTBEAT frame was received and ACKed.
let registrationHeartbeat: string | null = null;

const poll = setInterval(() => {
  const runner = db
    .prepare('SELECT status, last_heartbeat FROM runners WHERE id = ?')
    .get('runner-integration-test') as { status: string; last_heartbeat: string | null } | undefined;

  if (!runner) return;

  if (runner.status === 'connected' && !registered) {
    registered = true;
    registrationHeartbeat = runner.last_heartbeat;
    log.info('PASS step 1: RUNNER_REGISTER → RUNNER_ACK handshake verified');
  }

  // A real HEARTBEAT: last_heartbeat updated to a value strictly newer than what
  // was set during registration.
  if (
    registered &&
    runner.last_heartbeat !== null &&
    runner.last_heartbeat !== registrationHeartbeat
  ) {
    clearInterval(poll);
    log.info('PASS step 2: HEARTBEAT → HEARTBEAT_ACK exchange verified');
    log.info('Integration round-trip PASSED');
    void stopRunnerRegistry().then(() => {
      db.close();
      process.exit(0);
    });
    return;
  }

  if (Date.now() - startTime > TIMEOUT_MS) {
    clearInterval(poll);
    log.error('Integration test TIMED OUT', {
      registered,
      status: runner.status,
      lastHeartbeat: runner.last_heartbeat,
      registrationHeartbeat,
    });
    void stopRunnerRegistry().then(() => {
      db.close();
      process.exit(1);
    });
  }
}, 500);
