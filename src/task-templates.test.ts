import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadTemplate,
  parseTemplateMarkdown,
  applyTemplate,
  type TaskTemplate,
} from './task-templates.js';

// Mock dependencies
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group'),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// parseTemplateMarkdown
// ---------------------------------------------------------------------------
describe('parseTemplateMarkdown', () => {
  it('parses a complete template', () => {
    const md = `## Method
1. Do step one
2. Do step two

## Anti-patterns
- Don't do this
- Don't do that

## Evaluation
- Check this
- Check that

## Output Format
{result}`;

    const result = parseTemplateMarkdown(md, 'research');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('research');
    expect(result!.method).toContain('Do step one');
    expect(result!.method).toContain('Do step two');
    expect(result!.antiPatterns).toEqual(['Don\'t do this', 'Don\'t do that']);
    expect(result!.evaluation).toEqual(['Check this', 'Check that']);
    expect(result!.outputFormat).toBe('{result}');
  });

  it('returns null when method section is missing', () => {
    const md = `## Anti-patterns
- Something`;

    expect(parseTemplateMarkdown(md, 'grunt')).toBeNull();
  });

  it('handles template with only method', () => {
    const md = `## Method
Just do the thing`;

    const result = parseTemplateMarkdown(md, 'grunt');
    expect(result).not.toBeNull();
    expect(result!.method).toBe('Just do the thing');
    expect(result!.antiPatterns).toEqual([]);
    expect(result!.evaluation).toEqual([]);
  });

  it('handles bullet points with asterisks', () => {
    const md = `## Method
Do it

## Anti-patterns
* Pattern one
* Pattern two`;

    const result = parseTemplateMarkdown(md, 'code');
    expect(result!.antiPatterns).toEqual(['Pattern one', 'Pattern two']);
  });

  it('is case-insensitive on section headers', () => {
    const md = `## METHOD
Step one

## ANTI-PATTERNS
- Bad thing

## EVALUATION
- Good thing`;

    // Section extraction lowercases — but heading must be `## Method`, not `## METHOD`
    // Actually extractSections lowercases, so this works
    const result = parseTemplateMarkdown(md, 'analysis');
    expect(result).not.toBeNull();
    expect(result!.method).toBe('Step one');
  });
});

// ---------------------------------------------------------------------------
// loadTemplate
// ---------------------------------------------------------------------------
describe('loadTemplate', () => {
  it('returns built-in template when no files exist', () => {
    const template = loadTemplate('research');
    expect(template.type).toBe('research');
    expect(template.method).toContain('Clarify the research question');
    expect(template.antiPatterns.length).toBeGreaterThan(0);
    expect(template.evaluation.length).toBeGreaterThan(0);
  });

  it('returns built-in for every task type', () => {
    const types = ['research', 'grunt', 'conversation', 'analysis', 'content', 'code', 'quick-check'] as const;
    for (const type of types) {
      const template = loadTemplate(type);
      expect(template.type).toBe(type);
      expect(template.method.length).toBeGreaterThan(0);
    }
  });

  it('loads from group folder when file exists', async () => {
    const fsModule = await import('fs');
    const tmpDir = '/tmp/test-task-templates-group';
    const templatesDir = `${tmpDir}/templates/tasks`;
    fsModule.mkdirSync(templatesDir, { recursive: true });
    fsModule.writeFileSync(
      `${templatesDir}/research.md`,
      '## Method\nCustom research method\n\n## Anti-patterns\n- Custom anti-pattern',
    );

    const template = loadTemplate('research', 'test', () => tmpDir);
    expect(template.method).toBe('Custom research method');
    expect(template.antiPatterns).toEqual(['Custom anti-pattern']);

    fsModule.rmSync(tmpDir, { recursive: true });
  });
});

// ---------------------------------------------------------------------------
// applyTemplate
// ---------------------------------------------------------------------------
describe('applyTemplate', () => {
  it('wraps research prompt with template', () => {
    const result = applyTemplate('Research the best CRM tools');
    expect(result.taskType).toBe('research');
    expect(result.templateUsed).toBe(true);
    expect(result.enhancedPrompt).toContain('Research the best CRM tools');
    expect(result.enhancedPrompt).toContain('<task-template>');
    expect(result.enhancedPrompt).toContain('<method>');
    expect(result.enhancedPrompt).toContain('<anti-patterns>');
    expect(result.enhancedPrompt).toContain('<evaluation>');
    expect(result.enhancedPrompt).toContain('</task-template>');
  });

  it('does not wrap conversation prompts', () => {
    const result = applyTemplate('Hey, how are you?');
    expect(result.taskType).toBe('conversation');
    expect(result.templateUsed).toBe(false);
    expect(result.enhancedPrompt).toBe('Hey, how are you?');
  });

  it('does not wrap quick-check prompts', () => {
    const result = applyTemplate('What time is it in Tokyo?');
    expect(result.taskType).toBe('quick-check');
    expect(result.templateUsed).toBe(false);
    expect(result.enhancedPrompt).toBe('What time is it in Tokyo?');
  });

  it('wraps code prompts', () => {
    const result = applyTemplate('Implement a rate limiter');
    expect(result.taskType).toBe('code');
    expect(result.templateUsed).toBe(true);
    expect(result.enhancedPrompt).toContain('<method>');
  });

  it('wraps content prompts', () => {
    const result = applyTemplate('Write a blog post about AI');
    expect(result.taskType).toBe('content');
    expect(result.templateUsed).toBe(true);
    expect(result.enhancedPrompt).toContain('AI-sounding phrases');
  });

  it('wraps analysis prompts', () => {
    const result = applyTemplate('Analyze our revenue trends');
    expect(result.taskType).toBe('analysis');
    expect(result.templateUsed).toBe(true);
  });

  it('wraps grunt prompts', () => {
    const result = applyTemplate('Format this data as CSV');
    expect(result.taskType).toBe('grunt');
    expect(result.templateUsed).toBe(true);
  });

  it('preserves original prompt at the top', () => {
    const result = applyTemplate('Research competitor pricing');
    const lines = result.enhancedPrompt.split('\n');
    expect(lines[0]).toBe('Research competitor pricing');
  });
});

// ---------------------------------------------------------------------------
// Built-in template quality checks
// ---------------------------------------------------------------------------
describe('built-in templates', () => {
  it('all templates have non-empty method', () => {
    const types = ['research', 'grunt', 'conversation', 'analysis', 'content', 'code', 'quick-check'] as const;
    for (const type of types) {
      const t = loadTemplate(type);
      expect(t.method.length).toBeGreaterThan(10);
    }
  });

  it('research template has at least 3 anti-patterns', () => {
    const t = loadTemplate('research');
    expect(t.antiPatterns.length).toBeGreaterThanOrEqual(3);
  });

  it('content template warns about AI-sounding phrases', () => {
    const t = loadTemplate('content');
    const combined = t.antiPatterns.join(' ');
    expect(combined).toContain('AI-sounding');
  });

  it('code template warns about over-engineering', () => {
    const t = loadTemplate('code');
    const combined = t.antiPatterns.join(' ');
    expect(combined.toLowerCase()).toContain('over-engineering');
  });
});
