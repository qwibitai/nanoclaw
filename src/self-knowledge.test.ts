import { describe, it, expect } from 'vitest';

import {
  parseCapabilities,
  formatOverview,
  formatSection,
  listSections,
  matchSection,
  CapabilitiesDoc,
} from './self-knowledge.js';

const SAMPLE_DOC: CapabilitiesDoc = {
  version: 1,
  agent_name: 'TestBot',
  summary: 'I am a test agent with messaging and memory capabilities.',
  sections: {
    tools: {
      title: 'Tools & Capabilities',
      summary: 'I have messaging, memory, and payment tools.',
      items: [
        { name: 'send_message', description: 'Send messages to channels' },
        { name: 'recall', description: 'Search long-term memory' },
        { name: 'remember', description: 'Write to long-term memory' },
      ],
    },
    scheduled_tasks: {
      title: 'Scheduled Tasks',
      summary: 'Automated jobs that run on a schedule.',
      items: [
        { name: 'morning-heartbeat', description: 'Daily morning check-in at 7am' },
      ],
    },
    memory: {
      title: 'Memory System',
      summary: 'How I remember things across sessions.',
      items: [],
    },
    limitations: {
      title: 'Limitations',
      summary: 'What I cannot do.',
      items: [
        { name: 'no-internet-browsing', description: 'Cannot browse the web directly' },
      ],
    },
  },
};

// ── parseCapabilities ───────────────────────────────────────────────

describe('parseCapabilities', () => {
  it('parses valid doc', () => {
    const doc = parseCapabilities(SAMPLE_DOC);
    expect(doc.agent_name).toBe('TestBot');
    expect(Object.keys(doc.sections)).toHaveLength(4);
  });

  it('applies defaults for missing optional fields', () => {
    const minimal = {
      summary: 'Minimal agent.',
      sections: {},
    };
    const doc = parseCapabilities(minimal);
    expect(doc.version).toBe(1);
    expect(doc.agent_name).toBe('Agent');
  });

  it('rejects invalid input', () => {
    expect(() => parseCapabilities({})).toThrow();
    expect(() => parseCapabilities(null)).toThrow();
    expect(() => parseCapabilities('string')).toThrow();
  });

  it('rejects section missing required fields', () => {
    const bad = {
      summary: 'Agent',
      sections: {
        tools: { title: 'Tools' }, // missing summary
      },
    };
    expect(() => parseCapabilities(bad)).toThrow();
  });
});

// ── formatOverview ──────────────────────────────────────────────────

describe('formatOverview', () => {
  it('includes agent name and summary', () => {
    const output = formatOverview(SAMPLE_DOC);
    expect(output).toContain('# TestBot');
    expect(output).toContain('I am a test agent');
  });

  it('lists all section keys with summaries', () => {
    const output = formatOverview(SAMPLE_DOC);
    expect(output).toContain('**tools**');
    expect(output).toContain('**scheduled_tasks**');
    expect(output).toContain('**memory**');
    expect(output).toContain('**limitations**');
  });

  it('includes progressive disclosure hint', () => {
    const output = formatOverview(SAMPLE_DOC);
    expect(output).toContain('Ask about a specific section');
  });
});

// ── formatSection ───────────────────────────────────────────────────

describe('formatSection', () => {
  it('formats section with items', () => {
    const output = formatSection(SAMPLE_DOC, 'tools');
    expect(output).toContain('# Tools & Capabilities');
    expect(output).toContain('**send_message**');
    expect(output).toContain('**recall**');
    expect(output).toContain('**remember**');
  });

  it('formats section without items', () => {
    const output = formatSection(SAMPLE_DOC, 'memory');
    expect(output).toContain('# Memory System');
    expect(output).not.toContain('**');
  });

  it('returns null for unknown section', () => {
    expect(formatSection(SAMPLE_DOC, 'nonexistent')).toBeNull();
  });
});

// ── listSections ────────────────────────────────────────────────────

describe('listSections', () => {
  it('returns all section keys', () => {
    const sections = listSections(SAMPLE_DOC);
    expect(sections).toEqual(['tools', 'scheduled_tasks', 'memory', 'limitations']);
  });

  it('returns empty array for no sections', () => {
    const doc: CapabilitiesDoc = {
      version: 1,
      agent_name: 'Empty',
      summary: 'No sections.',
      sections: {},
    };
    expect(listSections(doc)).toEqual([]);
  });
});

// ── matchSection ────────────────────────────────────────────────────

describe('matchSection', () => {
  it('exact match', () => {
    expect(matchSection(SAMPLE_DOC, 'tools')).toBe('tools');
  });

  it('case insensitive', () => {
    expect(matchSection(SAMPLE_DOC, 'TOOLS')).toBe('tools');
  });

  it('partial key match', () => {
    expect(matchSection(SAMPLE_DOC, 'scheduled')).toBe('scheduled_tasks');
  });

  it('partial title match', () => {
    expect(matchSection(SAMPLE_DOC, 'capabilities')).toBe('tools');
  });

  it('returns null for no match', () => {
    expect(matchSection(SAMPLE_DOC, 'quantum_physics')).toBeNull();
  });

  it('handles whitespace in query', () => {
    expect(matchSection(SAMPLE_DOC, '  tools  ')).toBe('tools');
  });
});
