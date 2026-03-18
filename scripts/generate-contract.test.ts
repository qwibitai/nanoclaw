/**
 * Tests for the contract manifest generator.
 *
 * INVARIANT: The generated contract must accurately reflect the current
 * source code surfaces. Each surface extraction must find at least the known
 * minimum set of declarations.
 *
 * These tests call generateContract() in-memory — no file writes, no dirty tree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { generateContract } from './generate-contract.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const contractPath = path.join(ROOT, 'contract.json');

describe('contract manifest generator', () => {
  const contract = generateContract() as Record<string, unknown>;
  const surfaces = contract.surfaces as Record<string, unknown>;

  it('produces valid JSON with required top-level fields', () => {
    expect(contract.contractVersion).toBe(1);
    expect(contract.harnessVersion).toBeDefined();
    expect(surfaces).toBeDefined();
  });

  it('does not include generatedAt (eliminates spurious diffs)', () => {
    expect(contract).not.toHaveProperty('generatedAt');
  });

  it('extracts all 7 contract surfaces', () => {
    expect(Object.keys(surfaces).sort()).toEqual([
      'caseSyncAdapter',
      'configSchema',
      'containerRuntime',
      'envVars',
      'ipcTypes',
      'mcpTools',
      'mountPaths',
    ]);
  });

  describe('mcpTools', () => {
    const tools = surfaces.mcpTools as string[];

    it('extracts known core tools', () => {
      expect(tools).toContain('send_message');
      expect(tools).toContain('send_image');
      expect(tools).toContain('send_document');
      expect(tools).toContain('schedule_task');
      expect(tools).toContain('create_case');
      expect(tools).toContain('list_cases');
      expect(tools).toContain('create_github_issue');
    });

    it('is sorted alphabetically', () => {
      expect(tools).toEqual([...tools].sort());
    });
  });

  describe('ipcTypes', () => {
    const types = surfaces.ipcTypes as string[];

    it('extracts known IPC types', () => {
      expect(types).toContain('message');
      expect(types).toContain('image');
      expect(types).toContain('document');
      expect(types).toContain('schedule_task');
      expect(types).toContain('case_create');
      expect(types).toContain('create_github_issue');
    });

    it('is sorted alphabetically', () => {
      expect(types).toEqual([...types].sort());
    });
  });

  describe('mountPaths', () => {
    const paths = surfaces.mountPaths as string[];

    it('extracts known mount paths', () => {
      expect(paths).toContain('/workspace/project');
      expect(paths).toContain('/workspace/group');
      expect(paths).toContain('/workspace/global');
      expect(paths).toContain('/workspace/ipc');
      expect(paths).toContain('/workspace/case');
      expect(paths).toContain('/home/node/.claude');
    });

    it('is sorted alphabetically', () => {
      expect(paths).toEqual([...paths].sort());
    });
  });

  describe('envVars', () => {
    const vars = surfaces.envVars as string[];

    it('extracts known env vars', () => {
      expect(vars).toContain('TZ');
      expect(vars).toContain('NANOCLAW_CASE_ID');
      expect(vars).toContain('ANTHROPIC_API_KEY');
      expect(vars).toContain('HOME');
      expect(vars).toContain('AGENT_BROWSER_EXECUTABLE_PATH');
    });

    it('is sorted alphabetically', () => {
      expect(vars).toEqual([...vars].sort());
    });
  });

  describe('configSchema', () => {
    const schema = surfaces.configSchema as Record<string, string>;

    it('includes escalation config', () => {
      expect(schema['config/escalation.yaml']).toBeDefined();
    });

    it('includes materials config', () => {
      expect(schema['config/materials.json']).toBeDefined();
    });
  });

  describe('caseSyncAdapter', () => {
    const methods = surfaces.caseSyncAdapter as string[];

    it('extracts all adapter methods', () => {
      expect(methods).toContain('createCase');
      expect(methods).toContain('updateCase');
      expect(methods).toContain('addComment');
      expect(methods).toContain('closeCase');
    });

    it('has exactly 4 methods', () => {
      expect(methods).toHaveLength(4);
    });
  });

  describe('containerRuntime', () => {
    const runtime = surfaces.containerRuntime as Record<string, unknown>;

    it('extracts base image', () => {
      expect(runtime.baseImage).toBe('node:22-slim');
    });

    it('extracts system packages', () => {
      const pkgs = runtime.systemPackages as string[];
      expect(pkgs).toContain('chromium');
      expect(pkgs).toContain('git');
      expect(pkgs).toContain('poppler-utils');
      expect(pkgs).toContain('ghostscript');
      expect(pkgs).toContain('gh');
    });

    it('extracts python packages', () => {
      const pkgs = runtime.pythonPackages as string[];
      expect(pkgs.length).toBeGreaterThan(0);
      expect(pkgs.some((p: string) => p.startsWith('Pillow'))).toBe(true);
    });

    it('extracts global npm packages', () => {
      const pkgs = runtime.globalNpmPackages as string[];
      expect(pkgs).toContain('agent-browser');
      expect(pkgs).toContain('@anthropic-ai/claude-code');
    });
  });
});

describe('contract:check — surface comparison logic', () => {
  it('generated surfaces match committed contract.json', () => {
    const generated = generateContract() as Record<string, unknown>;
    const existing = JSON.parse(fs.readFileSync(contractPath, 'utf-8'));

    const genSurfaces = JSON.stringify(generated.surfaces, null, 2);
    const existSurfaces = JSON.stringify(existing.surfaces, null, 2);

    expect(genSurfaces).toBe(existSurfaces);
  });

  it('detects when surfaces differ', () => {
    const generated = generateContract() as Record<string, unknown>;
    const tampered = JSON.parse(JSON.stringify(generated));
    (tampered.surfaces as Record<string, unknown[]>).mcpTools.push(
      'fake_tool_for_test',
    );

    const genSurfaces = JSON.stringify(generated.surfaces, null, 2);
    const tamperedSurfaces = JSON.stringify(tampered.surfaces, null, 2);

    expect(genSurfaces).not.toBe(tamperedSurfaces);
  });
});
