/**
 * One-shot seed for post-migration bootstrap.
 *
 * Wires:
 *  - messaging_group: telegram -5256188832 "NanoClaw Cluster" (is_group=1)
 *  - agent_group: folder=telegram_main, name=ClusterManager
 *  - user: telegram:6541428999 "Emerjesse" (jsboige)
 *  - owner role (global scope)
 *  - wiring: engage_mode='pattern' engage_pattern='.' (match all — 2-person group)
 *
 * Safe to run while service is running (WAL mode). Doesn't touch cli.sock.
 *
 * Remove after initial bootstrap.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getUserRoles, grantRole } from '../src/modules/permissions/db/user-roles.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  const userId = 'telegram:6541428999';
  upsertUser({ id: userId, kind: 'telegram', display_name: 'Emerjesse', created_at: now });
  console.log(`user upserted: ${userId}`);

  const roles = getUserRoles(userId);
  if (!roles.some((r) => r.role === 'owner' && r.agent_group_id === null)) {
    grantRole({
      user_id: userId,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now,
    });
    console.log('owner role granted (global)');
  } else {
    console.log('owner role already present');
  }

  let ag = getAgentGroupByFolder('telegram_main');
  if (!ag) {
    createAgentGroup({
      id: genId('ag'),
      name: 'ClusterManager',
      folder: 'telegram_main',
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder('telegram_main')!;
    console.log(`agent_group created: ${ag.id}`);
  } else {
    console.log(`agent_group exists: ${ag.id}`);
  }

  const platformId = 'telegram:-5256188832';
  let mg = getMessagingGroupByPlatform('telegram', platformId);
  if (!mg) {
    createMessagingGroup({
      id: genId('mg'),
      channel_type: 'telegram',
      platform_id: platformId,
      name: 'NanoClaw Cluster',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('telegram', platformId)!;
    console.log(`messaging_group created: ${mg.id}`);
  } else {
    console.log(`messaging_group exists: ${mg.id}`);
  }

  const existingWiring = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existingWiring) {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`wiring created: ${mg.id} -> ${ag.id}`);
  } else {
    console.log(`wiring exists: ${existingWiring.id}`);
  }

  console.log('\nseed complete.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
