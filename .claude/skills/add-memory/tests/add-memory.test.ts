import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

describe('add-memory skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid SKILL.md with frontmatter', () => {
    const skillPath = path.join(skillDir, 'SKILL.md');
    expect(fs.existsSync(skillPath)).toBe(true);
    const content = fs.readFileSync(skillPath, 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: add-memory');
    expect(content).toContain('description:');
  });

  it('has a valid manifest.yaml', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf-8');
    const manifest = yaml.parse(content);
    expect(manifest.skill).toBe('add-memory');
    expect(manifest.version).toBe('1.0.0');
    expect(manifest.adds).toContain('src/memory.ts');
    expect(manifest.modifies).toEqual(
      expect.arrayContaining([
        'src/db.ts',
        'src/index.ts',
        'src/ipc.ts',
        'src/task-scheduler.ts',
      ]),
    );
    expect(manifest.structured.npm_dependencies).toHaveProperty('sqlite-vec');
    expect(manifest.structured.npm_dependencies).toHaveProperty(
      '@huggingface/transformers',
    );
  });

  it('has all files listed in adds/', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const addedFile of manifest.adds) {
      const filePath = path.join(skillDir, 'add', addedFile);
      expect(
        fs.existsSync(filePath),
        `add/${addedFile} should exist`,
      ).toBe(true);
    }
  });

  it('has all files listed in modifies/', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const modifiedFile of manifest.modifies) {
      const filePath = path.join(skillDir, 'modify', modifiedFile);
      expect(
        fs.existsSync(filePath),
        `modify/${modifiedFile} should exist`,
      ).toBe(true);
    }
  });

  it('has intent files for all modified files', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    const manifest = yaml.parse(fs.readFileSync(manifestPath, 'utf-8'));
    for (const modifiedFile of manifest.modifies) {
      const intentPath = path.join(
        skillDir,
        'modify',
        `${modifiedFile}.intent.md`,
      );
      expect(
        fs.existsSync(intentPath),
        `modify/${modifiedFile}.intent.md should exist`,
      ).toBe(true);
      const content = fs.readFileSync(intentPath, 'utf-8');
      expect(content).toContain('## What changed');
      expect(content).toContain('## Invariants');
      expect(content).toContain('## Must-keep');
    }
  });

  it('memory.ts exports key functions', () => {
    const memoryPath = path.join(skillDir, 'add', 'src', 'memory.ts');
    const content = fs.readFileSync(memoryPath, 'utf-8');

    // Core exports needed by other modified files
    expect(content).toContain('export function initMemorySchema');
    expect(content).toContain('export async function retrieveMemoryContext');
    expect(content).toContain('export async function embedConversationMessages');
    expect(content).toContain('export function buildMemorySnapshot');
    expect(content).toContain('export async function addCoreMemoryWithEmbedding');
    expect(content).toContain('export async function updateCoreMemoryWithEmbedding');
    expect(content).toContain('export function removeCoreMemory');
    expect(content).toContain('export async function searchAllMemory');
  });

  it('modified db.ts loads sqlite-vec extension', () => {
    const dbPath = path.join(skillDir, 'modify', 'src', 'db.ts');
    const content = fs.readFileSync(dbPath, 'utf-8');
    expect(content).toContain("import * as sqliteVec from 'sqlite-vec'");
    expect(content).toContain('sqliteVec.load(db)');
    expect(content).toContain('export function getDb()');
  });

  it('modified index.ts integrates memory system', () => {
    const indexPath = path.join(skillDir, 'modify', 'src', 'index.ts');
    const content = fs.readFileSync(indexPath, 'utf-8');

    // Memory imports
    expect(content).toContain("from './memory.js'");
    expect(content).toContain('initMemorySchema');
    expect(content).toContain('retrieveMemoryContext');
    expect(content).toContain('embedConversationMessages');
    expect(content).toContain('buildMemorySnapshot');

    // Memory schema initialization in main()
    expect(content).toContain('initMemorySchema()');

    // RAG context retrieval in processGroupMessages
    expect(content).toContain(
      'await retrieveMemoryContext(group.folder, missedMessages)',
    );

    // Conversation embedding
    expect(content).toContain(
      'embedConversationMessages(group.folder, chatJid, missedMessages)',
    );

    // Memory snapshot writing
    expect(content).toContain('memory_snapshot.json');

    // Preserves upstream patterns
    expect(content).toContain('group.isMain === true');
    expect(content).toContain("from './sender-allowlist.js'");
    expect(content).toContain("from './channels/registry.js'");
  });

  it('modified ipc.ts adds memory IPC handlers', () => {
    const ipcPath = path.join(skillDir, 'modify', 'src', 'ipc.ts');
    const content = fs.readFileSync(ipcPath, 'utf-8');

    // Memory imports
    expect(content).toContain("from './memory.js'");
    expect(content).toContain('addCoreMemoryWithEmbedding');
    expect(content).toContain('searchAllMemory');

    // Memory IPC processing
    expect(content).toContain('processMemoryIpc');
    expect(content).toContain("case 'memory_add'");
    expect(content).toContain("case 'memory_update'");
    expect(content).toContain("case 'memory_remove'");
    expect(content).toContain("case 'memory_search'");

    // Preserves upstream patterns
    expect(content).toContain('syncGroups');
    expect(content).toContain('folderIsMain');
    expect(content).toContain('group.isMain');
  });

  it('modified task-scheduler.ts injects memory context', () => {
    const schedulerPath = path.join(
      skillDir,
      'modify',
      'src',
      'task-scheduler.ts',
    );
    const content = fs.readFileSync(schedulerPath, 'utf-8');

    // Memory imports
    expect(content).toContain("from './memory.js'");
    expect(content).toContain('retrieveMemoryContext');
    expect(content).toContain('buildMemorySnapshot');

    // Memory context retrieval
    expect(content).toContain('memoryContext');
    expect(content).toContain('memoryContext + task.prompt');

    // Memory snapshot
    expect(content).toContain('memory_snapshot.json');

    // Preserves upstream patterns
    expect(content).toContain('computeNextRun');
    expect(content).toContain('group.isMain === true');
    expect(content).toContain('resolveGroupIpcPath');
  });
});
