import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Tests for the OneCLI compose hardening step. Verifies that the rewrite
 * pins the admin API (:10254) and Postgres (:5432) to 127.0.0.1, leaves the
 * gateway (:10255) alone, and is idempotent / fails safe on unknown layouts.
 *
 * Tests operate on a tempdir copy of the upstream compose shape — no docker
 * calls, no real OneCLI install.
 */

const UPSTREAM_COMPOSE = `services:
  postgres:
    image: postgres:16
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"
  onecli:
    image: onecli/onecli:latest
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}:10254"
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}:10255"
`;

describe('hardenOneCliBinds', () => {
  let tempDir: string;
  let composePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-harden-test-'));
    composePath = path.join(tempDir, 'docker-compose.yml');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pins admin API and Postgres to 127.0.0.1 and leaves the gateway alone', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);

    const result = hardenOneCliBinds(composePath);
    expect(result.changed).toBe(true);

    const patched = fs.readFileSync(composePath, 'utf-8');
    expect(patched).toContain('"127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(patched).toContain('"127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    // Gateway must keep the env-driven bind so containers can still reach it.
    expect(patched).toContain('"${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"');
    expect(patched).toMatch(/^# nanoclaw: admin\+postgres pinned to loopback/);
  });

  it('is a no-op when the marker is already present', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    hardenOneCliBinds(composePath);
    const firstPass = fs.readFileSync(composePath, 'utf-8');

    const result = hardenOneCliBinds(composePath);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('already_patched');
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(firstPass);
  });

  it('no-ops and warns when the compose layout is unrecognized', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    const mystery = `services:\n  onecli:\n    image: something-else\n    ports:\n      - "10254:10254"\n`;
    fs.writeFileSync(composePath, mystery);

    const result = hardenOneCliBinds(composePath);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('layout_unrecognized');
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(mystery);
  });

  it('no-ops when the compose file does not exist', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    const missing = path.join(tempDir, 'nope.yml');

    const result = hardenOneCliBinds(missing);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('compose_missing');
    expect(fs.existsSync(missing)).toBe(false);
  });
});
