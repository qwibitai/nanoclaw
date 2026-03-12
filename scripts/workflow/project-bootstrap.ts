#!/usr/bin/env -S npx tsx

import path from 'node:path';

import {
  applyProjectBootstrap,
  inspectProjectBootstrap,
  ProjectBootstrapInputSchema,
} from '../../src/project-bootstrap.js';
import { listReadyIssuesForProject } from '../../src/symphony-linear.js';
import { loadProjectRegistryFromFile } from '../../src/symphony-registry.js';
import { findProjectRegistryEntry } from '../../src/symphony-routing.js';

const DEFAULT_REGISTRY_PATH =
  process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH ||
  path.join(process.cwd(), '.nanoclaw', 'symphony', 'project-registry.cache.json');

function usage(): never {
  console.error(`Usage:
  npx tsx scripts/workflow/project-bootstrap.ts inspect --repo <repo> --mode <nanoclaw-like|downstream-product> [--local-path <path>] [--project-key <key>] [--display-name <name>] [--linear-project <name>] [--notion-root-url <url>] [--session-context-url <url>]
  npx tsx scripts/workflow/project-bootstrap.ts dry-run --repo <repo> --mode <nanoclaw-like|downstream-product> [--local-path <path>] [--project-key <key>] [--display-name <name>] [--linear-project <name>] [--notion-root-url <url>] [--session-context-url <url>]
  npx tsx scripts/workflow/project-bootstrap.ts apply --repo <repo> --mode <nanoclaw-like|downstream-product> --local-path <path> [--project-key <key>] [--display-name <name>] [--linear-project <name>] [--notion-root-url <url>] [--session-context-url <url>]
  npx tsx scripts/workflow/project-bootstrap.ts status --project-key <key> [--file <path>]
`);
  process.exit(1);
}

function optionValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseInput(args: string[]) {
  const input = ProjectBootstrapInputSchema.parse({
    repo: optionValue(args, '--repo'),
    mode: optionValue(args, '--mode'),
    localPath: optionValue(args, '--local-path'),
    projectKey: optionValue(args, '--project-key'),
    displayName: optionValue(args, '--display-name'),
    linearProject: optionValue(args, '--linear-project'),
    notionRootUrl: optionValue(args, '--notion-root-url'),
    sessionContextUrl: optionValue(args, '--session-context-url'),
  });
  return input;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command) usage();

  switch (command) {
    case 'inspect':
    case 'dry-run': {
      const inspection = await inspectProjectBootstrap(parseInput(rest));
      console.log(
        JSON.stringify(
          {
            action: command,
            inspection,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'apply': {
      const result = await applyProjectBootstrap(parseInput(rest));
      console.log(
        JSON.stringify(
          {
            action: 'apply',
            result,
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'status': {
      const projectKey = optionValue(rest, '--project-key');
      if (!projectKey) usage();
      const filePath = optionValue(rest, '--file') || DEFAULT_REGISTRY_PATH;
      const registry = loadProjectRegistryFromFile(filePath);
      const project = findProjectRegistryEntry(registry, projectKey);
      const readyIssues = await listReadyIssuesForProject(project);
      console.log(
        JSON.stringify(
          {
            project,
            readyIssues,
          },
          null,
          2,
        ),
      );
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
