// Generate a skill index from SKILL.md frontmatter.
// Reads all container/skills SKILL.md files, extracts name and description
// from YAML frontmatter, and writes a single INDEX.md file.
// Usage: npx tsx scripts/generate-skill-index.ts

import fs from 'fs';
import path from 'path';

interface SkillMeta {
  name: string;
  description: string;
  dirName: string;
}

function extractFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string> = {};
  let currentKey = '';
  let currentValue = '';

  for (const line of match[1].split('\n')) {
    // Handle multi-line values (YAML folded/literal or continuation)
    if (/^\s/.test(line) && currentKey) {
      currentValue += ' ' + line.trim();
      frontmatter[currentKey] = currentValue;
      continue;
    }

    const kvMatch = line.match(/^(\w[\w-]*):\s*>?\s*(.*)/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      currentValue = kvMatch[2].trim();
      frontmatter[currentKey] = currentValue;
    }
  }

  return frontmatter;
}

export function generateSkillIndex(skillsDir: string): string {
  const skills: SkillMeta[] = [];

  if (!fs.existsSync(skillsDir)) {
    return '# Available Skills\n\nNo skills found.\n';
  }

  for (const entry of fs.readdirSync(skillsDir)) {
    const skillDir = path.join(skillsDir, entry);
    if (!fs.statSync(skillDir).isDirectory()) continue;

    const skillFile = path.join(skillDir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const content = fs.readFileSync(skillFile, 'utf-8');
    const fm = extractFrontmatter(content);

    if (fm.name && fm.description) {
      skills.push({
        name: fm.name,
        description: fm.description,
        dirName: entry,
      });
    }
  }

  // Sort alphabetically by name
  skills.sort((a, b) => a.name.localeCompare(b.name));

  const lines = [
    '# Available Skills',
    '',
    'The following skills are available. Before acting on a task, check if a',
    'skill applies. To use a skill, read its full SKILL.md file first:',
    '',
    '```',
    'Read /workspace/skills/<skill-dir>/SKILL.md',
    '```',
    '',
    'Then follow the skill instructions exactly.',
    '',
  ];

  for (const skill of skills) {
    lines.push(`- **${skill.name}** (\`${skill.dirName}/\`): ${skill.description}`);
  }

  lines.push('');
  lines.push('Always read the full SKILL.md before proceeding — the index only shows summaries.');
  lines.push('');

  return lines.join('\n');
}

// CLI entry point
if (process.argv[1]?.endsWith('generate-skill-index.ts')) {
  const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const skillsDir = path.join(projectRoot, 'container', 'skills');
  const outputPath = path.join(skillsDir, 'INDEX.md');

  const index = generateSkillIndex(skillsDir);
  fs.writeFileSync(outputPath, index);
  console.log(`Generated skill index at ${outputPath}`);
  console.log(index);
}
