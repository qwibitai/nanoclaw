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
import { isMemoryEnabled } from '../shared/memory-client.ts';
import { logger } from '../shared/logger.ts';
import * as store from '../shared/store-client.ts';

function dirExists(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

function fileExists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
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

function readOperatorContext(): string {
  const contextPath = resolve(OPERATORS_DIR, OPERATOR_SLUG, 'context.md');
  try {
    return Deno.readTextFileSync(contextPath);
  } catch {
    return `Operator: ${OPERATOR_NAME}`;
  }
}

export function buildWorkspace(groupId: string): {
  cwd: string;
  systemPrompt: string;
} {
  const workDir = resolve(WORKSPACE_DIR, groupId);
  Deno.mkdirSync(workDir, { recursive: true });

  const operatorContext = readOperatorContext();

  // Reuse workspace if CLAUDE.md already exists (built on first message)
  const claudeMdPath = resolve(workDir, 'CLAUDE.md');
  if (fileExists(claudeMdPath)) {
    logger.debug({ groupId }, 'Workspace reused');
    return { cwd: workDir, systemPrompt: operatorContext };
  }

  // First message in session — build CLAUDE.md
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

  const memorySection = isMemoryEnabled()
    ? `## Your Memory

You have persistent long-term memory powered by Supermemory. This memory is shared
across ALL channels (web-chat, Discord, email) and ALL sessions. When you recall
something from memory, it may have been learned on a different channel or in a
different conversation — not necessarily a "previous session."

When referencing recalled information:
- Say "from memory" or "I recall" — not "from a previous session"
- Do not assume which channel the memory came from unless the metadata says so
- Memories tagged in <nexus-memory> blocks are injected before each message you receive
- New facts and decisions from your conversations are automatically captured to memory
`
    : '';

  const claudeMd = `# ${ASSISTANT_NAME}

You are ${ASSISTANT_NAME}, the AI assistant for ${OPERATOR_NAME}.

## Your Operator

${operatorContext}
${memorySection}
## Available Skills

${skillsSection}

## Knowledge Base

${knowledgeSection}
`;

  Deno.writeTextFileSync(claudeMdPath, claudeMd);

  logger.info(
    { groupId, skills: skills.length, knowledge: knowledge.length },
    'Workspace built',
  );

  return {
    cwd: workDir,
    systemPrompt: operatorContext,
  };
}

/**
 * Delete workspace directories for sessions inactive for more than 7 days.
 * Called once at agent startup.
 */
export async function cleanupOldWorkspaces(): Promise<void> {
  if (!dirExists(WORKSPACE_DIR)) return;

  const sessions = await store.listSessions();
  const sessionMap = new Map(sessions.map((s) => [s.id, s]));
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  let cleaned = 0;

  for (const entry of Deno.readDirSync(WORKSPACE_DIR)) {
    if (!entry.isDirectory) continue;
    const session = sessionMap.get(entry.name);
    const isStale =
      !session || new Date(session.lastActivity).getTime() < cutoff;

    if (isStale) {
      const dir = resolve(WORKSPACE_DIR, entry.name);
      try {
        Deno.removeSync(dir, { recursive: true });
        cleaned++;
      } catch {
        // ignore cleanup errors
      }
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Old workspaces cleaned up');
  }
}
