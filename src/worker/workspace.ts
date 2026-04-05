import { basename, dirname, relative, resolve } from '@std/path';
import {
  SKILLS_DIR,
  KNOWLEDGE_DIR,
  OPERATORS_DIR,
  OPERATOR_SLUG,
  ASSISTANT_NAME,
  OPERATOR_NAME,
  WORKSPACE_DIR,
} from '../shared/config.ts';
import { logger } from '../shared/logger.ts';

function dirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function readFilesRecursive(
  dir: string,
  ext: string,
): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  if (!dirExists(dir)) return results;

  for (const entry of Deno.readDirSync(dir)) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory) {
      results.push(...readFilesRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push({
        path: fullPath,
        content: Deno.readTextFileSync(fullPath),
      });
    }
  }
  return results;
}

function copyDirSync(src: string, dest: string): void {
  Deno.mkdirSync(dest, { recursive: true });
  for (const entry of Deno.readDirSync(src)) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory) {
      copyDirSync(srcPath, destPath);
    } else {
      Deno.copyFileSync(srcPath, destPath);
    }
  }
}

export function buildWorkspace(groupId: string): {
  cwd: string;
  systemPrompt: string;
} {
  const workDir = resolve(WORKSPACE_DIR, groupId);
  Deno.mkdirSync(workDir, { recursive: true });

  // Read operator context
  const contextPath = resolve(OPERATORS_DIR, OPERATOR_SLUG, 'context.md');
  let operatorContext: string;
  try {
    operatorContext = Deno.readTextFileSync(contextPath);
  } catch {
    operatorContext = `Operator: ${OPERATOR_NAME}`;
  }

  // Read all skills
  const skills = readFilesRecursive(SKILLS_DIR, '.md');
  const skillsSection =
    skills.length > 0
      ? skills
          .map((s) => {
            const name = basename(dirname(s.path));
            return `### Skill: ${name}\n\n${s.content}`;
          })
          .join('\n\n---\n\n')
      : 'No skills loaded.';

  // Read all knowledge
  const knowledge = readFilesRecursive(KNOWLEDGE_DIR, '.md');
  const knowledgeSection =
    knowledge.length > 0
      ? knowledge
          .map((k) => {
            const rel = relative(KNOWLEDGE_DIR, k.path);
            return `### ${rel}\n\n${k.content}`;
          })
          .join('\n\n---\n\n')
      : 'No knowledge files loaded.';

  // Build CLAUDE.md
  const claudeMd = `# ${ASSISTANT_NAME}

You are ${ASSISTANT_NAME}, the AI assistant for ${OPERATOR_NAME}.

## Your Operator

${operatorContext}

## Available Skills

${skillsSection}

## Knowledge Base

${knowledgeSection}
`;

  // Write CLAUDE.md to workspace
  Deno.writeTextFileSync(resolve(workDir, 'CLAUDE.md'), claudeMd);

  // Copy skills and knowledge into workspace so agent can Read them
  if (dirExists(SKILLS_DIR)) {
    copyDirSync(SKILLS_DIR, resolve(workDir, 'skills'));
  }
  if (dirExists(KNOWLEDGE_DIR)) {
    copyDirSync(KNOWLEDGE_DIR, resolve(workDir, 'knowledge'));
  }

  logger.info(
    { groupId, skills: skills.length, knowledge: knowledge.length },
    'Workspace built',
  );

  return {
    cwd: workDir,
    systemPrompt: operatorContext,
  };
}
