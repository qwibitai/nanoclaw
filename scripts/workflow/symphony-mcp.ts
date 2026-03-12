#!/usr/bin/env -S npx tsx

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { dispatchOnceForProject } from '../../src/symphony-dispatch.js';
import { runSymphonyTick, stopSymphonyRun } from '../../src/symphony-daemon.js';
import { listReadyIssuesForProject } from '../../src/symphony-linear.js';
import {
  fetchProjectRegistryFromNotion,
  loadProjectRegistryFromFile,
  writeProjectRegistryCache,
} from '../../src/symphony-registry.js';
import { findProjectRegistryEntry, type ProjectRegistry } from '../../src/symphony-routing.js';
import {
  archiveRunRecords,
  buildRuntimeState,
  listRunRecords,
  readRunRecord,
  readRuntimeState,
  updateRunRecord,
} from '../../src/symphony-state.js';

const DEFAULT_REGISTRY_PATH =
  process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH ||
  `${process.cwd()}/.nanoclaw/symphony/project-registry.cache.json`;
const DEFAULT_NOTION_REGISTRY_DATABASE_ID =
  process.env.NOTION_PROJECT_REGISTRY_DATABASE_ID || '';

function loadRegistry(filePath = DEFAULT_REGISTRY_PATH): ProjectRegistry {
  return loadProjectRegistryFromFile(filePath);
}

function runtimeStateForRegistry(registry: ProjectRegistry) {
  return (
    readRuntimeState() ||
    buildRuntimeState({
      registry,
      readyCounts: Object.fromEntries(registry.projects.map((project) => [project.projectKey, 0])),
      daemonHealthy: false,
      runs: listRunRecords(),
    })
  );
}

function resultWithJson(summary: string, payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `${summary}\n\n${JSON.stringify(payload, null, 2)}`,
      },
    ],
  };
}

const server = new McpServer({
  name: 'symphony',
  version: '1.0.0',
});

server.tool(
  'symphony_sync_registry',
  'Sync the canonical Notion project registry into the local Symphony cache. Use this before portfolio inspection when project onboarding or registry edits may have changed.',
  {
    database_id: z.string().optional().describe('Optional Notion database ID override. Defaults to NOTION_PROJECT_REGISTRY_DATABASE_ID.'),
    out_path: z.string().optional().describe('Optional local cache path override. Defaults to NANOCLAW_SYMPHONY_REGISTRY_PATH.'),
  },
  async (args) => {
    const databaseId = args.database_id || DEFAULT_NOTION_REGISTRY_DATABASE_ID;
    if (!databaseId) {
      throw new Error('Missing Notion project registry database ID.');
    }
    const outPath = args.out_path || DEFAULT_REGISTRY_PATH;
    const registry = await fetchProjectRegistryFromNotion(databaseId);
    writeProjectRegistryCache(outPath, registry);
    return resultWithJson(
      `Synced ${registry.projects.length} project entries into the local Symphony registry cache.`,
      {
        outPath,
        registry,
      },
    );
  },
);

server.tool(
  'symphony_list_projects',
  'List all configured Symphony projects from the registry, including enablement and current runtime summary. Use when deciding which project queue to inspect or dispatch.',
  {
    enabled_only: z.boolean().optional().describe('When true, only return projects with Symphony enabled.'),
  },
  async (args) => {
    const registry = loadRegistry();
    const runtime = runtimeStateForRegistry(registry);
    const projects = registry.projects
      .filter((project) => (args.enabled_only ? project.symphonyEnabled : true))
      .map((project) => ({
        ...project,
        runtime:
          runtime.projects.find((entry) => entry.projectKey === project.projectKey) || null,
      }));
    return resultWithJson(
      `${projects.length} project(s) matched the current Symphony registry filter.`,
      { projects },
    );
  },
);

server.tool(
  'symphony_get_runtime_state',
  'Read the current local Symphony runtime state, including daemon health, ready counts, and active runs. Use this instead of scraping the dashboard.',
  {},
  async () => {
    const registry = loadRegistry();
    const runtime = runtimeStateForRegistry(registry);
    return resultWithJson('Loaded the current Symphony runtime state.', runtime);
  },
);

server.tool(
  'symphony_list_ready_issues',
  'List Ready Linear issues visible to Symphony for one configured project. Use before dispatching or when auditing queue shape.',
  {
    project_key: z.string().describe('Project key from the Symphony registry.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum issues to return. Defaults to 20.'),
  },
  async (args) => {
    const registry = loadRegistry();
    const project = findProjectRegistryEntry(registry, args.project_key);
    const issues = await listReadyIssuesForProject(project);
    const limited = issues.slice(0, args.limit || 20);
    return resultWithJson(
      `${limited.length} Ready issue(s) loaded for project ${project.projectKey}.`,
      {
        project: project.projectKey,
        issues: limited,
      },
    );
  },
);

server.tool(
  'symphony_list_runs',
  'List persisted Symphony run records. Supports filtering by project and status so agents can inspect orchestration state without opening the dashboard.',
  {
    project_key: z.string().optional().describe('Optional project key filter.'),
    status: z.enum(['planned', 'dispatching', 'running', 'review', 'blocked', 'failed', 'done', 'canceled']).optional().describe('Optional run status filter.'),
    limit: z.number().int().min(1).max(100).optional().describe('Maximum runs to return. Defaults to 20.'),
  },
  async (args) => {
    const runs = listRunRecords()
      .filter((run) => (args.project_key ? run.projectKey === args.project_key : true))
      .filter((run) => (args.status ? run.status === args.status : true))
      .slice(0, args.limit || 20);
    return resultWithJson(`${runs.length} Symphony run record(s) matched the current filter.`, {
      runs,
    });
  },
);

server.tool(
  'symphony_get_run',
  'Get one Symphony run record by run ID, including workspace, backend, and log paths.',
  {
    run_id: z.string().describe('The Symphony run ID.'),
  },
  async (args) => {
    const run = readRunRecord(args.run_id);
    return resultWithJson(`Loaded run ${run.runId}.`, run);
  },
);

server.tool(
  'symphony_dispatch_once',
  'Dispatch one Ready issue through Symphony for a configured project. Supports dry-run mode for safe validation before real execution.',
  {
    project_key: z.string().describe('Project key from the Symphony registry.'),
    issue_identifier: z.string().optional().describe('Optional explicit Linear issue identifier. If omitted, Symphony selects the next eligible Ready issue.'),
    dry_run: z.boolean().optional().describe('When true, prepare the workspace and plan without launching the backend.'),
  },
  async (args) => {
    const registry = loadRegistry();
    const project = findProjectRegistryEntry(registry, args.project_key);
    const result = await dispatchOnceForProject(project, {
      issueIdentifier: args.issue_identifier,
      dryRun: args.dry_run,
    });
    return resultWithJson(
      `Dispatch request completed for project ${project.projectKey} with action ${result.action}.`,
      result,
    );
  },
);

server.tool(
  'symphony_reconcile_once',
  'Run one Symphony reconciliation tick: refresh ready counts, reconcile active runs, and optionally auto-dispatch. Use this to refresh orchestration state on demand.',
  {
    auto_dispatch: z.boolean().optional().describe('When true, allow the tick to auto-dispatch eligible Ready work. Defaults to false.'),
  },
  async (args) => {
    const result = await runSymphonyTick({
      registryPath: DEFAULT_REGISTRY_PATH,
      autoDispatch: args.auto_dispatch,
      daemonPid: process.pid,
    });
    return resultWithJson('Completed one Symphony reconciliation tick.', result);
  },
);

server.tool(
  'symphony_stop_run',
  'Stop one active Symphony run by run ID, mark it canceled locally, and move the linked Linear issue to Blocked with an operator note.',
  {
    run_id: z.string().describe('Active Symphony run ID to stop.'),
    reason: z.string().optional().describe('Optional operator reason to record on the run and linked issue.'),
  },
  async (args) => {
    const result = await stopSymphonyRun({
      runId: args.run_id,
      reason: args.reason,
    });
    await runSymphonyTick({
      registryPath: DEFAULT_REGISTRY_PATH,
      autoDispatch: false,
      daemonPid: process.pid,
    });
    return resultWithJson(`Stop request completed for run ${args.run_id}.`, result);
  },
);

server.tool(
  'symphony_get_run_log',
  'Read the tail of a run\'s log file. Useful for debugging agent output without needing shell access to the workspace.',
  {
    run_id: z.string().describe('The Symphony run ID.'),
    lines: z.number().int().min(1).max(500).optional().describe('Number of lines from the end to return. Defaults to 50.'),
  },
  async (args) => {
    const run = readRunRecord(args.run_id);
    const lines = args.lines ?? 50;
    let content = '';
    try {
      const { readFileSync } = await import('node:fs');
      const raw = readFileSync(run.logFile, 'utf8');
      const allLines = raw.split('\n');
      content = allLines.slice(-lines).join('\n');
    } catch {
      content = '(log file not found or unreadable)';
    }
    return resultWithJson(`Last ${lines} lines of log for run ${run.runId}.`, {
      runId: run.runId,
      logFile: run.logFile,
      status: run.status,
      content,
    });
  },
);

server.tool(
  'symphony_mark_run_status',
  'Manually override the local status of a Symphony run record. Use to recover stuck runs when automatic reconciliation fails (e.g. missing Linear state).',
  {
    run_id: z.string().describe('The Symphony run ID to update.'),
    status: z.enum(['planned', 'dispatching', 'running', 'review', 'blocked', 'failed', 'done', 'canceled']).describe('New status to set on the run record.'),
    reason: z.string().optional().describe('Optional note to record as resultSummary.'),
  },
  async (args) => {
    const updated = updateRunRecord(args.run_id, {
      status: args.status,
      ...(args.reason ? { resultSummary: args.reason } : {}),
    });
    return resultWithJson(`Run ${args.run_id} status updated to ${args.status}.`, updated);
  },
);

server.tool(
  'symphony_archive_runs',
  'Move old completed Symphony run records to an archive subdirectory. Use to keep the active runs directory manageable without permanently deleting history.',
  {
    older_than_days: z.number().int().min(1).max(365).optional().describe('Archive runs whose startedAt is older than this many days. Defaults to 7.'),
    statuses: z
      .array(z.enum(['planned', 'dispatching', 'running', 'review', 'blocked', 'failed', 'done', 'canceled']))
      .optional()
      .describe('Status values eligible for archiving. Defaults to ["done", "failed", "canceled"].'),
  },
  async (args) => {
    const result = archiveRunRecords({
      olderThanDays: args.older_than_days,
      statuses: args.statuses as Array<'planned' | 'dispatching' | 'running' | 'review' | 'blocked' | 'failed' | 'done' | 'canceled'> | undefined,
    });
    return resultWithJson(
      `Archived ${result.archived} run record(s); ${result.kept} record(s) kept in the active runs directory.`,
      result,
    );
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
