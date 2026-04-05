import fs from 'fs';
import path from 'path';
import {
  SKILLS_DIR,
  KNOWLEDGE_DIR,
  OPERATORS_DIR,
  OPERATOR_SLUG,
  ASSISTANT_NAME,
  OPERATOR_NAME,
  WORKSPACE_DIR,
} from '../shared/config.js';
import { logger } from '../shared/logger.js';

function readFilesRecursive(dir: string, ext: string): { path: string; content: string }[] {
  const results: { path: string; content: string }[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readFilesRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push({ path: fullPath, content: fs.readFileSync(fullPath, 'utf-8') });
    }
  }
  return results;
}

export function buildWorkspace(groupId: string): {
  cwd: string;
  systemPrompt: string;
} {
  const workDir = path.join(WORKSPACE_DIR, groupId);
  fs.mkdirSync(workDir, { recursive: true });

  // Read operator context
  const contextPath = path.join(OPERATORS_DIR, OPERATOR_SLUG, 'context.md');
  const operatorContext = fs.existsSync(contextPath)
    ? fs.readFileSync(contextPath, 'utf-8')
    : `Operator: ${OPERATOR_NAME}`;

  // Read all skills
  const skills = readFilesRecursive(SKILLS_DIR, '.md');
  const skillsSection = skills.length > 0
    ? skills.map(s => {
        const name = path.basename(path.dirname(s.path));
        return `### Skill: ${name}\n\n${s.content}`;
      }).join('\n\n---\n\n')
    : 'No skills loaded.';

  // Read all knowledge
  const knowledge = readFilesRecursive(KNOWLEDGE_DIR, '.md');
  const knowledgeSection = knowledge.length > 0
    ? knowledge.map(k => {
        const rel = path.relative(KNOWLEDGE_DIR, k.path);
        return `### ${rel}\n\n${k.content}`;
      }).join('\n\n---\n\n')
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
  fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), claudeMd);

  // Copy skills and knowledge into workspace so agent can Read them
  const wsSkills = path.join(workDir, 'skills');
  const wsKnowledge = path.join(workDir, 'knowledge');
  if (fs.existsSync(SKILLS_DIR)) {
    fs.cpSync(SKILLS_DIR, wsSkills, { recursive: true });
  }
  if (fs.existsSync(KNOWLEDGE_DIR)) {
    fs.cpSync(KNOWLEDGE_DIR, wsKnowledge, { recursive: true });
  }

  logger.info(
    { groupId, skills: skills.length, knowledge: knowledge.length },
    'Workspace built',
  );

  // The system prompt is the operator context appended to the claude_code preset
  return {
    cwd: workDir,
    systemPrompt: operatorContext,
  };
}
