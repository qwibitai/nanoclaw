import { logger } from '../logger.js';
import { markMatched, queryRules } from './rules-engine.js';

export const ACTION_CLASS_KEYWORDS: Record<string, string[]> = {
  email: ['email.read', 'email.send'],
  gmail: ['email.read', 'email.send'],
  inbox: ['email.read', 'email.send'],
  message: ['email.read', 'email.send'],
  PR: ['github.read', 'github.write'],
  'pull request': ['github.read', 'github.write'],
  github: ['github.read', 'github.write'],
  repo: ['github.read', 'github.write'],
  commit: ['github.read', 'github.write'],
  browser: ['browser.read', 'browser.write'],
  website: ['browser.read', 'browser.write'],
  page: ['browser.read', 'browser.write'],
  navigate: ['browser.read', 'browser.write'],
  click: ['browser.read', 'browser.write'],
  cost: ['cost.read'],
  budget: ['cost.read'],
  spending: ['cost.read'],
  schedule: ['task.schedule'],
  task: ['task.schedule'],
  reminder: ['task.schedule'],
};

export function inferActionClasses(message: string): string[] {
  const lower = message.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, classes] of Object.entries(ACTION_CLASS_KEYWORDS)) {
    if (lower.includes(keyword.toLowerCase())) {
      for (const cls of classes) found.add(cls);
    }
  }
  return Array.from(found);
}

export function buildRulesBlock(message: string, groupId: string): string | null {
  const actionClasses = inferActionClasses(message);
  const rules = queryRules(actionClasses, groupId, 5);
  if (rules.length === 0) return null;

  const header = '## Learned Rules (auto-generated)\n';
  const lines: string[] = [];
  let totalLen = header.length;
  for (const rule of rules) {
    const line = `- ${rule.rule}`;
    if (totalLen + line.length + 1 > 500) break;
    lines.push(line);
    totalLen += line.length + 1;
  }
  if (lines.length === 0) return null;
  for (const rule of rules.slice(0, lines.length)) {
    markMatched(rule.id);
  }
  logger.debug({ groupId, ruleCount: lines.length }, 'Injecting learned rules into prompt');
  return header + lines.join('\n');
}
