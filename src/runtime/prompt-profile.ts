import fs from 'fs';
import path from 'path';

import { GROUPS_DIR, NANOCLAW_CONFIG_DIR } from '../core/config.js';
import { logger } from '../core/logger.js';
import { isValidGroupFolder } from '../platform/group-folder.js';

type PromptSectionName =
  | 'RUNTIME_RULES'
  | 'PERSONAL_PROFILE'
  | 'GLOBAL_CONTEXT'
  | 'GROUP_CONTEXT';

const PERSONAL_PROFILE_FILENAME = 'CLAUDE.md';

const EXPECTED_PROFILE_SECTIONS = [
  'Identity',
  'Voice',
  'Operating Rules',
  'User Preferences',
  'Privacy Rules',
  'Tool Conventions',
] as const;

export const DEFAULT_PROMPT_SECTION_BUDGETS: Readonly<
  Record<PromptSectionName, number>
> = {
  RUNTIME_RULES: 1200,
  PERSONAL_PROFILE: 12000,
  GLOBAL_CONTEXT: 3600,
  GROUP_CONTEXT: 3600,
};

export const DEFAULT_PROMPT_TOTAL_BUDGET = 22000;

const RUNTIME_RULES_BLOCK = [
  '# NanoClaw Runtime Rules',
  '- Follow NanoClaw safety and execution constraints exactly.',
  '- Keep static profile behavior separate from dynamic memory context.',
  '- Treat group boundaries as strict isolation boundaries unless explicitly overridden by host policy.',
].join('\n');

const DEFAULT_PROFILE_TEMPLATE = `# CLAUDE.md\n\n## Identity\nDescribe who the assistant is and what it should optimize for.\n\n## Voice\nDefine tone, communication style, and formatting defaults.\n\n## Operating Rules\nList stable behavior rules, priorities, and non-negotiable constraints.\n\n## User Preferences\nCapture durable preferences that should apply broadly across tasks.\n\n## Privacy Rules\nSpecify what must remain private and any data handling constraints.\n\n## Tool Conventions\nDefine tool usage conventions and verification expectations.\n`;

export interface CompilePromptProfileOptions {
  groupFolder: string;
}

export interface PromptProfileServiceOptions {
  configDir?: string;
  groupsDir?: string;
  sectionBudgets?: Partial<Record<PromptSectionName, number>>;
  totalBudget?: number;
}

interface PromptSection {
  name: PromptSectionName;
  source: string;
  content: string;
}

interface MarkdownSection {
  heading: string;
  body: string;
}

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trim();
}

function truncateDeterministically(content: string, budget: number): string {
  if (budget <= 0) return '';
  if (content.length <= budget) return content;
  return content.slice(0, budget).trimEnd();
}

function renderSection(section: PromptSection): string {
  return [
    `[[${section.name}]]`,
    `source: ${section.source}`,
    section.content,
    `[[/${section.name}]]`,
  ].join('\n');
}

function normalizeHeading(heading: string): string {
  return heading.trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseMarkdownSections(markdown: string): MarkdownSection[] {
  const lines = markdown.split('\n');
  const headings: Array<{ heading: string; line: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^##\s+(.+?)\s*$/);
    if (!match) continue;
    headings.push({ heading: match[1].trim(), line: i });
  }

  if (headings.length === 0) return [];

  const sections: MarkdownSection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    const nextLine =
      i + 1 < headings.length ? headings[i + 1].line : lines.length;
    const body = lines
      .slice(current.line + 1, nextLine)
      .join('\n')
      .trim();

    sections.push({ heading: current.heading, body });
  }

  return sections;
}

function renderPersonalProfileBody(rawProfile: string): {
  content: string;
  missingSections: string[];
  usedStructuredSections: boolean;
} {
  const parsed = parseMarkdownSections(rawProfile);
  if (parsed.length === 0) {
    return {
      content: rawProfile,
      missingSections: [...EXPECTED_PROFILE_SECTIONS],
      usedStructuredSections: false,
    };
  }

  const byHeading = new Map<string, MarkdownSection>();
  for (const section of parsed) {
    byHeading.set(normalizeHeading(section.heading), section);
  }

  const parts: string[] = [];
  const missingSections: string[] = [];
  let matchedCount = 0;

  for (const expected of EXPECTED_PROFILE_SECTIONS) {
    const match = byHeading.get(normalizeHeading(expected));
    if (!match) {
      missingSections.push(expected);
      continue;
    }

    matchedCount += 1;
    const body = match.body || '_No details provided._';
    parts.push(`## ${expected}\n${body}`);
  }

  if (matchedCount === 0) {
    return {
      content: rawProfile,
      missingSections,
      usedStructuredSections: false,
    };
  }

  return {
    content: parts.join('\n\n').trim(),
    missingSections,
    usedStructuredSections: true,
  };
}

export class PromptProfileService {
  private readonly configDir: string;
  private readonly groupsDir: string;
  private readonly sectionBudgets: Readonly<Record<PromptSectionName, number>>;
  private readonly totalBudget: number;

  constructor(options: PromptProfileServiceOptions = {}) {
    this.configDir = options.configDir || NANOCLAW_CONFIG_DIR;
    this.groupsDir = options.groupsDir || GROUPS_DIR;
    this.sectionBudgets = {
      ...DEFAULT_PROMPT_SECTION_BUDGETS,
      ...(options.sectionBudgets || {}),
    };
    this.totalBudget = options.totalBudget || DEFAULT_PROMPT_TOTAL_BUDGET;
  }

  ensureSeedFiles(): void {
    fs.mkdirSync(this.configDir, { recursive: true });

    const profilePath = path.join(this.configDir, PERSONAL_PROFILE_FILENAME);
    if (fs.existsSync(profilePath)) return;

    fs.writeFileSync(profilePath, DEFAULT_PROFILE_TEMPLATE);
    logger.info({ filePath: profilePath }, 'Seeded personal CLAUDE.md profile');
  }

  compileSystemPrompt(options: CompilePromptProfileOptions): string {
    this.ensureSeedFiles();

    const sections: PromptSection[] = [];

    sections.push({
      name: 'RUNTIME_RULES',
      source: 'nanoclaw://runtime-rules',
      content: truncateDeterministically(
        RUNTIME_RULES_BLOCK,
        this.sectionBudgets.RUNTIME_RULES,
      ),
    });

    const personal = this.readPersonalProfileSection();
    if (personal) sections.push(personal);

    const globalSection = this.readGlobalContextSection();
    if (globalSection) sections.push(globalSection);

    const groupSection = this.readGroupContextSection(options.groupFolder);
    if (groupSection) sections.push(groupSection);

    return this.composeWithinTotalBudget(sections);
  }

  private readPersonalProfileSection(): PromptSection | null {
    const profilePath = path.join(this.configDir, PERSONAL_PROFILE_FILENAME);
    if (!fs.existsSync(profilePath)) return null;

    let raw: string;
    try {
      raw = fs.readFileSync(profilePath, 'utf-8');
    } catch (err) {
      logger.warn(
        { err, filePath: profilePath },
        'Failed to read personal CLAUDE.md profile',
      );
      return null;
    }

    const normalized = normalizeContent(raw);
    if (!normalized) return null;

    const rendered = renderPersonalProfileBody(normalized);

    if (rendered.missingSections.length > 0) {
      logger.warn(
        {
          filePath: profilePath,
          missingSections: rendered.missingSections,
          structured: rendered.usedStructuredSections,
        },
        'Personal profile is missing expected sections',
      );
    }

    const content = truncateDeterministically(
      rendered.content,
      this.sectionBudgets.PERSONAL_PROFILE,
    );
    if (!content) return null;

    return {
      name: 'PERSONAL_PROFILE',
      source: profilePath,
      content,
    };
  }

  private readGlobalContextSection(): PromptSection | null {
    const globalPath = path.join(this.groupsDir, 'global', 'CLAUDE.md');
    return this.readPlainSection(
      'GLOBAL_CONTEXT',
      globalPath,
      this.sectionBudgets.GLOBAL_CONTEXT,
    );
  }

  private readGroupContextSection(groupFolder: string): PromptSection | null {
    if (!isValidGroupFolder(groupFolder)) {
      logger.warn({ groupFolder }, 'Skipping invalid group folder for prompt');
      return null;
    }

    const groupPath = path.join(this.groupsDir, groupFolder, 'CLAUDE.md');
    return this.readPlainSection(
      'GROUP_CONTEXT',
      groupPath,
      this.sectionBudgets.GROUP_CONTEXT,
    );
  }

  private readPlainSection(
    name: PromptSectionName,
    filePath: string,
    budget: number,
  ): PromptSection | null {
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const normalized = normalizeContent(raw);
      if (!normalized) return null;

      const content = truncateDeterministically(normalized, budget);
      if (!content) return null;

      return {
        name,
        source: filePath,
        content,
      };
    } catch (err) {
      logger.warn(
        { err, filePath, section: name },
        'Failed to read context section',
      );
      return null;
    }
  }

  private composeWithinTotalBudget(sections: PromptSection[]): string {
    if (this.totalBudget <= 0 || sections.length === 0) return '';

    let output = '';

    for (const section of sections) {
      const separator = output.length === 0 ? '' : '\n\n';
      const remaining = this.totalBudget - output.length;
      if (remaining <= separator.length) break;

      const block = renderSection(section);
      const availableForBlock = remaining - separator.length;
      const nextBlock =
        block.length <= availableForBlock
          ? block
          : block.slice(0, availableForBlock).trimEnd();

      if (!nextBlock) break;
      output += separator + nextBlock;
    }

    return output.trim();
  }
}

const defaultPromptProfileService = new PromptProfileService();

export function getPromptProfileService(): PromptProfileService {
  return defaultPromptProfileService;
}

export function ensurePromptProfileBootstrapped(): void {
  defaultPromptProfileService.ensureSeedFiles();
}
