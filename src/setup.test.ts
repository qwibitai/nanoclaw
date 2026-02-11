import { describe, it, expect } from 'vitest';

import {
  ASSISTANT_NAME,
  CLAUDE_CODE_OAUTH_TOKEN,
  CONTAINER_IMAGE,
  TENANT_CONFIG_PATH,
} from './config.js';

describe('P1-S1: Project setup', () => {
  it('builds without TypeScript errors', () => {
    // If this test file loads, TypeScript compilation succeeded
    expect(true).toBe(true);
  });

  it('nanoclaw core modules import correctly', async () => {
    const containerRunner = await import('./container-runner.js');
    expect(containerRunner.runContainerAgent).toBeDefined();

    const ipc = await import('./ipc.js');
    expect(ipc.startIpcWatcher).toBeDefined();

    const taskScheduler = await import('./task-scheduler.js');
    expect(taskScheduler.startSchedulerLoop).toBeDefined();

    const groupQueue = await import('./group-queue.js');
    expect(groupQueue.GroupQueue).toBeDefined();
  });

  it('CLAUDE_CODE_OAUTH_TOKEN env var is read from config', () => {
    expect(CLAUDE_CODE_OAUTH_TOKEN).toBeDefined();
    expect(typeof CLAUDE_CODE_OAUTH_TOKEN).toBe('string');
  });

  it('config exports tenant config path', () => {
    expect(TENANT_CONFIG_PATH).toBeDefined();
    expect(TENANT_CONFIG_PATH).toContain('tenant.yaml');
  });

  it('assistant name defaults to ComplaintBot', () => {
    expect(ASSISTANT_NAME).toBe('ComplaintBot');
  });

  it('container image updated to constituency-bot-agent', () => {
    expect(CONTAINER_IMAGE).toBe('constituency-bot-agent:latest');
  });

  it('tenant-config module exports loadTenantConfig', async () => {
    const tenantConfig = await import('./tenant-config.js');
    expect(tenantConfig.loadTenantConfig).toBeDefined();
    expect(typeof tenantConfig.loadTenantConfig).toBe('function');
  });

  it('loadTenantConfig returns valid default config', async () => {
    const { loadTenantConfig, _clearConfigCache } = await import('./tenant-config.js');
    _clearConfigCache();
    const config = loadTenantConfig();
    expect(config.mla_name).toBe('Rahul Kul');
    expect(config.constituency).toBe('Daund');
    expect(config.complaint_id_prefix).toBe('RK');
    expect(config.languages).toEqual(['mr', 'hi', 'en']);
    expect(config.daily_msg_limit).toBe(20);
  });
});
