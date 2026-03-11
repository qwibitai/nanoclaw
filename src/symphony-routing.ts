import { z } from 'zod';

export const SymphonyBackendSchema = z.enum([
  'codex',
  'claude-code',
  'opencode-worker',
]);
export type SymphonyBackend = z.infer<typeof SymphonyBackendSchema>;

export const SymphonyTargetRuntimeSchema = z.enum([
  'codex',
  'claude-code',
  'opencode',
]);
export type SymphonyTargetRuntime = z.infer<typeof SymphonyTargetRuntimeSchema>;

export const SymphonyWorkClassSchema = z.enum([
  'nanoclaw-core',
  'downstream-project',
  'governance',
  'research',
]);
export type SymphonyWorkClass = z.infer<typeof SymphonyWorkClassSchema>;

export const SymphonyExecutionLaneSchema = z.enum([
  'andy-developer',
  'codex',
  'claude-code',
  'jarvis-worker',
  'symphony',
  'human',
]);
export type SymphonyExecutionLane = z.infer<typeof SymphonyExecutionLaneSchema>;

export const ProjectRegistryEntrySchema = z.object({
  projectKey: z.string().min(1),
  displayName: z.string().min(1),
  linearProject: z.string().min(1),
  notionRoot: z.string().min(1),
  githubRepo: z.string().min(1),
  symphonyEnabled: z.boolean(),
  allowedBackends: z.array(SymphonyBackendSchema).min(1),
  defaultBackend: SymphonyBackendSchema,
  workClassesSupported: z.array(SymphonyWorkClassSchema).min(1),
  secretScope: z.string().min(1),
  workspaceRoot: z.string().min(1),
  readyPolicy: z.string().min(1),
  nightlyEnabled: z.boolean().optional(),
  morningPrepEnabled: z.boolean().optional(),
});
export type ProjectRegistryEntry = z.infer<typeof ProjectRegistryEntrySchema>;

export const ProjectRegistrySchema = z.object({
  schemaVersion: z.literal(1),
  projects: z.array(ProjectRegistryEntrySchema),
});
export type ProjectRegistry = z.infer<typeof ProjectRegistrySchema>;

export const SymphonyIssueRoutingSchema = z.object({
  issueId: z.string().min(1),
  identifier: z.string().min(1),
  projectKey: z.string().min(1),
  state: z.string().min(1),
  workClass: SymphonyWorkClassSchema,
  executionLane: SymphonyExecutionLaneSchema,
  targetRuntime: SymphonyTargetRuntimeSchema.optional(),
  repoUrl: z.string().min(1),
  baseBranch: z.string().min(1),
  notionContextUrl: z.string().optional(),
});
export type SymphonyIssueRouting = z.infer<typeof SymphonyIssueRoutingSchema>;

export type SymphonyBackendResolution = {
  backend: SymphonyBackend;
  projectKey: string;
  workspaceRoot: string;
  secretScope: string;
  reasons: string[];
};

function normalizeState(value: string): string {
  return value.trim().toLowerCase();
}

function runtimeToBackend(
  runtime: SymphonyTargetRuntime,
): SymphonyBackend {
  switch (runtime) {
    case 'codex':
      return 'codex';
    case 'claude-code':
      return 'claude-code';
    case 'opencode':
      return 'opencode-worker';
  }
}

export function validateProjectRegistry(
  input: unknown,
): ProjectRegistry {
  const registry = ProjectRegistrySchema.parse(input);
  const keys = new Set<string>();

  for (const project of registry.projects) {
    if (keys.has(project.projectKey)) {
      throw new Error(`Duplicate projectKey in registry: ${project.projectKey}`);
    }
    keys.add(project.projectKey);

    if (!project.allowedBackends.includes(project.defaultBackend)) {
      throw new Error(
        `Project ${project.projectKey} defaultBackend must be included in allowedBackends.`,
      );
    }
  }

  return registry;
}

export function findProjectRegistryEntry(
  registry: ProjectRegistry,
  projectKey: string,
): ProjectRegistryEntry {
  const entry = registry.projects.find((project) => project.projectKey === projectKey);
  if (!entry) {
    throw new Error(`Unknown Symphony projectKey: ${projectKey}`);
  }
  return entry;
}

export function resolveSymphonyBackend(
  registry: ProjectRegistry,
  issueInput: unknown,
): SymphonyBackendResolution {
  const issue = SymphonyIssueRoutingSchema.parse(issueInput);
  const project = findProjectRegistryEntry(registry, issue.projectKey);
  const reasons: string[] = [];

  if (!project.symphonyEnabled) {
    throw new Error(
      `Project ${project.projectKey} is not Symphony-enabled.`,
    );
  }

  if (issue.executionLane !== 'symphony') {
    throw new Error(
      `Issue ${issue.identifier} is not routed to Symphony.`,
    );
  }

  if (normalizeState(issue.state) !== 'ready') {
    throw new Error(
      `Issue ${issue.identifier} must be in Ready before Symphony dispatch.`,
    );
  }

  if (issue.workClass === 'governance' || issue.workClass === 'research') {
    throw new Error(
      `Symphony must not execute ${issue.workClass} issues.`,
    );
  }

  if (!project.workClassesSupported.includes(issue.workClass)) {
    throw new Error(
      `Project ${project.projectKey} does not support work class ${issue.workClass}.`,
    );
  }

  if (!issue.targetRuntime) {
    throw new Error(
      `Issue ${issue.identifier} must declare targetRuntime when routed to Symphony.`,
    );
  }

  const backend = runtimeToBackend(issue.targetRuntime);

  if (!project.allowedBackends.includes(backend)) {
    throw new Error(
      `Project ${project.projectKey} does not allow backend ${backend}.`,
    );
  }

  if (issue.workClass === 'nanoclaw-core' && backend === 'opencode-worker') {
    throw new Error(
      `NanoClaw core issues must not route to OpenCode workers by default.`,
    );
  }

  reasons.push(`project:${project.projectKey}`);
  reasons.push(`work_class:${issue.workClass}`);
  reasons.push(`backend:${backend}`);

  return {
    backend,
    projectKey: project.projectKey,
    workspaceRoot: project.workspaceRoot,
    secretScope: project.secretScope,
    reasons,
  };
}
