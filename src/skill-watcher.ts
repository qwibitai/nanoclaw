/**
 * Skill watcher — monitors container/skills/ for new or removed skill
 * directories and kills running containers so they respawn with updated
 * skill symlinks on the next inbound message.
 *
 * Skills are synced into .claude-shared/skills/ on every container spawn
 * (container-runner.ts syncSkillSymlinks), so a simple kill is enough —
 * the host sweep will wake a fresh container when the next message arrives.
 */
import fs from 'fs';
import path from 'path';

import { getActiveSessions } from './db/sessions.js';
import { isContainerRunning, killContainer } from './container-runner.js';
import { log } from './log.js';

const SKILLS_DIR = path.join(process.cwd(), 'container', 'skills');
const POLL_INTERVAL_MS = 5_000;

function listSkills(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

function reloadRunningContainers(reason: string): void {
  const sessions = getActiveSessions();
  let killed = 0;
  for (const session of sessions) {
    if (isContainerRunning(session.id)) {
      killContainer(session.id, reason);
      killed++;
    }
  }
  if (killed > 0) {
    log.info('Containers reloaded for skill update', { reason, killed });
  }
}

export function startSkillWatcher(): void {
  if (!fs.existsSync(SKILLS_DIR)) {
    log.warn('Skills directory not found — skill watcher disabled', { dir: SKILLS_DIR });
    return;
  }

  let known = listSkills();
  log.info('Skill watcher started', { skillsDir: SKILLS_DIR, count: known.size });

  setInterval(() => {
    const current = listSkills();

    const added = [...current].filter((s) => !known.has(s));
    const removed = [...known].filter((s) => !current.has(s));

    if (added.length === 0 && removed.length === 0) return;

    known = current;

    if (added.length > 0) {
      log.info('New skills detected — reloading containers', { added });
      reloadRunningContainers('skill-update');
    }
    if (removed.length > 0) {
      log.info('Skills removed — reloading containers', { removed });
      reloadRunningContainers('skill-removed');
    }
  }, POLL_INTERVAL_MS);
}
