/**
 * Agent module — barrel exports for the agent subsystem.
 */

// Agent implementation
export { AgentImpl } from './agent-impl.js';

// AgentLite platform
export { createAgentLiteImpl } from './agentlite-impl.js';

// Config
export {
  normalizeJson,
  serializeMountAllowlist,
  resolveSerializableAgentSettings,
  buildAgentConfig,
} from './config.js';
export type {
  SerializableAgentSettings,
  PersistedAgentSettings,
  AgentConfig,
} from './config.js';

// Customization
export { syncAgentCustomizations } from './customization.js';
export type { SyncAgentCustomizationsInput } from './customization.js';

// Registry DB
export {
  AgentRegistryDb,
  getAgentRegistryDbPath,
  initAgentRegistryDb,
} from './registry-db.js';
export type { AgentRegistryRecord } from './registry-db.js';

// Context
export type { AgentContext } from './agent-context.js';

// Managers
export { ChannelManager } from './channel-manager.js';
export { GroupManager } from './group-manager.js';
export { TaskManager } from './task-manager.js';
export { MessageProcessor } from './message-processor.js';
