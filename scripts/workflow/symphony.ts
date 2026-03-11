#!/usr/bin/env -S npx tsx

import fs from 'node:fs';
import path from 'node:path';

import {
  SymphonyIssueRouting,
  resolveSymphonyBackend,
} from '../../src/symphony-routing.js';
import { buildSymphonyLaunchPlan } from '../../src/symphony-backends.js';
import { runSymphonyDaemon, runSymphonyTick } from '../../src/symphony-daemon.js';
import { dispatchOnceForProject } from '../../src/symphony-dispatch.js';
import { listReadyIssuesForProject } from '../../src/symphony-linear.js';
import {
  fetchProjectRegistryFromNotion,
  loadProjectRegistryFromFile,
  writeProjectRegistryCache,
} from '../../src/symphony-registry.js';
import { startSymphonyServer } from '../../src/symphony-server.js';
import {
  buildRuntimeState,
  listRunRecords,
  readRuntimeState,
} from '../../src/symphony-state.js';

const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const DEFAULT_REGISTRY_PATH =
  process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH ||
  path.join(ROOT_DIR, '.nanoclaw', 'symphony', 'project-registry.cache.json');
const EXAMPLE_REGISTRY_PATH = path.join(
  ROOT_DIR,
  '.claude',
  'examples',
  'symphony-project-registry.example.json',
);
const DEFAULT_NOTION_REGISTRY_DATABASE_ID =
  process.env.NOTION_PROJECT_REGISTRY_DATABASE_ID || '';
const DEFAULT_PORT = Number.parseInt(process.env.NANOCLAW_SYMPHONY_PORT || '4318', 10);
const DEFAULT_POLL_INTERVAL_MS = Number.parseInt(
  process.env.NANOCLAW_SYMPHONY_QUEUE_POLL_INTERVAL_MS || '15000',
  10,
);
const DEFAULT_AUTO_DISPATCH = String(
  process.env.NANOCLAW_SYMPHONY_AUTO_DISPATCH || 'false',
).toLowerCase() === 'true';

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/workflow/symphony.ts validate-registry [--file <path>]
  npx tsx scripts/workflow/symphony.ts show-projects [--file <path>]
  npx tsx scripts/workflow/symphony.ts sync-registry [--database <id>] [--out <path>]
  npx tsx scripts/workflow/symphony.ts list-ready --project-key <key> [--file <path>]
  npx tsx scripts/workflow/symphony.ts resolve-issue --issue-file <path> [--file <path>]
  npx tsx scripts/workflow/symphony.ts plan-run --issue-file <path> [--file <path>]
  npx tsx scripts/workflow/symphony.ts dispatch-once --project-key <key> [--issue <id>] [--dry-run] [--file <path>]
  npx tsx scripts/workflow/symphony.ts status [--file <path>]
  npx tsx scripts/workflow/symphony.ts serve [--port <port>] [--file <path>]
  npx tsx scripts/workflow/symphony.ts daemon [--once] [--auto-dispatch] [--interval-ms <n>] [--file <path>]
  npx tsx scripts/workflow/symphony.ts print-example
`);
  process.exit(1);
}

function optionValue(args: string[], name: string): string | null {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] || null;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function loadRegistry(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Missing Symphony registry cache: ${filePath}. Copy the example from ${EXAMPLE_REGISTRY_PATH} and replace it with your Notion-backed runtime cache.`,
    );
  }
  return loadProjectRegistryFromFile(filePath);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command) usage();

  const filePath = optionValue(rest, '--file') || DEFAULT_REGISTRY_PATH;

  switch (command) {
    case 'validate-registry': {
      const registry = loadRegistry(filePath);
      console.log(
        JSON.stringify(
          {
            status: 'ok',
            file: filePath,
            projectCount: registry.projects.length,
            projectKeys: registry.projects.map((project) => project.projectKey),
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'show-projects': {
      const registry = loadRegistry(filePath);
      console.log(
        JSON.stringify(
          registry.projects.map((project) => ({
            projectKey: project.projectKey,
            linearProject: project.linearProject,
            notionRoot: project.notionRoot,
            githubRepo: project.githubRepo,
            symphonyEnabled: project.symphonyEnabled,
            allowedBackends: project.allowedBackends,
            defaultBackend: project.defaultBackend,
            secretScope: project.secretScope,
            workspaceRoot: project.workspaceRoot,
            readyPolicy: project.readyPolicy,
          })),
          null,
          2,
        ),
      );
      return;
    }
    case 'sync-registry': {
      const databaseId = optionValue(rest, '--database') || DEFAULT_NOTION_REGISTRY_DATABASE_ID;
      const outPath = optionValue(rest, '--out') || filePath;
      if (!databaseId) {
        throw new Error(
          'sync-registry requires --database <id> or NOTION_PROJECT_REGISTRY_DATABASE_ID.',
        );
      }
      const registry = await fetchProjectRegistryFromNotion(databaseId);
      writeProjectRegistryCache(outPath, registry);
      console.log(
        JSON.stringify(
          {
            status: 'ok',
            databaseId,
            outPath,
            projectCount: registry.projects.length,
            projectKeys: registry.projects.map((project) => project.projectKey),
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'list-ready': {
      const projectKey = optionValue(rest, '--project-key');
      if (!projectKey) usage();
      const registry = loadRegistry(filePath);
      const project = registry.projects.find((entry) => entry.projectKey === projectKey);
      if (!project) {
        throw new Error(`Unknown Symphony projectKey: ${projectKey}`);
      }
      const issues = await listReadyIssuesForProject(project);
      console.log(JSON.stringify({ projectKey, issues }, null, 2));
      return;
    }
    case 'resolve-issue': {
      const issueFile = optionValue(rest, '--issue-file');
      if (!issueFile) usage();
      const registry = loadRegistry(filePath);
      const issue = readJsonFile<SymphonyIssueRouting>(issueFile);
      const resolved = resolveSymphonyBackend(registry, issue);
      console.log(JSON.stringify(resolved, null, 2));
      return;
    }
    case 'plan-run': {
      const issueFile = optionValue(rest, '--issue-file');
      if (!issueFile) usage();
      const registry = loadRegistry(filePath);
      const issue = readJsonFile<SymphonyIssueRouting>(issueFile);
      const resolved = resolveSymphonyBackend(registry, issue);
      const plan = buildSymphonyLaunchPlan({
        ...resolved,
        issueId: issue.issueId,
        issueIdentifier: issue.identifier,
      });
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    case 'dispatch-once': {
      const projectKey = optionValue(rest, '--project-key');
      if (!projectKey) usage();
      const registry = loadRegistry(filePath);
      const project = registry.projects.find((entry) => entry.projectKey === projectKey);
      if (!project) {
        throw new Error(`Unknown Symphony projectKey: ${projectKey}`);
      }
      const result = await dispatchOnceForProject(project, {
        issueIdentifier: optionValue(rest, '--issue') || undefined,
        dryRun: rest.includes('--dry-run'),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'status': {
      const registry = loadRegistry(filePath);
      const state =
        readRuntimeState() ||
        buildRuntimeState({
          registry,
          readyCounts: Object.fromEntries(
            registry.projects.map((project) => [project.projectKey, 0]),
          ),
          daemonHealthy: false,
          runs: listRunRecords(),
        });
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    case 'serve': {
      const port = Number.parseInt(optionValue(rest, '--port') || `${DEFAULT_PORT}`, 10);
      await startSymphonyServer({
        port,
        registryPath: filePath,
      });
      console.log(
        JSON.stringify(
          {
            status: 'listening',
            port,
            url: `http://127.0.0.1:${port}/`,
          },
          null,
          2,
        ),
      );
      await new Promise(() => undefined);
      return;
    }
    case 'daemon': {
      const autoDispatch = rest.includes('--auto-dispatch') || DEFAULT_AUTO_DISPATCH;
      if (rest.includes('--once')) {
        const result = await runSymphonyTick({
          registryPath: filePath,
          autoDispatch,
          daemonPid: process.pid,
        });
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const intervalMs = Number.parseInt(
        optionValue(rest, '--interval-ms') || `${DEFAULT_POLL_INTERVAL_MS}`,
        10,
      );
      console.log(
        JSON.stringify(
          {
            status: 'daemon-starting',
            intervalMs,
            autoDispatch,
          },
          null,
          2,
        ),
      );
      await runSymphonyDaemon({
        registryPath: filePath,
        pollIntervalMs: intervalMs,
        autoDispatch,
      });
      return;
    }
    case 'print-example': {
      console.log(fs.readFileSync(EXAMPLE_REGISTRY_PATH, 'utf8'));
      return;
    }
    default:
      usage();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
