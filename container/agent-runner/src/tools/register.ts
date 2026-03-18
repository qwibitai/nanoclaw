// MCP tool registration — adds all Service Bot tools to a NanoClaw MCP server.
// This file is designed to be imported into NanoClaw's ipc-mcp-stdio.ts on XPS.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sshExec } from './ssh.js';
import { createGitHubClient } from './github.js';
import { botStatus, readLogs, readFile, listIssues } from './observe.js';
import { searchLogs, inspectConfig } from './diagnose.js';
import { editFile, dockerCommand, createIssue, runCommand } from './act.js';
import {
  watcherCheck,
  readHealthState,
  writeHealthState,
  readRoutingConfig,
  readDependencies,
  setMaintenanceMode,
  clearMaintenanceMode,
  getMaintenanceStatus,
  computeFleetStatus,
  getBotRecords,
  getFleetState,
  isBotHealthRecord,
} from './watcher.js';
import {
  readPolicies,
  evaluatePolicy,
  appendActionLog,
  type ActionLogEntry,
  type ResponseLevel,
  type RoutingMetadata,
} from './policy.js';
import {
  readTrendConfig,
  readTrendHistory,
  writeTrendSnapshot,
  collectTrendSnapshot,
  runTrendAnalysis,
  type DigestBotData,
} from './trend.js';

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] };
}

/**
 * Register all Service Bot tools on the given MCP server.
 * Call this from ipc-mcp-stdio.ts after creating the McpServer.
 */
export function registerServiceBotTools(
  server: McpServer,
  githubToken?: string,
) {
  const github = githubToken ? createGitHubClient(githubToken) : null;

  // ─── Observe ─────────────────────────────────────────────

  server.tool(
    'bot_status',
    'Get the running status of a managed bot (DB or Nook). Returns container state, uptime, and health info.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      format: z.enum(['human', 'json']).optional().describe('Output format: "human" (default) or "json" (structured for watcher)'),
    },
    async ({ bot, format }) => text(await botStatus(bot, sshExec, { format })),
  );

  server.tool(
    'read_logs',
    'Read recent log lines from a bot container or bridge service.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      lines: z.number().optional().describe('Number of log lines (default 50, max 500)'),
      service: z.enum(['main', 'bridge']).optional().describe('"main" for Docker container, "bridge" for Nook LettaBot service'),
    },
    async ({ bot, lines, service }) =>
      text(await readLogs(bot, sshExec, { lines, service })),
  );

  server.tool(
    'read_file',
    'Read a file from a managed bot host. Uses sudo for root-owned files on DB.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      path: z.string().describe('Absolute file path on the target host'),
    },
    async ({ bot, path }) => text(await readFile(bot, path, sshExec)),
  );

  server.tool(
    'list_issues',
    'List GitHub Issues for a managed bot repository.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      labels: z.string().optional().describe('Comma-separated label filter'),
      state: z.enum(['open', 'closed', 'all']).optional().describe('Issue state (default: open)'),
    },
    async ({ bot, labels, state }) => {
      if (!github) return text('Error: GITHUB_TOKEN not configured.');
      return text(await listIssues(bot, github, { labels, state }));
    },
  );

  // ─── Diagnose ────────────────────────────────────────────

  server.tool(
    'search_logs',
    'Search bot logs for a specific pattern using grep.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      pattern: z.string().describe('Grep pattern (basic regex)'),
      lines: z.number().optional().describe('Log lines to search through (default 200, max 5000)'),
      context: z.number().optional().describe('Context lines around matches (default 2)'),
    },
    async ({ bot, pattern, lines, context }) =>
      text(await searchLogs(bot, pattern, sshExec, { lines, context })),
  );

  server.tool(
    'inspect_config',
    'Read and display the primary configuration for a managed bot.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
    },
    async ({ bot }) => text(await inspectConfig(bot, sshExec)),
  );

  // ─── Act ─────────────────────────────────────────────────

  server.tool(
    'edit_file',
    'Write content to a file on a bot host, creating a backup first. Verifies the write succeeded.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      path: z.string().describe('Absolute file path on the target host'),
      content: z.string().describe('New file content'),
    },
    async ({ bot, path, content }) =>
      text(await editFile(bot, path, content, sshExec)),
  );

  server.tool(
    'docker_command',
    'Execute a scoped Docker command on a managed bot container. Only restart/stop/start/exec are allowed.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      action: z.string().describe('Docker action: "restart", "stop", "start", or "exec"'),
      exec_command: z.string().optional().describe('Command to run inside container (required for exec)'),
    },
    async ({ bot, action, exec_command }) =>
      text(await dockerCommand(bot, action, sshExec, { execCommand: exec_command })),
  );

  server.tool(
    'create_issue',
    'Create a GitHub Issue on a managed bot repository. Auto-adds "bot-reported" label.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      title: z.string().describe('Issue title'),
      body: z.string().describe('Issue body (Markdown)'),
      labels: z.string().optional().describe('Comma-separated labels'),
    },
    async ({ bot, title, body, labels }) => {
      if (!github) return text('Error: GITHUB_TOKEN not configured.');
      return text(await createIssue(bot, title, body, github, { labels }));
    },
  );

  server.tool(
    'run_command',
    'Run an arbitrary shell command on a managed bot host via SSH. The command is visible in the conversation.',
    {
      bot: z.string().describe('Bot identifier: "db" or "nook"'),
      command: z.string().describe('Shell command to execute'),
      timeout: z.number().optional().describe('Command timeout in seconds (default 30)'),
    },
    async ({ bot, command, timeout }) =>
      text(await runCommand(bot, command, sshExec, { timeout })),
  );

  // ─── Watcher ───────────────────────────────────────────

  const watcherStatePath = process.env.WATCHER_STATE_PATH || '/workspace/extra/watcher/health-state.json';
  const watcherConfigPath = process.env.WATCHER_CONFIG_PATH || '/workspace/extra/watcher/config.json';
  const watcherPoliciesPath = process.env.WATCHER_POLICIES_PATH || '/workspace/extra/watcher/policies.json';
  const watcherActionLogPath = process.env.WATCHER_ACTION_LOG_PATH || '/workspace/extra/watcher/action-log.json';
  const watcherRoutingPath = process.env.WATCHER_ROUTING_PATH || '/workspace/extra/watcher/routing.json';
  const watcherDependenciesPath = process.env.WATCHER_DEPENDENCIES_PATH || '/workspace/extra/watcher/dependencies.json';
  const watcherTrendConfigPath = process.env.WATCHER_TREND_CONFIG_PATH || '/workspace/extra/watcher/trend-config.json';
  const watcherTrendHistoryPath = process.env.WATCHER_TREND_HISTORY_PATH || '/workspace/extra/watcher/trend-history.json';

  server.tool(
    'watcher_check',
    'Run a health check cycle on all managed bots. Updates state file and returns alerts/recoveries/fleet alerts. Includes routing config, fleet status, and maintenance notifications.',
    {},
    async () => {
      const result = await watcherCheck(sshExec, watcherStatePath, watcherConfigPath, watcherDependenciesPath);
      const routingConfig = readRoutingConfig(watcherRoutingPath);
      return text(JSON.stringify({ ...result, routingConfig }, null, 2));
    },
  );

  // ─── Policy Engine ────────────────────────────────────

  server.tool(
    'policy_evaluate',
    'Evaluate policy rules against a watcher alert. Returns the decision: auto-fix, propose, or alert-only. Supports fleet (correlated) alerts.',
    {
      bot: z.string().describe('Bot identifier: "db", "nook", or "fleet" for correlated alerts'),
      from_state: z.string().describe('Previous health state'),
      to_state: z.string().describe('Current health state'),
      correlated: z.boolean().optional().describe('True for fleet alerts from correlation engine'),
      affected_bots: z.array(z.string()).optional().describe('Bot identifiers affected by a correlated event'),
      dependency: z.string().optional().describe('Dependency ID for correlated events'),
    },
    async ({ bot, from_state, to_state, correlated, affected_bots, dependency }) => {
      const policies = readPolicies(watcherPoliciesPath);
      const healthState = readHealthState(watcherStatePath);

      // For fleet alerts, use a synthetic health record
      let record;
      if (bot === 'fleet' || correlated) {
        record = {
          state: to_state as any,
          previousState: from_state as any,
          lastStateChange: new Date().toISOString(),
          lastCheckAt: new Date().toISOString(),
          consecutiveFailures: 0,
          lastAlertAt: null,
          crashLoopCount: 0,
          autoFixAttempts: 0,
          autoFixWindowStart: null,
          lastCriticalAlertAt: null,
          criticalAlertAcknowledged: false,
          escalationCount: 0,
          lastEscalationAt: null,
          maintenance: null,
        };
      } else {
        const rawRecord = healthState[bot];
        if (!rawRecord || !isBotHealthRecord(rawRecord)) {
          return text(JSON.stringify({
            error: `No health record found for bot "${bot}"`,
          }));
        }
        record = rawRecord;
      }

      const now = new Date();
      const decision = evaluatePolicy(
        bot,
        from_state as any,
        to_state as any,
        record,
        policies,
        undefined,
        now,
        correlated ? { correlated: true, affectedBots: affected_bots, dependency } : undefined,
      );

      // Log the evaluation with routing metadata
      const routingConfig = readRoutingConfig(watcherRoutingPath);
      const { classifySeverity, shouldSuppress, routeAlert } = await import('./watcher.js');

      // Determine alert type for severity classification
      let alertType = 'state-transition';
      if (decision.escalated) alertType = 'escalation';
      if (decision.response === 'propose') alertType = 'proposal';

      const severity = classifySeverity(alertType, { toState: to_state }, routingConfig);
      const channel = routeAlert(severity, routingConfig.channels);
      const suppressed = shouldSuppress(severity, routingConfig.quietHours, now);

      const routing: RoutingMetadata = {
        severity,
        channel,
        suppressed,
        escalated: decision.escalated,
      };

      const logEntry: ActionLogEntry = {
        timestamp: now.toISOString(),
        bot,
        trigger: {
          from: from_state as any,
          to: to_state as any,
          consecutiveFailures: record.consecutiveFailures,
          crashLooping: (record.crashLoopCount ?? 0) >= 3,
        },
        matchedRule: decision.ruleId,
        response: decision.response,
        action: decision.playbook,
        outcome: suppressed ? 'suppressed'
          : decision.response === 'auto-fix' ? 'auto-fixed'
          : decision.response === 'propose' ? 'proposed'
          : 'alert-sent',
        details: decision.escalated ? 'Escalated from auto-fix due to repeated failures' : '',
        routing,
        // Cross-bot coordination fields
        correlated: correlated ?? false,
        affectedBots: affected_bots,
        dependency: dependency ?? null,
      };
      appendActionLog(watcherActionLogPath, logEntry);

      // Update auto-fix tracking in health state (only for individual bots)
      if (decision.response === 'auto-fix' && !correlated) {
        record.autoFixAttempts = (record.autoFixAttempts ?? 0) + 1;
        if (!record.autoFixWindowStart) {
          record.autoFixWindowStart = now.toISOString();
        }
        writeHealthState(watcherStatePath, healthState);
      }

      return text(JSON.stringify({ ...decision, routing, correlated: correlated ?? false }, null, 2));
    },
  );

  // ─── Maintenance Mode (cross-bot-coordination T3) ─────

  server.tool(
    'maintenance_mode',
    'Set, clear, or query maintenance mode for a bot or the entire fleet.',
    {
      action: z.enum(['set', 'clear', 'status']).describe('Action to perform'),
      bot: z.string().optional().describe('Bot identifier. Omit for fleet-wide.'),
      duration_minutes: z.number().optional().describe('Auto-clear after N minutes (default: 60)'),
      reason: z.string().optional().describe('Why maintenance mode is being set'),
    },
    async ({ action, bot, duration_minutes, reason }) => {
      const healthState = readHealthState(watcherStatePath);
      const now = new Date();
      let result: string;

      switch (action) {
        case 'set':
          result = setMaintenanceMode(healthState, bot, duration_minutes ?? 60, reason ?? '', now);
          writeHealthState(watcherStatePath, healthState);
          break;
        case 'clear':
          result = clearMaintenanceMode(healthState, bot);
          writeHealthState(watcherStatePath, healthState);
          break;
        case 'status':
          result = getMaintenanceStatus(healthState, now);
          break;
        default:
          result = `Unknown action: ${action}`;
      }

      return text(result);
    },
  );

  // ─── Trend Analysis (proactive-proposals) ─────────────

  server.tool(
    'trend_analyze',
    'Analyze trend history for patterns and generate proactive proposals. Read-only — does not modify trend data.',
    {
      bot: z.string().optional().describe('Bot identifier to filter analysis, or omit for all bots'),
    },
    async ({ bot }) => {
      const trendConfig = readTrendConfig(watcherTrendConfigPath);
      const history = readTrendHistory(watcherTrendHistoryPath);
      const result = runTrendAnalysis(history, trendConfig, bot);
      return text(JSON.stringify(result, null, 2));
    },
  );

  server.tool(
    'trend_snapshot',
    'Collect and persist a daily trend snapshot from bot metrics. Called during the daily digest to record today\'s data point.',
    {
      bots: z.array(z.object({
        bot: z.string().describe('Bot identifier: "db" or "nook"'),
        healthState: z.string().describe('Current health state'),
        restartCount: z.number().describe('Number of restarts in last 24h'),
        errorCount: z.number().describe('Number of errors in last 24h'),
        uptimePercent: z.number().describe('Uptime percentage (0-100)'),
        stateTransitions: z.array(z.object({
          from: z.string(),
          to: z.string(),
          timestamp: z.string(),
        })).optional().describe('State transitions in last 24h'),
        unreachableEpisodes: z.number().describe('Number of unreachable episodes in last 24h'),
      })).describe('Per-bot metrics for the snapshot'),
      date: z.string().optional().describe('Snapshot date (YYYY-MM-DD). Defaults to today.'),
    },
    async ({ bots, date }) => {
      const trendConfig = readTrendConfig(watcherTrendConfigPath);

      const botData: DigestBotData[] = bots.map(b => ({
        bot: b.bot,
        healthState: b.healthState as any,
        restartCount: b.restartCount,
        errorCount: b.errorCount,
        uptimePercent: b.uptimePercent,
        stateTransitions: (b.stateTransitions ?? []).map(st => ({
          from: st.from,
          to: st.to,
          timestamp: st.timestamp,
        })),
        unreachableEpisodes: b.unreachableEpisodes,
      }));

      const snapshot = collectTrendSnapshot(botData, date);
      writeTrendSnapshot(watcherTrendHistoryPath, snapshot, trendConfig.retentionDays);

      return text(JSON.stringify({
        status: 'ok',
        date: snapshot.date,
        botsRecorded: Object.keys(snapshot.bots),
      }, null, 2));
    },
  );
}
