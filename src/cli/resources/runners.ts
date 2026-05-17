import { createHash, randomBytes, randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
import { sendTokenInvalidate } from '../../runner-registry.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'runner',
  plural: 'runners',
  table: 'runners',
  description: 'Remote runner — a machine that executes agent groups outside the central host.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'name', type: 'string', description: 'Unique human-readable label.', required: true },
    {
      name: 'runner_type',
      type: 'string',
      description: '"persistent" stays connected. "ephemeral" reconnects per-turn.',
      enum: ['persistent', 'ephemeral'],
      default: 'persistent',
    },
    {
      name: 'status',
      type: 'string',
      description: 'Connection state.',
      enum: ['connected', 'disconnected', 'unresponsive'],
      generated: true,
    },
    {
      name: 'bootstrap_expires_at',
      type: 'string',
      description: 'When the bootstrap token expires (ISO).',
      generated: true,
    },
    {
      name: 'bootstrap_used_at',
      type: 'string',
      description: 'When the bootstrap token was consumed (ISO).',
      generated: true,
    },
    {
      name: 'credential_rotated_at',
      type: 'string',
      description: 'Timestamp of last credential rotation (ISO).',
      generated: true,
    },
    { name: 'last_heartbeat', type: 'string', description: 'ISO timestamp of last heartbeat.', generated: true },
    { name: 'runner_version', type: 'string', description: 'Runner binary version string.', generated: true },
    { name: 'protocol_version', type: 'string', description: 'Protocol version in use.', generated: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: {
    list: 'open',
    get: 'open',
    delete: 'approval',
  },
  customOperations: {
    add: {
      access: 'approval',
      description:
        'Create a new runner and issue a one-time bootstrap token (valid 10 minutes, single-use). ' +
        'The runner exchanges it for a long-lived credential on first connect.',
      args: [
        { name: 'name', type: 'string', description: 'Unique name for this runner.', required: true },
        {
          name: 'runner_type',
          type: 'string',
          description: '"persistent" (default) or "ephemeral".',
          enum: ['persistent', 'ephemeral'],
        },
      ],
      async handler(args) {
        const name = args.name as string;
        if (!name) throw new Error('--name is required');
        const runnerType = (args.runner_type as string) || 'persistent';

        const id = randomUUID();
        const bootstrap = randomBytes(32).toString('hex');
        const bootstrapHash = createHash('sha256').update(bootstrap).digest('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
        const now = new Date().toISOString();

        getDb()
          .prepare(
            `INSERT INTO runners (id, name, runner_type, bootstrap_token_hash, bootstrap_expires_at, status, created_at)
             VALUES (?, ?, ?, ?, ?, 'disconnected', ?)`,
          )
          .run(id, name, runnerType, bootstrapHash, expiresAt, now);

        return {
          id,
          name,
          runner_type: runnerType,
          bootstrap_token: bootstrap,
          expires_in: '10 minutes (single-use)',
          install_snippet: `NANOCLAW_RUNNER_BOOTSTRAP=${bootstrap} ./nanoclaw-runner`,
          note: 'Bootstrap token shown once. Runner exchanges it for a long-lived credential on first connect.',
        };
      },
    },
    revoke: {
      access: 'approval',
      description:
        'Revoke the active credential for a runner. Any live connection receives TOKEN_INVALIDATE ' +
        'and disconnects. Runner must be re-provisioned with a new bootstrap token.',
      args: [{ name: 'name', type: 'string', description: 'Runner name.', required: true }],
      async handler(args) {
        const name = args.name as string;
        if (!name) throw new Error('--name is required');

        const runner = getDb().prepare('SELECT id, name FROM runners WHERE name = ?').get(name) as
          | { id: string; name: string }
          | undefined;
        if (!runner) throw new Error(`Runner not found: ${name}`);

        getDb()
          .prepare(
            `UPDATE runners
             SET credential_hash = NULL, credential_rotated_at = NULL,
                 bootstrap_token_hash = NULL, bootstrap_expires_at = NULL, bootstrap_used_at = NULL
             WHERE id = ?`,
          )
          .run(runner.id);

        sendTokenInvalidate(runner.id, 'revoked');

        return {
          id: runner.id,
          name: runner.name,
          status: 'revoked',
          note: 'Credential cleared. Run ncl runners add --name <name> to issue a new bootstrap token.',
        };
      },
    },
  },
});
