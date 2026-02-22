import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { BASE_DIR, CUSTOM_DIR, CAMBOT_AGENT_DIR } from './constants.js';
import { initCambotAgentDir } from './init.js';
import { recordCustomModification } from './state.js';

export function initSkillsSystem(): void {
  initCambotAgentDir();
  console.log('Skills system initialized. .cambot-agent/ directory created.');
}

export function migrateExisting(): void {
  const projectRoot = process.cwd();

  // First, do a fresh init
  initCambotAgentDir();

  // Then, diff current files against base to capture modifications
  const baseSrcDir = path.join(projectRoot, BASE_DIR, 'src');
  const srcDir = path.join(projectRoot, 'src');
  const customDir = path.join(projectRoot, CUSTOM_DIR);
  const patchRelPath = path.join(CUSTOM_DIR, 'migration.patch');

  try {
    let diff: string;
    try {
      diff = execFileSync('diff', ['-ruN', baseSrcDir, srcDir], {
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err: unknown) {
      // diff exits 1 when files differ — that's expected
      const execErr = err as { status?: number; stdout?: string };
      if (execErr.status === 1 && execErr.stdout) {
        diff = execErr.stdout;
      } else {
        throw err;
      }
    }

    if (diff.trim()) {
      fs.mkdirSync(customDir, { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, patchRelPath),
        diff,
        'utf-8',
      );

      // Extract modified file paths from the diff
      const filesModified = [...diff.matchAll(/^diff -ruN .+ (.+)$/gm)]
        .map((m) => path.relative(projectRoot, m[1]))
        .filter((f) => !f.startsWith('.cambot-agent'));

      // Record in state so the patch is visible to the tracking system
      recordCustomModification(
        'Pre-skills migration',
        filesModified,
        patchRelPath,
      );

      console.log(
        'Custom modifications captured in .cambot-agent/custom/migration.patch',
      );
    } else {
      console.log('No custom modifications detected.');
    }
  } catch {
    console.log('Could not generate diff. Continuing with clean base.');
  }

  console.log('Migration complete. Skills system ready.');
}
