import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DOCKERFILE_PATH = resolve(
  import.meta.dirname,
  '..',
  'container',
  'Dockerfile'
);

const AGENT_RUNNER_PATH = resolve(
  import.meta.dirname,
  '..',
  'container',
  'agent-runner',
  'src',
  'index.ts'
);

const CONTAINER_RUNNER_PATH = resolve(
  import.meta.dirname,
  'container-runner.ts'
);

describe('P1-S5: Container agent configuration', () => {
  describe('Dockerfile', () => {
    let dockerfile: string;

    it('includes sqlite3 CLI in apt-get install', () => {
      dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
      expect(dockerfile).toContain('sqlite3');
    });

    it('creates /workspace/tools directory', () => {
      dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
      expect(dockerfile).toContain('/workspace/tools');
    });

    it('creates /workspace/store directory', () => {
      dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
      expect(dockerfile).toContain('/workspace/store');
    });

    it('creates /workspace/config directory', () => {
      dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
      expect(dockerfile).toContain('/workspace/config');
    });
  });

  describe('Agent runner', () => {
    let agentRunner: string;

    it('configures Sonnet 4.5 as the default model', () => {
      agentRunner = readFileSync(AGENT_RUNNER_PATH, 'utf-8');
      expect(agentRunner).toContain('claude-sonnet-4-5-20250929');
    });

    it('passes the model option to query()', () => {
      agentRunner = readFileSync(AGENT_RUNNER_PATH, 'utf-8');
      // The model should be set in the query options
      expect(agentRunner).toMatch(/model:\s*['"]claude-sonnet-4-5-20250929['"]/);
    });

    it('preserves session persistence via resume option', () => {
      agentRunner = readFileSync(AGENT_RUNNER_PATH, 'utf-8');
      expect(agentRunner).toContain('resume: sessionId');
    });
  });

  describe('Container runner mounts', () => {
    let containerRunner: string;

    it('mounts tools/ directory for non-main groups', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      expect(containerRunner).toContain('/workspace/tools');
    });

    it('mounts store/ directory for non-main groups', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      expect(containerRunner).toContain('/workspace/store');
    });

    it('mounts config/ directory for non-main groups', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      expect(containerRunner).toContain('/workspace/config');
    });

    it('tools mount is read-only', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      // Find the tools mount block and verify it's readonly
      const toolsMountMatch = containerRunner.match(
        /containerPath:\s*'\/workspace\/tools'[\s\S]*?readonly:\s*(true|false)/
      );
      expect(toolsMountMatch).not.toBeNull();
      expect(toolsMountMatch![1]).toBe('true');
    });

    it('store mount is read-write', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      // Find the store mount block and verify it's read-write
      const storeMountMatch = containerRunner.match(
        /containerPath:\s*'\/workspace\/store'[\s\S]*?readonly:\s*(true|false)/
      );
      expect(storeMountMatch).not.toBeNull();
      expect(storeMountMatch![1]).toBe('false');
    });

    it('config mount is read-only', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      // Find the config mount block and verify it's readonly
      const configMountMatch = containerRunner.match(
        /containerPath:\s*'\/workspace\/config'[\s\S]*?readonly:\s*(true|false)/
      );
      expect(configMountMatch).not.toBeNull();
      expect(configMountMatch![1]).toBe('true');
    });

    it('imports STORE_DIR from config', () => {
      containerRunner = readFileSync(CONTAINER_RUNNER_PATH, 'utf-8');
      expect(containerRunner).toContain('STORE_DIR');
    });
  });
});
