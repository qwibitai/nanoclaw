// src/memory/shared/remember-tool.ts
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import crypto from 'crypto';
import { candidateDir, ensureMemoryDirs } from './paths.js';
import type { CandidateFrontmatter, FactType } from './types.js';

const VALID_TYPES: FactType[] = ['user', 'feedback', 'project', 'reference'];

export interface RememberInput {
  groupName: string;
  type: FactType;
  name: string;
  body: string;
  description?: string;
  scopes?: string[];
}

export async function rememberTool(
  input: RememberInput,
): Promise<{ slug: string }> {
  if (!VALID_TYPES.includes(input.type)) {
    throw new Error(
      `Invalid type: ${input.type}. Must be one of ${VALID_TYPES.join(', ')}`,
    );
  }
  if (!input.name?.trim() || !input.body?.trim()) {
    throw new Error('name and body are required');
  }

  ensureMemoryDirs();
  const slug = `${input.type}_${slugify(input.name)}`;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex');
  const filename = `${ts}-${input.groupName}-${slugify(input.name)}-${rand}.md`;

  const fm: CandidateFrontmatter = {
    candidate: true,
    type: input.type,
    name: input.name.trim(),
    description: input.description?.trim() ?? input.name.trim(),
    scopes: input.scopes,
    extracted_from: input.groupName,
    extracted_at: new Date().toISOString(),
    turn_excerpt: '(explicit save via remember tool)',
    proposed_action: 'create',
    confidence: 1.0,
  };

  const front = yaml.dump(fm).trimEnd();
  const content = `---\n${front}\n---\n\n${input.body.trim()}\n`;
  fs.writeFileSync(path.join(candidateDir(), filename), content);
  return { slug };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'fact'
  );
}
