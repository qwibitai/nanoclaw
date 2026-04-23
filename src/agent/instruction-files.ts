import fs from 'fs';
import path from 'path';

export const PRIMARY_INSTRUCTION_FILE = 'CLAUDE.md';
export const COMPAT_INSTRUCTION_FILE = 'AGENTS.md';
export const INSTRUCTION_FILES = [
  PRIMARY_INSTRUCTION_FILE,
  COMPAT_INSTRUCTION_FILE,
] as const;

function ensureFileAlias(
  sourcePath: string,
  targetPath: string,
  relativeLinkTarget: string,
): void {
  if (fs.existsSync(targetPath)) return;

  try {
    fs.symlinkSync(relativeLinkTarget, targetPath);
  } catch {
    fs.copyFileSync(sourcePath, targetPath);
  }
}

export function ensureInstructionAliases(dir: string): void {
  const existingName = INSTRUCTION_FILES.find((name) =>
    fs.existsSync(path.join(dir, name)),
  );
  if (!existingName) return;

  const sourcePath = path.join(dir, existingName);
  for (const name of INSTRUCTION_FILES) {
    if (name === existingName) continue;
    ensureFileAlias(sourcePath, path.join(dir, name), existingName);
  }
}

export function writeInstructionFiles(dir: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of INSTRUCTION_FILES) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}
