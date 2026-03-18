/**
 * Sync immutable reference files from APP_DIR to DATA_DIR/project-meta/.
 * Agents see project instructions (CLAUDE.md, docs/, skills/) without
 * needing the full application directory mounted.
 */
import fs from "fs";
import path from "path";

import { logger } from "./logger.js";
import { APP_DIR, DATA_DIR } from "./runtime-paths.js";

export function syncProjectMeta(): void {
  const metaDir = path.join(DATA_DIR, "project-meta");
  fs.mkdirSync(metaDir, { recursive: true });

  copyIfExists(path.join(APP_DIR, "CLAUDE.md"), path.join(metaDir, "CLAUDE.md"));

  const docsDir = path.join(APP_DIR, "docs");
  if (fs.existsSync(docsDir)) {
    fs.cpSync(docsDir, path.join(metaDir, "docs"), { recursive: true });
  }

  const skillsDir = path.join(APP_DIR, "container", "skills");
  if (fs.existsSync(skillsDir)) {
    const destSkillsDir = path.join(metaDir, "container", "skills");
    fs.mkdirSync(path.dirname(destSkillsDir), { recursive: true });
    fs.cpSync(skillsDir, destSkillsDir, { recursive: true });
  }

  logger.debug({ metaDir }, "Project meta synced");
}

function copyIfExists(src: string, dst: string): void {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
  }
}
