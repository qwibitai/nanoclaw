/**
 * Skill Format Validation Tests
 *
 * Validates that all container skills follow a consistent format:
 * - Valid YAML frontmatter (name, description, metadata)
 * - Required sections (Capabilities, Security Considerations)
 * - Valid cron expressions where applicable
 * - Proper metadata structure
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const SKILLS_DIR = path.resolve(process.cwd(), 'container/skills');

interface SkillFrontmatter {
  name?: string;
  description?: string;
  metadata?: string;
  'allowed-tools'?: string;
}

interface NanoClawMetadata {
  nanoclaw?: {
    emoji?: string;
    schedule?: string;
    requires?: { bins?: string[] };
  };
}

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('No valid frontmatter found');
  }

  const raw = match[1];
  const body = match[2];
  const frontmatter: SkillFrontmatter = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    (frontmatter as Record<string, string>)[key] = value;
  }

  return { frontmatter, body };
}

function parseMetadata(metadataStr: string): NanoClawMetadata {
  return JSON.parse(metadataStr);
}

function getSkillFiles(): string[] {
  return fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith('.md')).sort();
}

// ─── Common validation helpers ──────────────────────────────────────────────

function readSkill(filename: string): { frontmatter: SkillFrontmatter; body: string; raw: string } {
  const filepath = path.join(SKILLS_DIR, filename);
  const raw = fs.readFileSync(filepath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { frontmatter, body, raw };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Container Skills Directory', () => {
  it('contains exactly 5 skill files', () => {
    const files = getSkillFiles();
    expect(files).toHaveLength(5);
    expect(files).toEqual([
      'agent-browser.md',
      'daily-routine.md',
      'knowledge-assistant.md',
      'market-analysis.md',
      'software-engineer.md',
    ]);
  });
});

describe('Common Skill Format', () => {
  const skillFiles = ['daily-routine.md', 'knowledge-assistant.md', 'market-analysis.md', 'software-engineer.md'];

  for (const filename of skillFiles) {
    describe(filename, () => {
      it('has valid YAML frontmatter with --- delimiters', () => {
        const { raw } = readSkill(filename);
        expect(raw).toMatch(/^---\n[\s\S]*?\n---\n/);
      });

      it('has name field in frontmatter', () => {
        const { frontmatter } = readSkill(filename);
        expect(frontmatter.name).toBeDefined();
        expect(frontmatter.name!.length).toBeGreaterThan(0);
      });

      it('has description field in frontmatter', () => {
        const { frontmatter } = readSkill(filename);
        expect(frontmatter.description).toBeDefined();
        expect(frontmatter.description!.length).toBeGreaterThan(10);
      });

      it('has metadata with nanoclaw.emoji', () => {
        const { frontmatter } = readSkill(filename);
        expect(frontmatter.metadata).toBeDefined();
        const meta = parseMetadata(frontmatter.metadata!);
        expect(meta.nanoclaw).toBeDefined();
        expect(meta.nanoclaw!.emoji).toBeDefined();
        expect(meta.nanoclaw!.emoji!.length).toBeGreaterThan(0);
      });

      it('has ## Capabilities section', () => {
        const { body } = readSkill(filename);
        expect(body).toContain('## Capabilities');
      });

      it('has ## Security Considerations section', () => {
        const { body } = readSkill(filename);
        expect(body).toContain('## Security Considerations');
      });

      it('has a level-1 heading as title', () => {
        const { body } = readSkill(filename);
        expect(body).toMatch(/^# .+/m);
      });
    });
  }
});

describe('agent-browser.md', () => {
  it('has valid YAML frontmatter', () => {
    const { raw } = readSkill('agent-browser.md');
    expect(raw).toMatch(/^---\n[\s\S]*?\n---\n/);
  });

  it('has name and description', () => {
    const { frontmatter } = readSkill('agent-browser.md');
    expect(frontmatter.name).toBe('agent-browser');
    expect(frontmatter.description).toBeDefined();
  });

  it('has allowed-tools field', () => {
    const { frontmatter } = readSkill('agent-browser.md');
    expect(frontmatter['allowed-tools']).toBeDefined();
    expect(frontmatter['allowed-tools']).toContain('agent-browser');
  });

  it('has comprehensive command reference', () => {
    const { body } = readSkill('agent-browser.md');
    expect(body).toContain('## Commands');
    expect(body).toContain('### Navigation');
    expect(body).toContain('### Snapshot');
    expect(body).toContain('### Interactions');
  });
});

describe('market-analysis.md', () => {
  it('has name "market-analysis"', () => {
    const { frontmatter } = readSkill('market-analysis.md');
    expect(frontmatter.name).toBe('market-analysis');
  });

  it('has valid cron schedule in metadata', () => {
    const { frontmatter } = readSkill('market-analysis.md');
    const meta = parseMetadata(frontmatter.metadata!);
    expect(meta.nanoclaw!.schedule).toBeDefined();

    // Validate cron expression
    const schedule = meta.nanoclaw!.schedule!;
    expect(() => CronExpressionParser.parse(schedule)).not.toThrow();
  });

  it('schedule runs on weekdays at market hours', () => {
    const { frontmatter } = readSkill('market-analysis.md');
    const meta = parseMetadata(frontmatter.metadata!);
    const schedule = meta.nanoclaw!.schedule!;

    // Parse and verify next occurrences
    const interval = CronExpressionParser.parse(schedule, { tz: 'UTC' });
    const nextRuns: Date[] = [];
    for (let i = 0; i < 5; i++) {
      nextRuns.push(interval.next().toDate());
    }

    // All should be weekdays (1-5)
    for (const run of nextRuns) {
      const day = run.getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
    }

    // Hours should be 9, 12, or 16
    const validHours = [9, 12, 16];
    for (const run of nextRuns) {
      expect(validHours).toContain(run.getUTCHours());
    }
  });

  it('includes security disclaimer about recommendations', () => {
    const { body } = readSkill('market-analysis.md');
    expect(body).toContain('NEVER provide specific buy/sell recommendations');
  });

  it('documents output format sections', () => {
    const { body } = readSkill('market-analysis.md');
    expect(body).toContain('Market Overview');
    expect(body).toContain('Notable Movers');
    expect(body).toContain('Risk Alerts');
  });

  it('specifies data sources', () => {
    const { body } = readSkill('market-analysis.md');
    expect(body).toContain('## Data Sources');
  });
});

describe('software-engineer.md', () => {
  it('has name "software-engineer"', () => {
    const { frontmatter } = readSkill('software-engineer.md');
    expect(frontmatter.name).toBe('software-engineer');
  });

  it('requires node binary', () => {
    const { frontmatter } = readSkill('software-engineer.md');
    const meta = parseMetadata(frontmatter.metadata!);
    expect(meta.nanoclaw!.requires).toBeDefined();
    expect(meta.nanoclaw!.requires!.bins).toContain('node');
  });

  it('documents security best practices', () => {
    const { body } = readSkill('software-engineer.md');
    expect(body).toContain('## Security Best Practices');
    expect(body).toContain('SQL injection');
    expect(body).toContain('XSS');
    expect(body).toContain('hardcode');
  });

  it('documents development workflow', () => {
    const { body } = readSkill('software-engineer.md');
    expect(body).toContain('## Workflow');
    expect(body).toContain('Understand');
    expect(body).toContain('Plan');
    expect(body).toContain('Implement');
    expect(body).toContain('Test');
  });

  it('lists available tools', () => {
    const { body } = readSkill('software-engineer.md');
    expect(body).toContain('## Tools Available');
  });
});

describe('daily-routine.md', () => {
  it('has name "daily-routine"', () => {
    const { frontmatter } = readSkill('daily-routine.md');
    expect(frontmatter.name).toBe('daily-routine');
  });

  it('has valid cron schedule in metadata', () => {
    const { frontmatter } = readSkill('daily-routine.md');
    const meta = parseMetadata(frontmatter.metadata!);
    expect(meta.nanoclaw!.schedule).toBeDefined();

    const schedule = meta.nanoclaw!.schedule!;
    expect(() => CronExpressionParser.parse(schedule)).not.toThrow();
  });

  it('schedule runs weekday mornings', () => {
    const { frontmatter } = readSkill('daily-routine.md');
    const meta = parseMetadata(frontmatter.metadata!);
    const interval = CronExpressionParser.parse(meta.nanoclaw!.schedule!, { tz: 'UTC' });

    const next = interval.next().toDate();
    const day = next.getDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
    expect(next.getUTCHours()).toBe(7);
    expect(next.getUTCMinutes()).toBe(30);
  });

  it('documents scheduled task examples', () => {
    const { body } = readSkill('daily-routine.md');
    expect(body).toContain('## Scheduled Tasks');
    expect(body).toContain('Morning Briefing');
    expect(body).toContain('Evening Review');
    expect(body).toContain('Weekly Planning');
  });

  it('integrates with memory system', () => {
    const { body } = readSkill('daily-routine.md');
    expect(body).toContain('## Memory System');
    expect(body).toContain('CLAUDE.md');
    expect(body).toContain('YYYY-MM-DD.md');
  });

  it('has output format guidelines', () => {
    const { body } = readSkill('daily-routine.md');
    expect(body).toContain('## Output Format');
  });
});

describe('knowledge-assistant.md', () => {
  it('has name "knowledge-assistant"', () => {
    const { frontmatter } = readSkill('knowledge-assistant.md');
    expect(frontmatter.name).toBe('knowledge-assistant');
  });

  it('has emoji in metadata (no schedule - on-demand)', () => {
    const { frontmatter } = readSkill('knowledge-assistant.md');
    const meta = parseMetadata(frontmatter.metadata!);
    expect(meta.nanoclaw!.emoji).toBe('🧠');
    // No schedule - this is on-demand only
    expect(meta.nanoclaw!.schedule).toBeUndefined();
  });

  it('documents knowledge storage structure', () => {
    const { body } = readSkill('knowledge-assistant.md');
    expect(body).toContain('## Knowledge Storage');
    expect(body).toContain('CLAUDE.md');
    expect(body).toContain('MEMORY.md');
    expect(body).toContain('knowledge/');
    expect(body).toContain('topics/');
  });

  it('documents research workflow', () => {
    const { body } = readSkill('knowledge-assistant.md');
    expect(body).toContain('## Research Workflow');
    expect(body).toContain('Check existing knowledge');
    expect(body).toContain('Web research');
    expect(body).toContain('Synthesize');
    expect(body).toContain('Store');
    expect(body).toContain('Cite');
  });

  it('includes memory management guidelines', () => {
    const { body } = readSkill('knowledge-assistant.md');
    expect(body).toContain('## Memory Management');
  });

  it('includes security considerations about data isolation', () => {
    const { body } = readSkill('knowledge-assistant.md');
    expect(body).toContain('isolated workspace');
    expect(body).toContain('Never expose knowledge from one group to another');
  });
});
