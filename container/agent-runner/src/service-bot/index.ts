// Service Bot tools — barrel export.
export { registerServiceBotTools } from './register.js';
export { transcribeAudio } from './audio.js';
export { botStatus, readLogs, readFile, listIssues } from './observe.js';
export { searchLogs, inspectConfig } from './diagnose.js';
export { editFile, dockerCommand, createIssue, runCommand } from './act.js';
export { sshExec, shellEscape } from './ssh.js';
export { createGitHubClient } from './github.js';
export { getBotConfig, initRegistry, refreshConfigs } from './config.js';
export type { BotConfig } from './config.js';
export { chubSearch, chubGet, chubExec } from './chub.js';
export { readOwnConversations } from './self.js';
// Notice tools moved to bot-dashboard-mcp standalone server.
