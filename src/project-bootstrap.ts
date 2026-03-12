import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import {
  type LinearProjectRecord,
  ensureLinearProject,
  findLinearProjectByName,
} from './symphony-linear.js';
import type { ProjectRegistry, ProjectRegistryEntry } from './symphony-routing.js';
import {
  createNotionChildPage,
  fetchProjectRegistryFromNotion,
  findProjectRegistryPageByProjectKey,
  upsertProjectRegistryEntryInNotion,
  writeProjectRegistryCache,
} from './symphony-registry.js';

export const ProjectBootstrapModeSchema = z.enum(['nanoclaw-like', 'downstream-product']);
export type ProjectBootstrapMode = z.infer<typeof ProjectBootstrapModeSchema>;

export const ProjectBootstrapInputSchema = z.object({
  repo: z.string().min(1),
  mode: ProjectBootstrapModeSchema,
  localPath: z.string().min(1).optional(),
  projectKey: z.string().min(1).optional(),
  displayName: z.string().min(1).optional(),
  linearProject: z.string().min(1).optional(),
  notionRootUrl: z.string().url().optional(),
  sessionContextUrl: z.string().url().optional(),
});
export type ProjectBootstrapInput = z.infer<typeof ProjectBootstrapInputSchema>;

export type RepoIdentity = {
  githubRepo: string;
  localPath?: string;
  projectKey: string;
  displayName: string;
  linearProjectName: string;
};

export type ProjectBootstrapPlan = {
  projectKey: string;
  displayName: string;
  mode: ProjectBootstrapMode;
  githubRepo: string;
  localPath?: string;
  linear: 'link' | 'create';
  notionRoot: 'link' | 'create';
  sessionContext: 'link' | 'create';
  registry: 'create' | 'update';
  repoContractPack: 'write' | 'update';
  symphonyEnabled: boolean;
  secretScope: string;
  workspaceRoot: string;
};

export type ProjectBootstrapInspection = {
  repo: RepoIdentity;
  mode: ProjectBootstrapMode;
  existing: {
    linearProject: LinearProjectRecord | null;
    registryEntry: ProjectRegistryEntry | null;
  };
  plan: ProjectBootstrapPlan;
};

export type ProjectBootstrapApplyResult = {
  projectKey: string;
  githubRepo: string;
  linearProject: LinearProjectRecord;
  notionRootUrl: string;
  sessionContextUrl: string;
  registryStatus: 'created' | 'updated';
  cachePath: string;
  repoContractPackStatus: 'written' | 'updated';
};

export type ProjectBootstrapDependencies = {
  verifyGitHubRepo: (repoSlug: string, localPath?: string) => Promise<void>;
  findLinearProjectByName: (name: string) => Promise<LinearProjectRecord | null>;
  ensureLinearProject: (
    name: string,
  ) => Promise<{ action: 'linked' | 'created'; project: LinearProjectRecord }>;
  fetchRegistry: (databaseId: string) => Promise<ProjectRegistry>;
  findRegistryPageByProjectKey: (
    databaseId: string,
    projectKey: string,
  ) => Promise<{ id: string; url: string } | null>;
  createNotionChildPage: typeof createNotionChildPage;
  upsertRegistry: typeof upsertProjectRegistryEntryInNotion;
  writeRegistryCache: (filePath: string, registry: ProjectRegistry) => void;
};

const DEFAULT_READY_POLICY = 'andy-developer-ready-v1';
const DEFAULT_REGISTRY_PATH =
  process.env.NANOCLAW_SYMPHONY_REGISTRY_PATH ||
  path.join(process.cwd(), '.nanoclaw', 'symphony', 'project-registry.cache.json');

function defaultDependencies(): ProjectBootstrapDependencies {
  return {
    verifyGitHubRepo,
    findLinearProjectByName,
    ensureLinearProject,
    fetchRegistry: fetchProjectRegistryFromNotion,
    findRegistryPageByProjectKey: findProjectRegistryPageByProjectKey,
    createNotionChildPage,
    upsertRegistry: upsertProjectRegistryEntryInNotion,
    writeRegistryCache: writeProjectRegistryCache,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name] || '';
  if (!value) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

function expandHome(value: string): string {
  if (!value.startsWith('~')) {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

function titleCaseFromKey(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function normalizeProjectKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.git$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeGitHubRepoSlug(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('GitHub repo input is empty.');
  }

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') {
      throw new Error(`Unsupported GitHub hostname: ${url.hostname}`);
    }
    const [owner, repo] = url.pathname.split('/').filter(Boolean);
    if (!owner || !repo) {
      throw new Error(`Unable to parse GitHub repo from URL: ${trimmed}`);
    }
    return `${owner}/${repo.replace(/\.git$/i, '')}`;
  }

  if (trimmed.startsWith('git@github.com:')) {
    const slug = trimmed.slice('git@github.com:'.length).replace(/\.git$/i, '');
    if (!slug.includes('/')) {
      throw new Error(`Unable to parse GitHub repo from SSH URL: ${trimmed}`);
    }
    return slug;
  }

  if (!trimmed.includes('/')) {
    throw new Error(`Expected GitHub repo slug in owner/repo form, got "${trimmed}".`);
  }

  return trimmed.replace(/\.git$/i, '');
}

function isExistingDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function gitRemoteRepoSlug(localPath: string): string {
  const remoteUrl = execFileSync(
    'git',
    ['-C', localPath, 'config', '--get', 'remote.origin.url'],
    { encoding: 'utf8' },
  ).trim();
  return normalizeGitHubRepoSlug(remoteUrl);
}

export function deriveRepoIdentity(input: ProjectBootstrapInput): RepoIdentity {
  const parsed = ProjectBootstrapInputSchema.parse(input);

  const explicitLocalPath = parsed.localPath ? path.resolve(parsed.localPath) : undefined;
  const repoLooksLocal = isExistingDirectory(parsed.repo);
  const localPath = explicitLocalPath || (repoLooksLocal ? path.resolve(parsed.repo) : undefined);
  const githubRepo = localPath ? gitRemoteRepoSlug(localPath) : normalizeGitHubRepoSlug(parsed.repo);
  const repoBase = githubRepo.split('/').pop() || githubRepo;
  const projectKey = normalizeProjectKey(parsed.projectKey || repoBase);
  const displayName = parsed.displayName || titleCaseFromKey(projectKey);

  return {
    githubRepo,
    localPath,
    projectKey,
    displayName,
    linearProjectName: parsed.linearProject || projectKey,
  };
}

function workspaceBase(projectKey: string): string {
  const configuredBase =
    process.env.NANOCLAW_SYMPHONY_WORKSPACE_BASE ||
    process.env.SYMPHONY_WORKSPACE_ROOT ||
    path.join(os.homedir(), 'code', 'symphony-workspaces', 'nanoclaw');
  const expanded = path.resolve(expandHome(configuredBase));
  const base =
    path.basename(expanded) === 'nanoclaw'
      ? path.dirname(expanded)
      : expanded;
  return path.join(base, projectKey);
}

function defaultsForMode(
  mode: ProjectBootstrapMode,
  repo: RepoIdentity,
): Pick<
  ProjectRegistryEntry,
  | 'symphonyEnabled'
  | 'allowedBackends'
  | 'defaultBackend'
  | 'workClassesSupported'
  | 'secretScope'
  | 'workspaceRoot'
  | 'readyPolicy'
  | 'nightlyEnabled'
  | 'morningPrepEnabled'
> {
  if (mode === 'nanoclaw-like') {
    return {
      symphonyEnabled: true,
      allowedBackends: ['codex', 'claude-code'],
      defaultBackend: 'claude-code',
      workClassesSupported: ['nanoclaw-core', 'governance', 'research'],
      secretScope: repo.projectKey,
      workspaceRoot: workspaceBase(repo.projectKey),
      readyPolicy: DEFAULT_READY_POLICY,
      nightlyEnabled: false,
      morningPrepEnabled: false,
    };
  }

  return {
    symphonyEnabled: true,
    allowedBackends: ['opencode-worker'],
    defaultBackend: 'opencode-worker',
    workClassesSupported: ['downstream-project'],
    secretScope: repo.projectKey,
    workspaceRoot: workspaceBase(repo.projectKey),
    readyPolicy: DEFAULT_READY_POLICY,
    nightlyEnabled: false,
    morningPrepEnabled: false,
  };
}

function templateDir(): string {
  return path.join(
    process.cwd(),
    '.claude',
    'skills',
    'project-bootstrap',
    'templates',
  );
}

function renderTemplate(templateName: string, replacements: Record<string, string>): string {
  const templatePath = path.join(templateDir(), templateName);
  const source = fs.readFileSync(templatePath, 'utf8');
  return Object.entries(replacements).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    source,
  );
}

function writeFileEnsuringDir(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function maybeWriteInstructionFile(
  repoRoot: string,
  relativePath: string,
  templateName: string,
  replacements: Record<string, string>,
): 'written' | 'skipped-existing' {
  const filePath = path.join(repoRoot, relativePath);
  if (fs.existsSync(filePath)) {
    return 'skipped-existing';
  }
  writeFileEnsuringDir(filePath, renderTemplate(templateName, replacements));
  return 'written';
}

function ensureLocalSymphonyLauncher(
  repoRoot: string,
  replacements: Record<string, string>,
): void {
  const launcherPath = path.join(repoRoot, '.nanoclaw', 'bin', 'symphony-mcp.sh');
  writeFileEnsuringDir(
    launcherPath,
    renderTemplate('symphony-mcp.sh.tpl', replacements),
  );
  fs.chmodSync(launcherPath, 0o755);
}

function mergeCodexConfig(repoRoot: string): 'written' | 'updated' {
  const configPath = path.join(repoRoot, '.codex', 'config.toml');
  const block = `
[mcp_servers.symphony]
command = "bash"
args = [
  ".nanoclaw/bin/symphony-mcp.sh"
]
startup_timeout_sec = 20.0
tool_timeout_sec = 120.0
`.trim();

  if (!fs.existsSync(configPath)) {
    writeFileEnsuringDir(configPath, `${block}\n`);
    return 'written';
  }

  const current = fs.readFileSync(configPath, 'utf8');
  if (current.includes('[mcp_servers.symphony]')) {
    return 'updated';
  }
  writeFileEnsuringDir(configPath, `${current.trimEnd()}\n\n${block}\n`);
  return 'updated';
}

function mergeMcpJson(repoRoot: string): 'written' | 'updated' {
  const filePath = path.join(repoRoot, '.mcp.json');
  const symphonyServer = {
    command: 'bash',
    args: ['.nanoclaw/bin/symphony-mcp.sh'],
  };

  if (!fs.existsSync(filePath)) {
    writeFileEnsuringDir(
      filePath,
      `${JSON.stringify({ mcpServers: { symphony: symphonyServer } }, null, 2)}\n`,
    );
    return 'written';
  }

  const current = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
  current.mcpServers ||= {};
  current.mcpServers.symphony = symphonyServer;
  writeFileEnsuringDir(filePath, `${JSON.stringify(current, null, 2)}\n`);
  return 'updated';
}

export function writeRepoContractPack(input: {
  repoRoot: string;
  repo: RepoIdentity;
  mode: ProjectBootstrapMode;
  notionRootUrl: string;
  sessionContextUrl: string;
  linearProjectUrl: string;
}): 'written' | 'updated' {
  const repoRoot = path.resolve(input.repoRoot);
  const nanoclawRoot = process.cwd();
  const replacements = {
    ORCHESTRATOR_ROOT: nanoclawRoot,
    PROJECT_KEY: input.repo.projectKey,
    PROJECT_DISPLAY_NAME: input.repo.displayName,
    PROJECT_MODE: input.mode,
    GITHUB_REPO: input.repo.githubRepo,
    LINEAR_PROJECT_URL: input.linearProjectUrl,
    NOTION_ROOT_URL: input.notionRootUrl,
    SESSION_CONTEXT_URL: input.sessionContextUrl,
  };

  const rootStatuses = [
    maybeWriteInstructionFile(repoRoot, 'CLAUDE.md', 'CLAUDE.md.tpl', replacements),
    maybeWriteInstructionFile(repoRoot, 'AGENTS.md', 'AGENTS.md.tpl', replacements),
  ];
  ensureLocalSymphonyLauncher(repoRoot, replacements);

  writeFileEnsuringDir(
    path.join(repoRoot, 'docs', 'operations', 'project-control-plane-contract.md'),
    renderTemplate('project-control-plane-contract.md.tpl', replacements),
  );

  writeFileEnsuringDir(
    path.join(repoRoot, '.nanoclaw', 'project-bootstrap.json'),
    `${JSON.stringify(
      {
        projectKey: input.repo.projectKey,
        displayName: input.repo.displayName,
        mode: input.mode,
        orchestratorRoot: nanoclawRoot,
        githubRepo: input.repo.githubRepo,
        linearProjectUrl: input.linearProjectUrl,
        notionRootUrl: input.notionRootUrl,
        sessionContextUrl: input.sessionContextUrl,
      },
      null,
      2,
    )}\n`,
  );

  const codexStatus = mergeCodexConfig(repoRoot);
  const mcpStatus = mergeMcpJson(repoRoot);

  return [...rootStatuses, codexStatus, mcpStatus].every((status) => status === 'written')
    ? 'written'
    : 'updated';
}

function childSummaryLines(input: {
  repo: RepoIdentity;
  mode: ProjectBootstrapMode;
  linearProjectUrl?: string;
  notionRootUrl?: string;
}): string[] {
  return [
    `Project Key: ${input.repo.projectKey}`,
    `Mode: ${input.mode}`,
    `GitHub Repo: ${input.repo.githubRepo}`,
    input.linearProjectUrl ? `Linear Project: ${input.linearProjectUrl}` : '',
    input.notionRootUrl ? `Knowledge Root: ${input.notionRootUrl}` : '',
  ].filter(Boolean);
}

export async function verifyGitHubRepo(
  repoSlug: string,
  localPath?: string,
): Promise<void> {
  if (localPath) {
    if (!isExistingDirectory(localPath)) {
      throw new Error(`Local project path does not exist: ${localPath}`);
    }
    const localSlug = gitRemoteRepoSlug(localPath);
    if (localSlug !== repoSlug) {
      throw new Error(
        `Local project path ${localPath} points to ${localSlug}, expected ${repoSlug}.`,
      );
    }
    return;
  }

  execFileSync('gh', ['api', `repos/${repoSlug}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function buildRegistryEntry(input: {
  repo: RepoIdentity;
  mode: ProjectBootstrapMode;
  notionRootUrl: string;
}): ProjectRegistryEntry {
  const defaults = defaultsForMode(input.mode, input.repo);
  return {
    projectKey: input.repo.projectKey,
    displayName: input.repo.displayName,
    linearProject: input.repo.linearProjectName,
    notionRoot: input.notionRootUrl,
    githubRepo: input.repo.githubRepo,
    ...defaults,
  };
}

export async function inspectProjectBootstrap(
  input: ProjectBootstrapInput,
  dependencies: ProjectBootstrapDependencies = defaultDependencies(),
): Promise<ProjectBootstrapInspection> {
  const parsed = ProjectBootstrapInputSchema.parse(input);
  const repo = deriveRepoIdentity(parsed);

  await dependencies.verifyGitHubRepo(repo.githubRepo, repo.localPath);

  const registryDbId = requireEnv('NOTION_PROJECT_REGISTRY_DATABASE_ID');
  const registry = await dependencies.fetchRegistry(registryDbId);
  const registryEntry =
    registry.projects.find((entry) => entry.projectKey === repo.projectKey) || null;
  const linearProject =
    registryEntry
      ? await dependencies.findLinearProjectByName(registryEntry.linearProject)
      : await dependencies.findLinearProjectByName(repo.linearProjectName);

  const plan: ProjectBootstrapPlan = {
    projectKey: repo.projectKey,
    displayName: repo.displayName,
    mode: parsed.mode,
    githubRepo: repo.githubRepo,
    localPath: repo.localPath,
    linear: linearProject ? 'link' : 'create',
    notionRoot: parsed.notionRootUrl || registryEntry?.notionRoot ? 'link' : 'create',
    sessionContext: parsed.sessionContextUrl ? 'link' : 'create',
    registry: registryEntry ? 'update' : 'create',
    repoContractPack: repo.localPath ? 'write' : 'update',
    symphonyEnabled: true,
    secretScope: defaultsForMode(parsed.mode, repo).secretScope,
    workspaceRoot: defaultsForMode(parsed.mode, repo).workspaceRoot,
  };

  return {
    repo,
    mode: parsed.mode,
    existing: {
      linearProject,
      registryEntry,
    },
    plan,
  };
}

export async function applyProjectBootstrap(
  input: ProjectBootstrapInput,
  dependencies: ProjectBootstrapDependencies = defaultDependencies(),
): Promise<ProjectBootstrapApplyResult> {
  const inspection = await inspectProjectBootstrap(input, dependencies);
  const parsed = ProjectBootstrapInputSchema.parse(input);

  const localPath = inspection.repo.localPath;
  if (!localPath) {
    throw new Error('Applying project bootstrap requires --local-path (or a local repo path as --repo).');
  }

  const linearResult = await dependencies.ensureLinearProject(
    inspection.existing.registryEntry?.linearProject || inspection.repo.linearProjectName,
  );

  let notionRootUrl = parsed.notionRootUrl || inspection.existing.registryEntry?.notionRoot || '';
  if (!notionRootUrl) {
    const knowledgeParentPageId = requireEnv('NOTION_KNOWLEDGE_PARENT_PAGE_ID');
    const rootPage = await dependencies.createNotionChildPage({
      parentPageId: knowledgeParentPageId,
      title: inspection.repo.displayName,
      summaryLines: childSummaryLines({
        repo: inspection.repo,
        mode: inspection.mode,
        linearProjectUrl: linearResult.project.url,
      }),
    });
    notionRootUrl = rootPage.url;
  }

  let sessionContextUrl = parsed.sessionContextUrl || '';
  if (!sessionContextUrl) {
    const sessionContextParentPageId = requireEnv('NOTION_SESSION_CONTEXT_PARENT_PAGE_ID');
    const sessionPage = await dependencies.createNotionChildPage({
      parentPageId: sessionContextParentPageId,
      title: `${inspection.repo.displayName} Session Context`,
      summaryLines: childSummaryLines({
        repo: inspection.repo,
        mode: inspection.mode,
        linearProjectUrl: linearResult.project.url,
        notionRootUrl,
      }),
    });
    sessionContextUrl = sessionPage.url;
  }

  const registryEntry = buildRegistryEntry({
    repo: inspection.repo,
    mode: inspection.mode,
    notionRootUrl,
  });
  const registryDbId = requireEnv('NOTION_PROJECT_REGISTRY_DATABASE_ID');
  const registryResult = await dependencies.upsertRegistry(registryDbId, registryEntry);
  const refreshedRegistry = await dependencies.fetchRegistry(registryDbId);
  dependencies.writeRegistryCache(DEFAULT_REGISTRY_PATH, refreshedRegistry);

  const repoContractPackStatus = writeRepoContractPack({
    repoRoot: localPath,
    repo: inspection.repo,
    mode: inspection.mode,
    notionRootUrl,
    sessionContextUrl,
    linearProjectUrl: linearResult.project.url,
  });

  return {
    projectKey: inspection.repo.projectKey,
    githubRepo: inspection.repo.githubRepo,
    linearProject: linearResult.project,
    notionRootUrl,
    sessionContextUrl,
    registryStatus: registryResult.action,
    cachePath: DEFAULT_REGISTRY_PATH,
    repoContractPackStatus,
  };
}
