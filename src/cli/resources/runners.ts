import { createHash, randomBytes, randomUUID } from 'crypto';

import { getDb } from '../../db/connection.js';
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
      name: 'runner_token_hash',
      type: 'string',
      description: 'SHA-256 of the bearer token. Never shown after creation.',
      generated: true,
    },
    {
      name: 'status',
      type: 'string',
      description: 'Connection state.',
      enum: ['connected', 'disconnected', 'unresponsive'],
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
      description: 'Create a new runner and generate its bearer token. Token is shown once.',
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
        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const now = new Date().toISOString();

        getDb()
          .prepare(
            `INSERT INTO runners (id, name, runner_type, runner_token_hash, status, created_at)
             VALUES (?, ?, ?, ?, 'disconnected', ?)`,
          )
          .run(id, name, runnerType, tokenHash, now);

        return { id, name, runner_type: runnerType, token, note: 'Token shown once — store it securely.' };
      },
    },
    rotate: {
      access: 'approval',
      description:
        'Rotate the bearer token for a runner. New token is shown once; old token is invalidated immediately.',
      args: [{ name: 'id', type: 'string', description: 'Runner ID.', required: true }],
      async handler(args) {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');

        const runner = getDb().prepare('SELECT id, name FROM runners WHERE id = ?').get(id) as
          | { id: string; name: string }
          | undefined;
        if (!runner) throw new Error(`Runner not found: ${id}`);

        const token = randomBytes(32).toString('hex');
        const tokenHash = createHash('sha256').update(token).digest('hex');
        getDb().prepare('UPDATE runners SET runner_token_hash = ? WHERE id = ?').run(tokenHash, id);

        return { id: runner.id, name: runner.name, token, note: 'Token rotated — old token is now invalid.' };
      },
    },
  },
});
