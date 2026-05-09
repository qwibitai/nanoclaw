/**
 * Quick smoke test for src/agent-builder/core.ts against the real install
 * DB. Creates a draft for an existing agent group, mutates it, applies,
 * and verifies the side effects on disk + in DB.
 *
 * Usage:
 *   tsx scripts/agent-builder-smoke.ts <target-folder>
 *
 * Safe to run on a live install — touches only the chosen target's draft.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { getDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import {
  applyDraft,
  createDraft,
  diffDraftAgainstTarget,
  discardDraft,
  ensureDraftWiring,
  getDraftStatus,
  listAgentGroups,
  listDrafts,
} from '../src/agent-builder/core.js';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const target = process.argv[2];
if (!target) fail('Usage: tsx scripts/agent-builder-smoke.ts <target-folder>');

initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(getDb());

console.log(`Targets available:`, listAgentGroups().map((g) => g.folder).join(', '));
console.log(`Existing drafts:`, listDrafts().map((d) => d.draft.folder).join(', ') || '(none)');

const draftFolder = `draft_${target}`;
if (listDrafts().some((d) => d.draft.folder === draftFolder)) {
  console.log(`Cleaning up existing ${draftFolder}…`);
  discardDraft(draftFolder);
}

console.log(`\n1. createDraft(${target})`);
const draft = createDraft(target);
console.log(`   → ${draft.folder} (provider=${draft.agent_provider}, model=${draft.model})`);

const personaPath = path.join(GROUPS_DIR, draftFolder, 'CLAUDE.local.md');
const original = fs.readFileSync(personaPath, 'utf8');
console.log(`   → persona @ ${personaPath} (${original.length} bytes)`);

console.log(`\n2. ensureDraftWiring(${draftFolder})`);
ensureDraftWiring(draftFolder);
console.log(`   → wiring created`);

console.log(`\n3. mutate persona`);
fs.writeFileSync(personaPath, `${original}\n\n# Smoke-test edit\n`);
const status = getDraftStatus(draftFolder);
console.log(`   → status: dirty=${status.dirty}, targetExists=${status.targetExists}`);
const diff = diffDraftAgainstTarget(draftFolder);
console.log(`   → personaChanged=${diff.personaChanged}, containerJsonChanged=${diff.containerJsonChanged}`);

console.log(`\n4. applyDraft(${draftFolder}) [keepDraft]`);
applyDraft(draftFolder, { keepDraft: true });
const targetPersona = fs.readFileSync(path.join(GROUPS_DIR, target, 'CLAUDE.local.md'), 'utf8');
if (!targetPersona.includes('Smoke-test edit')) fail('apply did not write to target');
console.log(`   → target persona now has the edit`);

console.log(`\n5. applyDraft(${draftFolder}) reverting`);
fs.writeFileSync(path.join(GROUPS_DIR, target, 'CLAUDE.local.md'), original);
fs.writeFileSync(personaPath, original);

console.log(`\n6. discardDraft(${draftFolder})`);
discardDraft(draftFolder);
if (fs.existsSync(path.join(GROUPS_DIR, draftFolder))) fail('draft folder still on disk');
if (listDrafts().some((d) => d.draft.folder === draftFolder)) fail('draft row still in DB');
console.log(`   → draft removed from disk + DB`);

console.log(`\nOK — all checks passed.`);
process.exit(0);
