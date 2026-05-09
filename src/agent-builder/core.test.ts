import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-agent-builder',
    GROUPS_DIR: '/tmp/nanoclaw-test-agent-builder/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-agent-builder';

import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../db/index.js';
import {
  applyDraft,
  createDraft,
  diffDraftAgainstTarget,
  discardDraft,
  ensureDraftMessagingGroup,
  ensureDraftWiring,
  getDraftStatus,
  listAgentGroups,
  listDrafts,
  PLAYGROUND_CHANNEL,
} from './core.js';
import { getMessagingGroupAgentByPair, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { deleteAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';

const TARGET_FOLDER = 'agent-x';
const DRAFT_FOLDER = 'draft_agent-x';

function setupTargetGroup(provider: string | null = null, model: string | null = null): void {
  const dir = path.join(TEST_DIR, 'groups', TARGET_FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'CLAUDE.local.md'), '# Original persona\n');
  fs.writeFileSync(
    path.join(dir, 'container.json'),
    JSON.stringify({ skills: 'all', mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [] }),
  );
  createAgentGroup({
    id: 'ag_target',
    name: TARGET_FOLDER,
    folder: TARGET_FOLDER,
    agent_provider: provider,
    model,
    created_at: new Date().toISOString(),
  });
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEST_DIR, 'groups'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('listAgentGroups', () => {
  it('returns non-draft groups only', () => {
    setupTargetGroup();
    createAgentGroup({
      id: 'ag_draft',
      name: DRAFT_FOLDER,
      folder: DRAFT_FOLDER,
      agent_provider: null,
      model: null,
      created_at: new Date().toISOString(),
    });
    const list = listAgentGroups();
    expect(list).toHaveLength(1);
    expect(list[0].folder).toBe(TARGET_FOLDER);
  });
});

describe('createDraft', () => {
  it('creates a draft folder + DB row + copies persona/container.json', () => {
    setupTargetGroup('codex', 'gpt-5.5');
    const draft = createDraft(TARGET_FOLDER);

    expect(draft.folder).toBe(DRAFT_FOLDER);
    expect(draft.agent_provider).toBe('codex');
    expect(draft.model).toBe('gpt-5.5');

    const draftPersona = fs.readFileSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'CLAUDE.local.md'), 'utf8');
    expect(draftPersona).toBe('# Original persona\n');
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'container.json'))).toBe(true);
    expect(getAgentGroupByFolder(DRAFT_FOLDER)?.id).toBe(draft.id);
  });

  it('throws if target does not exist', () => {
    expect(() => createDraft('does-not-exist')).toThrow(/not found/i);
  });

  it('throws if a draft already exists for that target', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    expect(() => createDraft(TARGET_FOLDER)).toThrow(/already exists/i);
  });

  it('refuses to draft a draft', () => {
    expect(() => createDraft(DRAFT_FOLDER)).toThrow(/cannot draft a draft/i);
  });
});

describe('listDrafts', () => {
  it('pairs draft with its target', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    const drafts = listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft.folder).toBe(DRAFT_FOLDER);
    expect(drafts[0].target?.folder).toBe(TARGET_FOLDER);
  });

  it('returns null target when target deleted', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    const target = getAgentGroupByFolder(TARGET_FOLDER);
    if (target) deleteAgentGroup(target.id);
    const drafts = listDrafts();
    expect(drafts).toHaveLength(1);
    expect(drafts[0].target).toBeNull();
  });
});

describe('applyDraft', () => {
  it('writes draft persona back to target and discards draft by default', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    fs.writeFileSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'CLAUDE.local.md'), '# Edited persona\n');

    applyDraft(DRAFT_FOLDER);

    const targetPersona = fs.readFileSync(path.join(TEST_DIR, 'groups', TARGET_FOLDER, 'CLAUDE.local.md'), 'utf8');
    expect(targetPersona).toBe('# Edited persona\n');
    expect(getAgentGroupByFolder(DRAFT_FOLDER)).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER))).toBe(false);
  });

  it('keeps the draft when keepDraft=true', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    fs.writeFileSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'CLAUDE.local.md'), '# Edited persona\n');
    applyDraft(DRAFT_FOLDER, { keepDraft: true });
    expect(getAgentGroupByFolder(DRAFT_FOLDER)).toBeDefined();
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER))).toBe(true);
  });
});

describe('discardDraft', () => {
  it('deletes row, folder, and playground messaging_group', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    ensureDraftWiring(DRAFT_FOLDER); // creates mg + mga
    expect(getMessagingGroupByPlatform(PLAYGROUND_CHANNEL, `playground:${DRAFT_FOLDER}`)).toBeDefined();

    discardDraft(DRAFT_FOLDER);

    expect(getAgentGroupByFolder(DRAFT_FOLDER)).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER))).toBe(false);
    expect(getMessagingGroupByPlatform(PLAYGROUND_CHANNEL, `playground:${DRAFT_FOLDER}`)).toBeUndefined();
  });

  it('is idempotent on a non-existent draft', () => {
    expect(() => discardDraft('draft_nope')).not.toThrow();
  });
});

describe('diffDraftAgainstTarget', () => {
  it('flags persona changes', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    fs.writeFileSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'CLAUDE.local.md'), '# Edited\n');
    const diff = diffDraftAgainstTarget(DRAFT_FOLDER);
    expect(diff.personaChanged).toBe(true);
    expect(diff.containerJsonChanged).toBe(false);
  });
});

describe('getDraftStatus', () => {
  it('clean draft is not dirty', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    const status = getDraftStatus(DRAFT_FOLDER);
    expect(status).toEqual({ exists: true, dirty: false, targetExists: true });
  });

  it('detects edited draft as dirty', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    fs.writeFileSync(path.join(TEST_DIR, 'groups', DRAFT_FOLDER, 'CLAUDE.local.md'), '# Edited\n');
    expect(getDraftStatus(DRAFT_FOLDER).dirty).toBe(true);
  });

  it('targetExists=false when target removed', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    const target = getAgentGroupByFolder(TARGET_FOLDER);
    if (target) deleteAgentGroup(target.id);
    expect(getDraftStatus(DRAFT_FOLDER).targetExists).toBe(false);
  });
});

describe('ensureDraftMessagingGroup', () => {
  it('creates a playground messaging_group on first call, returns same on second', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    const first = ensureDraftMessagingGroup(DRAFT_FOLDER);
    expect(first.channel_type).toBe('playground');
    expect(first.platform_id).toBe(`playground:${DRAFT_FOLDER}`);

    const second = ensureDraftMessagingGroup(DRAFT_FOLDER);
    expect(second.id).toBe(first.id);
  });
});

describe('ensureDraftWiring', () => {
  it('creates a wiring with engage_pattern="." (always engages)', () => {
    setupTargetGroup();
    const draft = createDraft(TARGET_FOLDER);
    ensureDraftWiring(DRAFT_FOLDER);

    const mg = getMessagingGroupByPlatform(PLAYGROUND_CHANNEL, `playground:${DRAFT_FOLDER}`);
    expect(mg).toBeDefined();
    const wiring = getMessagingGroupAgentByPair(mg!.id, draft.id);
    expect(wiring).toBeDefined();
    expect(wiring?.engage_mode).toBe('pattern');
    expect(wiring?.engage_pattern).toBe('.');
    expect(wiring?.sender_scope).toBe('all');
  });

  it('is idempotent', () => {
    setupTargetGroup();
    createDraft(TARGET_FOLDER);
    ensureDraftWiring(DRAFT_FOLDER);
    expect(() => ensureDraftWiring(DRAFT_FOLDER)).not.toThrow();
  });
});
