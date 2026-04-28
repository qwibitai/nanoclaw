/**
 * PR Factory module.
 *
 * Listens for GitHub webhook events (PR opened), creates a Discord thread,
 * spins up an isolated agent to triage/review the PR, and forwards test
 * plans to an orchestrator VM for execution.
 *
 * Also manages the supervisor agent group (if DISCORD_SUPERVISOR_BOT_TOKEN
 * is set) and registers additional Discord bot identities for supervisor
 * and tester roles.
 *
 * Env vars (read from .env):
 *   GITHUB_WEBHOOK_SECRET        — required to enable; module is inert without it
 *   GITHUB_WEBHOOK_PORT          — default 3800
 *   PR_FACTORY_CHANNEL_ID        — Discord channel to create PR threads in
 *   DISCORD_BOT_TOKEN            — for Discord REST API (thread creation)
 *   DISCORD_SUPERVISOR_BOT_TOKEN — optional: enables supervisor bot identity
 *   DISCORD_TESTER_BOT_TOKEN     — optional: enables tester bot identity
 *   PR_FACTORY_SUPERVISOR_CHANNEL_ID — Discord channel for the supervisor
 */
import { readEnvFile } from '../../env.js';
import { onShutdown } from '../../response-registry.js';
import { onDeliveryAdapterReady } from '../../delivery.js';
import { log } from '../../log.js';
import { startWebhookServer } from './webhook.js';
import { handlePullRequest } from './handler.js';
import { startOrchestratorPolling, stopOrchestratorPolling } from './orchestrator.js';
import { ensureSupervisorGroup } from './supervisor.js';

// Register additional Discord bot identities (supervisor + tester)
import './discord-bots.js';

const envConfig = readEnvFile([
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_WEBHOOK_PORT',
  'PR_FACTORY_CHANNEL_ID',
  'DISCORD_BOT_TOKEN',
  'DISCORD_SUPERVISOR_BOT_TOKEN',
  'PR_FACTORY_SUPERVISOR_CHANNEL_ID',
]);

const GITHUB_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET || envConfig.GITHUB_WEBHOOK_SECRET || '';
const GITHUB_WEBHOOK_PORT = parseInt(
  process.env.GITHUB_WEBHOOK_PORT || envConfig.GITHUB_WEBHOOK_PORT || '3800',
  10,
);
const PR_FACTORY_CHANNEL_ID = process.env.PR_FACTORY_CHANNEL_ID || envConfig.PR_FACTORY_CHANNEL_ID || '';
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || envConfig.DISCORD_BOT_TOKEN || '';
const SUPERVISOR_BOT_TOKEN = process.env.DISCORD_SUPERVISOR_BOT_TOKEN || envConfig.DISCORD_SUPERVISOR_BOT_TOKEN || '';
const SUPERVISOR_CHANNEL_ID = process.env.PR_FACTORY_SUPERVISOR_CHANNEL_ID || envConfig.PR_FACTORY_SUPERVISOR_CHANNEL_ID || '';

if (!GITHUB_WEBHOOK_SECRET) {
  log.debug('PR factory: GITHUB_WEBHOOK_SECRET not set, module disabled');
} else if (!PR_FACTORY_CHANNEL_ID) {
  log.warn('PR factory: GITHUB_WEBHOOK_SECRET set but PR_FACTORY_CHANNEL_ID missing');
} else if (!DISCORD_BOT_TOKEN) {
  log.warn('PR factory: GITHUB_WEBHOOK_SECRET set but DISCORD_BOT_TOKEN missing');
} else {
  // Start webhook server once delivery adapters are ready (Discord must be connected)
  onDeliveryAdapterReady(() => {
    const server = startWebhookServer(GITHUB_WEBHOOK_SECRET, GITHUB_WEBHOOK_PORT, (pr) =>
      handlePullRequest(pr, DISCORD_BOT_TOKEN, PR_FACTORY_CHANNEL_ID),
    );

    startOrchestratorPolling();

    // Set up supervisor group if configured
    if (SUPERVISOR_BOT_TOKEN && SUPERVISOR_CHANNEL_ID) {
      const supervisorPlatformId = `discord:1470188214710046894:${SUPERVISOR_CHANNEL_ID}`;
      ensureSupervisorGroup(supervisorPlatformId);
      log.info('PR factory supervisor enabled', { channel: SUPERVISOR_CHANNEL_ID });
    } else if (SUPERVISOR_BOT_TOKEN) {
      log.warn('PR factory: DISCORD_SUPERVISOR_BOT_TOKEN set but PR_FACTORY_SUPERVISOR_CHANNEL_ID missing');
    }

    onShutdown(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      stopOrchestratorPolling();
    });

    log.info('PR factory module started', { port: GITHUB_WEBHOOK_PORT, channel: PR_FACTORY_CHANNEL_ID });
  });
}

// Export session ops for use by MCP tools or other modules
export { clearWorkerSession, retriggerWorker } from './session-ops.js';
