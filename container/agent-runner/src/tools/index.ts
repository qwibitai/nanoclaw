/**
 * Tool Registry for Sovereign
 * Static imports — one line to add a new plugin.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../tool-context.js';

import * as messaging from './messaging.js';
import * as scheduling from './scheduling.js';
import * as groups from './groups.js';
import * as memory from './memory.js';
import * as signalwire from './signalwire.js';
import * as payments from './payments.js';
import * as delegation from './delegation.js';
import * as elicitation from './elicitation.js';
import * as selfKnowledge from './self-knowledge.js';
import * as relay from './relay.js';
import * as skills from './skills.js';

const plugins = [
  messaging,
  scheduling,
  groups,
  memory,
  signalwire,
  payments,
  delegation,
  elicitation,
  selfKnowledge,
  relay,
  skills,
];

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  for (const plugin of plugins) {
    plugin.register(server, ctx);
  }
}
