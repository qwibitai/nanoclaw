/**
 * Agent-to-agent module — inter-agent messaging and on-demand agent creation.
 *
 * Registers one delivery action (`create_agent`). The sibling `channel_type === 'agent'`
 * routing path is NOT a system action — core `delivery.ts` dispatches into
 * `./agent-route.js` via a dynamic import when it sees `msg.channel_type === 'agent'`.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-destinations.js` on every wake (guarded by `hasTable('agent_destinations')`).
 *   - `src/delivery.ts::deliverMessage` dynamically imports `./agent-route.js`
 *     when `msg.channel_type === 'agent'`.
 *
 * Without this module: `agent_destinations` table absent ⇒ container-runner
 * skips destination projection, ACL check in delivery skips, `create_agent`
 * system action logs "Unknown system action", `channel_type='agent'` messages
 * throw because the module isn't installed.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleCreateAgent } from './create-agent.js';

registerDeliveryAction('create_agent', handleCreateAgent);
