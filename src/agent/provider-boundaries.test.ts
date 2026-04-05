import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function collectSourceFiles(rootDir: string): string[] {
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist') {
        continue;
      }
      files.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

function toRelativeProjectPath(filePath: string): string {
  return path.relative(projectRoot, filePath).split(path.sep).join('/');
}

describe('provider boundaries', () => {
  it('keeps Claude SDK imports inside Claude provider files', () => {
    // Arrange
    const allowedFiles = new Set([
      'container/agent-runner/src/providers/claude-code.ts',
    ]);
    const sourceFiles = [
      ...collectSourceFiles(path.join(projectRoot, 'src')),
      ...collectSourceFiles(
        path.join(projectRoot, 'container', 'agent-runner', 'src'),
      ),
    ];

    // Act
    const violations = sourceFiles
      .filter((filePath) => !allowedFiles.has(toRelativeProjectPath(filePath)))
      .filter((filePath) =>
        fs
          .readFileSync(filePath, 'utf-8')
          .includes('@anthropic-ai/claude-agent-sdk'),
      )
      .map(toRelativeProjectPath);

    // Assert
    expect(violations).toEqual([]);
  });

  it('keeps Claude CLI remote-control spawning inside Claude provider files', () => {
    // Arrange
    const allowedFiles = new Set([
      'src/agent/providers/claude-code/remote-control.ts',
    ]);
    const sourceFiles = [
      ...collectSourceFiles(path.join(projectRoot, 'src')),
      ...collectSourceFiles(
        path.join(projectRoot, 'container', 'agent-runner', 'src'),
      ),
    ];
    const remoteControlSpawnPattern =
      /spawn\(\s*['"]claude['"]\s*,\s*\[\s*['"]remote-control['"]/;

    // Act
    const violations = sourceFiles
      .filter((filePath) => !allowedFiles.has(toRelativeProjectPath(filePath)))
      .filter((filePath) =>
        remoteControlSpawnPattern.test(fs.readFileSync(filePath, 'utf-8')),
      )
      .map(toRelativeProjectPath);

    // Assert
    expect(violations).toEqual([]);
  });
});
