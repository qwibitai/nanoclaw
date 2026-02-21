import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

describe('add-generative-ui skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: generative-ui');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('@json-render/core');
    expect(content).toContain('@json-render/react');
    expect(content).toContain('@json-render/shadcn');
    expect(content).toContain('GENUI_PORT');
    expect(content).toContain('scripts/build-canvas-ui.mjs');
  });

  it('has SKILL metadata and usage instructions', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);

    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toContain('name: add-generative-ui');
    expect(content).toContain('mcp__nanoclaw__update_canvas');
    expect(content).toContain('events_jsonl');
    expect(content).toContain('/api/canvas/');
    expect(content).toContain('http://127.0.0.1:4318/canvas');
  });

  it('has all files declared in adds', () => {
    const expectedFiles = [
      'add/src/canvas-store.ts',
      'add/src/canvas-store.test.ts',
      'add/src/canvas-server.ts',
      'add/src/canvas-server.test.ts',
      'add/scripts/build-canvas-ui.mjs',
      'add/web/src/index.html',
      'add/web/src/main.tsx',
      'add/web/src/styles.css',
      'add/web/dist/index.html',
      'add/web/dist/canvas-app.js',
      'add/web/dist/canvas-app.css',
      'add/container/skills/generative-ui-builder/SKILL.md',
      'add/container/skills/json-render-core/SKILL.md',
      'add/container/skills/json-render-react/SKILL.md',
      'add/container/skills/json-render-shadcn/SKILL.md',
    ];

    for (const relPath of expectedFiles) {
      expect(fs.existsSync(path.join(skillDir, relPath))).toBe(true);
    }
  });

  it('has all files declared in modifies', () => {
    const expectedFiles = [
      'modify/src/config.ts',
      'modify/src/index.ts',
      'modify/src/ipc.ts',
      'modify/src/container-runner.ts',
      'modify/src/ipc-auth.test.ts',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts',
    ];

    for (const relPath of expectedFiles) {
      expect(fs.existsSync(path.join(skillDir, relPath))).toBe(true);
    }
  });

  it('has intent files for modified files', () => {
    const expectedIntentFiles = [
      'modify/src/config.ts.intent.md',
      'modify/src/index.ts.intent.md',
      'modify/src/ipc.ts.intent.md',
      'modify/src/container-runner.ts.intent.md',
      'modify/src/ipc-auth.test.ts.intent.md',
      'modify/container/agent-runner/src/ipc-mcp-stdio.ts.intent.md',
    ];

    for (const relPath of expectedIntentFiles) {
      expect(fs.existsSync(path.join(skillDir, relPath))).toBe(true);
    }
  });

  it('runtime skill guides website generation with SpecStream flow', () => {
    const runtimeSkillPath = path.join(
      skillDir,
      'add',
      'container',
      'skills',
      'generative-ui-builder',
      'SKILL.md',
    );
    const content = fs.readFileSync(runtimeSkillPath, 'utf-8');

    expect(content).toContain('name: generative-ui-builder');
    expect(content).toContain('mcp__nanoclaw__update_canvas');
    expect(content).toContain('events_jsonl');
    expect(content).toContain('/root');
    expect(content).toContain('/elements');
    expect(content).toContain('http://127.0.0.1:4318/canvas');
  });

  it('includes upstream json-render helper skills', () => {
    const core = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'skills', 'json-render-core', 'SKILL.md'),
      'utf-8',
    );
    const react = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'skills', 'json-render-react', 'SKILL.md'),
      'utf-8',
    );
    const shadcn = fs.readFileSync(
      path.join(skillDir, 'add', 'container', 'skills', 'json-render-shadcn', 'SKILL.md'),
      'utf-8',
    );

    expect(core).toContain('name: json-render-core');
    expect(react).toContain('name: json-render-react');
    expect(shadcn).toContain('name: json-render-shadcn');
    expect(shadcn).toContain('@json-render/shadcn');
  });
});
