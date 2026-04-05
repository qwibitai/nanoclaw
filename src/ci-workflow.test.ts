import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function readRepoFile(...segments: string[]) {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function extractRunCommands(workflow: string) {
  return workflow
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const runCommand = line.match(/^-?\s*run:\s+(.+)$/);
      return runCommand ? [runCommand[1]] : [];
    });
}

describe('ci workflow', () => {
  it('keeps the root and agent runner CI step commands pinned', () => {
    // Arrange
    const workflow = readRepoFile('.github', 'workflows', 'ci.yml');

    // Act
    const runCommands = extractRunCommands(workflow);

    // Assert
    expect(runCommands).toEqual([
      'npm ci',
      'npm run format:check',
      'npm run typecheck',
      'npm test',
      'npm --prefix container/agent-runner ci',
      'npm --prefix container/agent-runner run build',
      'npm --prefix container/agent-runner run test',
    ]);
  });

  it('pins the agent runner to the explicit package test command', () => {
    // Arrange
    const packagePath = ['container', 'agent-runner', 'package.json'];
    const agentRunnerPackage = JSON.parse(readRepoFile(...packagePath)) as {
      scripts?: Record<string, string>;
    };

    // Act
    const scripts = agentRunnerPackage.scripts ?? {};

    // Assert
    expect(scripts.build).toBe('tsc');
    expect(scripts.test).toBe('npm run build && node --test test/*.test.js');
  });

  it('keeps a real smoke test around the built runner entrypoint', () => {
    // Arrange
    const smokeTest = readRepoFile(
      'container',
      'agent-runner',
      'test',
      'smoke.test.js',
    );

    // Act
    const normalizedSmokeTest = smokeTest.replace(/\s+/g, ' ');

    // Assert
    expect(normalizedSmokeTest).toContain(
      "const runnerEntryPoint = path.join(packageRoot, 'dist', 'index.js');",
    );
    expect(normalizedSmokeTest).toContain(
      "test('agent runner exits cleanly when a scheduled task script suppresses wake-up', async () => {",
    );
    expect(normalizedSmokeTest).toContain(
      "script: 'printf \\'{\"wakeAgent\":false}\\\\n\\''",
    );
    expect(normalizedSmokeTest).toContain(
      'const result = await runRunner(input);',
    );
    expect(normalizedSmokeTest).toContain('assert.equal(result.code, 0);');
    expect(normalizedSmokeTest).toContain(
      "assert.deepEqual(output, { status: 'success', result: null, });",
    );
  });
});
