/**
 * Unit tests for the codex provider's auth resolver registry.
 *
 * Default install registers only the instructor host resolver. The
 * class feature (when installed via /add-classroom-auth) registers
 * a per-student resolver in front of it; that integration lives on
 * the `classroom` branch and is exercised there.
 *
 * Tests reset the chain explicitly per scenario via _resetResolversForTest
 * and re-register the resolvers under test, so cross-test pollution
 * from global module-load registration can't sneak in.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { TEST_DIR, FAKE_HOME } = vi.hoisted(() => {
  const nodePath = require('path') as typeof import('path');
  const nodeOs = require('os') as typeof import('os');
  return {
    TEST_DIR: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-codex-resolver-test'),
    FAKE_HOME: nodePath.join(nodeOs.tmpdir(), 'nanoclaw-codex-resolver-test-home'),
  };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { closeDb, getDb, initTestDb, runMigrations } from '../db/index.js';
import { createAgentGroup } from '../db/agent-groups.js';
import {
  _resetResolversForTest,
  instructorHostResolver,
  registerCodexAuthResolver,
  resolveCodexAuthSource,
} from './codex.js';

function nowIso(): string {
  return new Date().toISOString();
}

function clearAll(): void {
  for (const dir of [TEST_DIR, FAKE_HOME]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeInstructorAuth(): string {
  const codexDir = path.join(FAKE_HOME, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  const p = path.join(codexDir, 'auth.json');
  fs.writeFileSync(p, JSON.stringify({ tokens: { access_token: 'instructor-a', refresh_token: 'instructor-r' } }));
  return p;
}

function seedAgentGroup(id: string, folder: string): void {
  createAgentGroup({
    id,
    name: folder,
    folder,
    agent_provider: 'codex',
    model: null,
    created_at: nowIso(),
  });
}

beforeEach(() => {
  clearAll();
  fs.mkdirSync(TEST_DIR, { recursive: true });
  initTestDb();
  runMigrations(getDb());
  _resetResolversForTest();
});

afterEach(() => {
  closeDb();
  clearAll();
});

describe('codex auth resolver chain — instructor-only (default install)', () => {
  beforeEach(() => {
    registerCodexAuthResolver(instructorHostResolver);
  });

  it('returns null when no host auth.json exists', () => {
    seedAgentGroup('ag-1', 'main');
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME })).toBeNull();
  });

  it('resolves to the instructor host auth when present', () => {
    seedAgentGroup('ag-1', 'main');
    const expected = writeInstructorAuth();
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: FAKE_HOME });
    expect(result).toEqual({ name: 'instructor', path: expected });
  });

  it('returns null when hostHome is undefined', () => {
    seedAgentGroup('ag-1', 'main');
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined })).toBeNull();
  });
});

describe('registry semantics', () => {
  it('newest registration wins (unshift order)', () => {
    const callOrder: string[] = [];
    registerCodexAuthResolver(() => {
      callOrder.push('first-registered');
      return null;
    });
    registerCodexAuthResolver(() => {
      callOrder.push('second-registered');
      return { name: 'second', path: '/whatever' };
    });
    const result = resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined });
    // Second registration was prepended, so it ran first and matched —
    // first-registered never got called.
    expect(callOrder).toEqual(['second-registered']);
    expect(result).toEqual({ name: 'second', path: '/whatever' });
  });

  it('returns null when every resolver returns null', () => {
    registerCodexAuthResolver(() => null);
    registerCodexAuthResolver(() => null);
    expect(resolveCodexAuthSource({ agentGroupId: 'ag-1', hostHome: undefined })).toBeNull();
  });
});
