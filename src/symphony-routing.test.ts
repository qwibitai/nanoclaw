import { describe, expect, it } from 'vitest';

import {
  resolveSymphonyBackend,
  validateProjectRegistry,
} from './symphony-routing.js';

const registry = validateProjectRegistry({
  schemaVersion: 1,
  projects: [
    {
      projectKey: 'nanoclaw',
      displayName: 'NanoClaw',
      linearProject: 'nanoclaw',
      notionRoot: 'notion://nanoclaw',
      githubRepo: 'ingpoc/nanoclaw',
      symphonyEnabled: true,
      allowedBackends: ['codex', 'claude-code'],
      defaultBackend: 'codex',
      workClassesSupported: ['nanoclaw-core'],
      secretScope: 'nanoclaw',
      workspaceRoot: '/tmp/nanoclaw-symphony',
      readyPolicy: 'andy-developer-ready-v1',
    },
    {
      projectKey: 'aadhar-chain',
      displayName: 'Aadhar Chain',
      linearProject: 'aadhar-chain',
      notionRoot: 'notion://aadhar-chain',
      githubRepo: 'your-org/aadhar-chain',
      symphonyEnabled: true,
      allowedBackends: ['opencode-worker', 'codex'],
      defaultBackend: 'opencode-worker',
      workClassesSupported: ['downstream-project'],
      secretScope: 'aadhar-chain',
      workspaceRoot: '/tmp/aadhar-chain-symphony',
      readyPolicy: 'andy-developer-ready-v1',
    },
  ],
});

describe('validateProjectRegistry', () => {
  it('rejects duplicate project keys', () => {
    expect(() =>
      validateProjectRegistry({
        schemaVersion: 1,
        projects: [
          {
            projectKey: 'dup',
            displayName: 'Dup',
            linearProject: 'dup',
            notionRoot: 'n',
            githubRepo: 'o/r',
            symphonyEnabled: true,
            allowedBackends: ['codex'],
            defaultBackend: 'codex',
            workClassesSupported: ['nanoclaw-core'],
            secretScope: 'dup',
            workspaceRoot: '/tmp/dup',
            readyPolicy: 'p',
          },
          {
            projectKey: 'dup',
            displayName: 'Dup 2',
            linearProject: 'dup-2',
            notionRoot: 'n2',
            githubRepo: 'o/r2',
            symphonyEnabled: true,
            allowedBackends: ['codex'],
            defaultBackend: 'codex',
            workClassesSupported: ['nanoclaw-core'],
            secretScope: 'dup-2',
            workspaceRoot: '/tmp/dup-2',
            readyPolicy: 'p',
          },
        ],
      }),
    ).toThrow(/Duplicate projectKey/);
  });
});

describe('resolveSymphonyBackend', () => {
  it('routes NanoClaw issues to Codex', () => {
    const result = resolveSymphonyBackend(registry, {
      issueId: '1',
      identifier: 'NCL-1',
      projectKey: 'nanoclaw',
      state: 'Ready',
      workClass: 'nanoclaw-core',
      executionLane: 'symphony',
      targetRuntime: 'codex',
      repoUrl: 'https://github.com/ingpoc/nanoclaw',
      baseBranch: 'main',
    });

    expect(result).toEqual({
      backend: 'codex',
      projectKey: 'nanoclaw',
      workspaceRoot: '/tmp/nanoclaw-symphony',
      secretScope: 'nanoclaw',
      reasons: ['project:nanoclaw', 'work_class:nanoclaw-core', 'backend:codex'],
    });
  });

  it('routes NanoClaw issues to Claude Code when allowed', () => {
    const result = resolveSymphonyBackend(registry, {
      issueId: '2',
      identifier: 'NCL-2',
      projectKey: 'nanoclaw',
      state: 'Ready',
      workClass: 'nanoclaw-core',
      executionLane: 'symphony',
      targetRuntime: 'claude-code',
      repoUrl: 'https://github.com/ingpoc/nanoclaw',
      baseBranch: 'main',
    });

    expect(result.backend).toBe('claude-code');
  });

  it('routes downstream project issues to OpenCode workers', () => {
    const result = resolveSymphonyBackend(registry, {
      issueId: '3',
      identifier: 'AAD-1',
      projectKey: 'aadhar-chain',
      state: 'Ready',
      workClass: 'downstream-project',
      executionLane: 'symphony',
      targetRuntime: 'opencode',
      repoUrl: 'https://github.com/your-org/aadhar-chain',
      baseBranch: 'main',
    });

    expect(result.backend).toBe('opencode-worker');
  });

  it('rejects non-ready issues', () => {
    expect(() =>
      resolveSymphonyBackend(registry, {
        issueId: '4',
        identifier: 'NCL-3',
        projectKey: 'nanoclaw',
        state: 'Backlog',
        workClass: 'nanoclaw-core',
        executionLane: 'symphony',
        targetRuntime: 'codex',
        repoUrl: 'https://github.com/ingpoc/nanoclaw',
        baseBranch: 'main',
      }),
    ).toThrow(/must be in Ready/);
  });

  it('rejects issues without target runtime', () => {
    expect(() =>
      resolveSymphonyBackend(registry, {
        issueId: '5',
        identifier: 'NCL-4',
        projectKey: 'nanoclaw',
        state: 'Ready',
        workClass: 'nanoclaw-core',
        executionLane: 'symphony',
        repoUrl: 'https://github.com/ingpoc/nanoclaw',
        baseBranch: 'main',
      }),
    ).toThrow(/must declare targetRuntime/);
  });

  it('rejects disallowed backend/project combinations', () => {
    expect(() =>
      resolveSymphonyBackend(registry, {
        issueId: '6',
        identifier: 'AAD-2',
        projectKey: 'aadhar-chain',
        state: 'Ready',
        workClass: 'downstream-project',
        executionLane: 'symphony',
        targetRuntime: 'claude-code',
        repoUrl: 'https://github.com/your-org/aadhar-chain',
        baseBranch: 'main',
      }),
    ).toThrow(/does not allow backend/);
  });

  it('rejects governance issues for Symphony execution', () => {
    expect(() =>
      resolveSymphonyBackend(registry, {
        issueId: '7',
        identifier: 'NCL-5',
        projectKey: 'nanoclaw',
        state: 'Ready',
        workClass: 'governance',
        executionLane: 'symphony',
        targetRuntime: 'codex',
        repoUrl: 'https://github.com/ingpoc/nanoclaw',
        baseBranch: 'main',
      }),
    ).toThrow(/must not execute governance issues/i);
  });

  it('rejects NanoClaw routing to OpenCode workers by default', () => {
    const permissiveRegistry = validateProjectRegistry({
      schemaVersion: 1,
      projects: [
        {
          projectKey: 'nanoclaw',
          displayName: 'NanoClaw',
          linearProject: 'nanoclaw',
          notionRoot: 'notion://nanoclaw',
          githubRepo: 'ingpoc/nanoclaw',
          symphonyEnabled: true,
          allowedBackends: ['codex', 'claude-code', 'opencode-worker'],
          defaultBackend: 'codex',
          workClassesSupported: ['nanoclaw-core'],
          secretScope: 'nanoclaw',
          workspaceRoot: '/tmp/nanoclaw-symphony',
          readyPolicy: 'andy-developer-ready-v1',
        },
      ],
    });

    expect(() =>
      resolveSymphonyBackend(permissiveRegistry, {
        issueId: '8',
        identifier: 'NCL-6',
        projectKey: 'nanoclaw',
        state: 'Ready',
        workClass: 'nanoclaw-core',
        executionLane: 'symphony',
        targetRuntime: 'opencode',
        repoUrl: 'https://github.com/ingpoc/nanoclaw',
        baseBranch: 'main',
      }),
    ).toThrow(/must not route to OpenCode workers/i);
  });
});
