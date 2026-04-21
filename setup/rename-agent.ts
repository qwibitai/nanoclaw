/**
 * Step: rename-agent — Update the scratch CLI agent's operator + persona names.
 *
 * Invoked post-ping from `setup:auto`, after the user confirms or overrides
 * the names inferred from the host. Updates two rows: `users.display_name`
 * for the synthetic `cli:local` identity, and `agent_groups.name` for the
 * agent wired to the CLI channel. The folder path stays as-is — it's an
 * infrastructural identifier, not a presentation name.
 *
 * Args:
 *   --display-name <name>   (required) operator's display name
 *   --agent-name   <name>   (required) agent persona name
 *
 * Idempotent: calling with values that already match the DB is a no-op.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { getAgentGroup, updateAgentGroup } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { log } from '../src/log.js';
import { getUser, updateDisplayName } from '../src/modules/permissions/db/users.js';
import { emitStatus } from './status.js';

const CLI_USER_ID = 'cli:local';

function parseArgs(args: string[]): { displayName: string; agentName: string } {
  let displayName: string | undefined;
  let agentName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    const val = args[i + 1];
    if (key === '--display-name') {
      displayName = val;
      i++;
    } else if (key === '--agent-name') {
      agentName = val;
      i++;
    }
  }

  if (!displayName || !agentName) {
    emitStatus('RENAME_AGENT', {
      STATUS: 'failed',
      ERROR: 'missing_args',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  return { displayName, agentName };
}

export async function run(args: string[]): Promise<void> {
  const { displayName, agentName } = parseArgs(args);

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const user = getUser(CLI_USER_ID);
  if (!user) {
    emitStatus('RENAME_AGENT', {
      STATUS: 'failed',
      ERROR: 'cli_user_not_found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const mg = getMessagingGroupByPlatform('cli', 'local');
  if (!mg) {
    emitStatus('RENAME_AGENT', {
      STATUS: 'failed',
      ERROR: 'cli_messaging_group_not_found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const wirings = getMessagingGroupAgents(mg.id);
  const ag = wirings.length > 0 ? getAgentGroup(wirings[0].agent_group_id) : undefined;
  if (!ag) {
    emitStatus('RENAME_AGENT', {
      STATUS: 'failed',
      ERROR: 'cli_agent_group_not_found',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  const userChanged = user.display_name !== displayName;
  const agentChanged = ag.name !== agentName;

  if (userChanged) {
    updateDisplayName(CLI_USER_ID, displayName);
    log.info('Updated CLI user display_name', { from: user.display_name, to: displayName });
  }
  if (agentChanged) {
    updateAgentGroup(ag.id, { name: agentName });
    log.info('Updated CLI agent name', { from: ag.name, to: agentName });
  }

  emitStatus('RENAME_AGENT', {
    DISPLAY_NAME: displayName,
    AGENT_NAME: agentName,
    USER_CHANGED: userChanged,
    AGENT_CHANGED: agentChanged,
    STATUS: userChanged || agentChanged ? 'success' : 'skipped',
    LOG: 'logs/setup.log',
  });
}
