import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CLAUDE_MD_PATH = resolve(
  import.meta.dirname,
  '..',
  'groups',
  'complaint',
  'CLAUDE.md'
);

describe('P1-S4: CLAUDE.md — the bot brain', () => {
  let content: string;

  // Load the file once before all tests
  it('CLAUDE.md file exists and is non-empty', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('contains identity template variables ({mla_name}, {constituency})', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    expect(content).toContain('{mla_name}');
    expect(content).toContain('{constituency}');
  });

  it('contains office_phone and complaint_id_prefix template variables', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    expect(content).toContain('{office_phone}');
    expect(content).toContain('{complaint_id_prefix}');
  });

  it('references all MCP tools with delimiter comments', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    expect(content).toContain('<!-- TOOL_USAGE_START -->');
    expect(content).toContain('<!-- TOOL_USAGE_END -->');
    expect(content).toContain('create_complaint');
    expect(content).toContain('query_complaints');
    expect(content).toContain('update_complaint');
    expect(content).toContain('get_categories');
    expect(content).toContain('get_user');
    expect(content).toContain('update_user');
    expect(content).toContain('block_user');
  });

  it('contains language detection instructions for Marathi, Hindi, English', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    expect(content).toMatch(/marathi/i);
    expect(content).toMatch(/hindi/i);
    expect(content).toMatch(/english/i);
    // Should mention auto-detection or language detection
    expect(content).toMatch(/language/i);
    expect(content).toMatch(/detect/i);
  });

  it('contains Marathi and Hindi example phrases', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    // Marathi: "Your complaint has been registered"
    expect(content).toContain('तुमची तक्रार नोंदवली गेली आहे');
    // Hindi: "Your complaint has been registered"
    expect(content).toContain('आपकी शिकायत दर्ज की गई है');
  });

  it('contains behavioral guardrails (no politics, no promises)', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    // No political opinions
    expect(content).toMatch(/politi/i);
    // No promises about timelines
    expect(content).toMatch(/promise/i);
    // Empathetic behavior
    expect(content).toMatch(/empath/i);
    // Off-topic redirect
    expect(content).toMatch(/off.topic|redirect/i);
    // Privacy / never share other users' data
    expect(content).toMatch(/share.*data|privacy|other users/i);
  });

  it('contains category assignment guidelines', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    const expectedCategories = [
      'water_supply',
      'roads',
      'electricity',
      'sanitation',
      'drainage',
      'streetlights',
      'encroachment',
      'noise',
      'public_health',
      'education',
      'other',
    ];
    for (const category of expectedCategories) {
      expect(content).toContain(category);
    }
  });

  it('contains complaint intake flow instructions', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    // Should mention gathering complaint details
    expect(content).toMatch(/greeting|greet/i);
    expect(content).toMatch(/category/i);
    expect(content).toMatch(/location/i);
    expect(content).toMatch(/confirm/i);
    expect(content).toMatch(/tracking/i);
  });

  it('contains response format templates', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    // Should have tracking ID format reference
    expect(content).toMatch(/\{complaint_id_prefix\}-YYYYMMDD-XXXX/);
  });

  it('no hardcoded MLA name or constituency name', () => {
    content = readFileSync(CLAUDE_MD_PATH, 'utf-8');
    // "Rahul Kul" should not appear as a hardcoded value
    expect(content).not.toMatch(/Rahul\s*Kul/i);
    // "Daund" (the constituency) should not appear as hardcoded
    expect(content).not.toMatch(/\bDaund\b/i);
  });
});
