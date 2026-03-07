import fs from 'fs';
import path from 'path';

export type AgentIdentity = {
  name?: string;
  emoji?: string;
  creature?: string;
  vibe?: string;
  avatar?: string;
};

const IDENTITY_PLACEHOLDERS = new Set([
  'pick something you like',
  'ai? robot? familiar? ghost in the machine? something weirder?',
  'how do you come across? sharp? warm? chaotic? calm?',
  'your signature - pick one that feels right',
  'workspace-relative path, http(s) url, or data uri',
]);

function normalizePlaceholderCheck(value: string): string {
  return value
    .trim()
    .replace(/^[*_]+|[*_]+$/g, '')
    .replace(/^\(|\)$/g, '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

export function parseIdentityMarkdown(content: string): AgentIdentity {
  const identity: AgentIdentity = {};
  for (const line of content.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^\s*-\s*/, '');
    const colonIdx = cleaned.indexOf(':');
    if (colonIdx === -1) continue;

    const label = cleaned
      .slice(0, colonIdx)
      .replace(/[*_]/g, '')
      .trim()
      .toLowerCase();
    const raw = cleaned.slice(colonIdx + 1).trim();
    const value = raw.replace(/^[*_]+|[*_]+$/g, '').trim();

    if (!value || IDENTITY_PLACEHOLDERS.has(normalizePlaceholderCheck(value)))
      continue;

    if (label === 'name') identity.name = value;
    else if (label === 'emoji') identity.emoji = value;
    else if (label === 'creature') identity.creature = value;
    else if (label === 'vibe') identity.vibe = value;
    else if (label === 'avatar') identity.avatar = value;
  }
  return identity;
}

export function loadAgentIdentity(
  projectRoot: string = process.cwd(),
): AgentIdentity | null {
  const identityPath = path.join(projectRoot, 'groups', 'main', 'IDENTITY.md');
  try {
    const content = fs.readFileSync(identityPath, 'utf-8');
    const parsed = parseIdentityMarkdown(content);
    const hasValues = Object.values(parsed).some(Boolean);
    return hasValues ? parsed : null;
  } catch {
    return null;
  }
}

const _identity = loadAgentIdentity();

export function getAssistantName(): string {
  return _identity?.name ?? 'Andy';
}
