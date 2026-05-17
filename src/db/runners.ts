import type { Runner } from '../types.js';
import { getDb } from './connection.js';

export function createRunner(runner: Runner): void {
  getDb()
    .prepare(
      `INSERT INTO runners (id, name, runner_type, runner_token_hash, status, last_heartbeat, runner_version, protocol_version, created_at)
       VALUES (@id, @name, @runner_type, @runner_token_hash, @status, @last_heartbeat, @runner_version, @protocol_version, @created_at)`,
    )
    .run({
      ...runner,
      last_heartbeat: runner.last_heartbeat ?? null,
      runner_version: runner.runner_version ?? null,
      protocol_version: runner.protocol_version ?? null,
    });
}

export function getRunner(id: string): Runner | undefined {
  return getDb().prepare('SELECT * FROM runners WHERE id = ?').get(id) as Runner | undefined;
}

export function getRunnerByName(name: string): Runner | undefined {
  return getDb().prepare('SELECT * FROM runners WHERE name = ?').get(name) as Runner | undefined;
}

export function getAllRunners(): Runner[] {
  return getDb().prepare('SELECT * FROM runners ORDER BY name').all() as Runner[];
}

export function updateRunnerStatus(
  id: string,
  status: Runner['status'],
  runnerVersion?: string,
  protocolVersion?: string,
): void {
  getDb()
    .prepare(
      `UPDATE runners SET status = @status, last_heartbeat = @last_heartbeat,
       runner_version = COALESCE(@runner_version, runner_version),
       protocol_version = COALESCE(@protocol_version, protocol_version)
       WHERE id = @id`,
    )
    .run({
      id,
      status,
      last_heartbeat: new Date().toISOString(),
      runner_version: runnerVersion ?? null,
      protocol_version: protocolVersion ?? null,
    });
}

export function deleteRunner(id: string): void {
  getDb().prepare('DELETE FROM runners WHERE id = ?').run(id);
}
