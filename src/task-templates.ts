/**
 * Task Templates — reusable structured prompts with anti-pattern guardrails.
 *
 * Each task type (from model-router's classifier) has a corresponding template
 * with method, anti-patterns, evaluation criteria, and output format.
 *
 * Templates are loaded from disk (user-editable) with built-in defaults as
 * fallback. The agent's prompt is wrapped with the matching template.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { classifyTask, type TaskType } from './model-router.js';

// ---------------------------------------------------------------------------
// Template structure
// ---------------------------------------------------------------------------

export interface TaskTemplate {
  type: TaskType;
  method: string;
  antiPatterns: string[];
  evaluation: string[];
  outputFormat: string;
}

// ---------------------------------------------------------------------------
// Built-in defaults — used when no file-based template exists
// ---------------------------------------------------------------------------

const BUILTIN_TEMPLATES: Record<TaskType, TaskTemplate> = {
  research: {
    type: 'research',
    method: [
      '1. Clarify the research question — what exactly needs to be answered?',
      '2. Identify 3-5 credible sources (official docs, primary sources, reputable publications)',
      '3. Cross-reference findings across sources — look for consensus and contradictions',
      '4. Synthesize into actionable insights with confidence levels',
      '5. Note gaps — what couldn\'t be verified?',
    ].join('\n'),
    antiPatterns: [
      'Single-source conclusions — always cross-reference',
      'Outdated information presented as current — check dates',
      'Speculation presented as fact — label uncertainty explicitly',
      'Shallow summaries that don\'t answer the actual question',
    ],
    evaluation: [
      'Question fully answered with evidence',
      'Multiple sources cited or consulted',
      'Confidence levels stated for key claims',
      'Actionable next steps included',
    ],
    outputFormat: '## Research: {topic}\n\n### Findings\n{findings}\n\n### Sources\n{sources}\n\n### Confidence & Gaps\n{confidence}',
  },

  grunt: {
    type: 'grunt',
    method: [
      '1. Understand the input format and desired output format',
      '2. Process the data — transform, format, clean as needed',
      '3. Verify output matches expected format',
      '4. Report completion with summary of what was done',
    ].join('\n'),
    antiPatterns: [
      'Changing data values when only formatting was requested',
      'Dropping rows/items silently during transformation',
      'Adding interpretation when raw output was asked for',
    ],
    evaluation: [
      'Output format matches request exactly',
      'No data lost or altered unintentionally',
      'Completed efficiently without unnecessary steps',
    ],
    outputFormat: '{output}',
  },

  conversation: {
    type: 'conversation',
    method: [
      '1. Understand what the person is actually asking or saying',
      '2. Respond naturally — match their tone and energy',
      '3. Be helpful without being verbose',
      '4. If action is needed, do it; don\'t just talk about it',
    ].join('\n'),
    antiPatterns: [
      'Over-explaining simple things',
      'Being robotic when casual tone is appropriate',
      'Promising action without following through',
      'Ignoring emotional context (frustration, excitement, urgency)',
    ],
    evaluation: [
      'Response matches the conversational context',
      'Action items are executed, not just acknowledged',
      'Tone is appropriate',
    ],
    outputFormat: '{response}',
  },

  analysis: {
    type: 'analysis',
    method: [
      '1. Define what\'s being analyzed and the success criteria',
      '2. Gather relevant data points and context',
      '3. Apply structured methodology (comparative, root-cause, cost-benefit, etc.)',
      '4. Present findings with supporting evidence',
      '5. Provide clear recommendations ranked by impact',
    ].join('\n'),
    antiPatterns: [
      'Cherry-picking data that supports a predetermined conclusion',
      'Analysis without actionable recommendations',
      'Confusing correlation with causation',
      'Ignoring relevant context or constraints',
    ],
    evaluation: [
      'Methodology is clear and appropriate for the question',
      'Conclusions are supported by evidence',
      'Recommendations are specific and actionable',
      'Limitations and assumptions are stated',
    ],
    outputFormat: '## Analysis: {topic}\n\n### Methodology\n{methodology}\n\n### Findings\n{findings}\n\n### Recommendations\n{recommendations}',
  },

  content: {
    type: 'content',
    method: [
      '1. Understand the audience, platform, and goal',
      '2. Match the voice/tone to the brand and context',
      '3. Write with a clear hook, body, and call-to-action',
      '4. Keep it concise — cut every unnecessary word',
      '5. Review for platform-specific constraints (char limits, formatting)',
    ].join('\n'),
    antiPatterns: [
      'Generic corporate-speak that sounds like everyone else',
      'Ignoring platform conventions (hashtags, thread format, char limits)',
      'All features, no benefits — write for the reader',
      'Missing call-to-action',
      'AI-sounding phrases: "dive into", "leverage", "in today\'s landscape"',
    ],
    evaluation: [
      'Voice matches the brand/person',
      'Platform constraints respected',
      'Clear value proposition in first line',
      'Call-to-action present',
    ],
    outputFormat: '{content}',
  },

  code: {
    type: 'code',
    method: [
      '1. Understand the requirement — what should the code do?',
      '2. Check existing patterns in the codebase — follow them',
      '3. Write the minimal code that solves the problem',
      '4. Handle errors at boundaries, trust internal code',
      '5. Test it — run the code, verify the output',
    ].join('\n'),
    antiPatterns: [
      'Over-engineering — don\'t add abstractions for one use case',
      'Ignoring existing patterns in the codebase',
      'Writing code without testing it',
      'Adding unnecessary comments, types, or error handling',
      'Changing unrelated code while fixing a bug',
    ],
    evaluation: [
      'Code works — verified with tests or manual check',
      'Follows existing codebase patterns',
      'Minimal changes — no unnecessary additions',
      'No security vulnerabilities introduced',
    ],
    outputFormat: '{code}',
  },

  'quick-check': {
    type: 'quick-check',
    method: [
      '1. Identify what needs to be checked',
      '2. Check it — use the most direct method available',
      '3. Report the result clearly',
    ].join('\n'),
    antiPatterns: [
      'Over-investigating when a simple check was asked for',
      'Providing analysis when a yes/no answer suffices',
    ],
    evaluation: [
      'Question answered directly',
      'Response is concise',
    ],
    outputFormat: '{result}',
  },
};

// ---------------------------------------------------------------------------
// Template loading — file-based override with built-in fallback
// ---------------------------------------------------------------------------

/**
 * Load a task template for the given type. Checks group folder first,
 * then global templates directory, then falls back to built-in defaults.
 */
export function loadTemplate(
  taskType: TaskType,
  groupFolder?: string,
  resolveGroupFolderPathFn?: (folder: string) => string,
): TaskTemplate {
  // 1. Try group-specific template
  if (groupFolder) {
    const template = loadTemplateFromDir(taskType, groupFolder, resolveGroupFolderPathFn);
    if (template) return template;
  }

  // 2. Try global templates directory
  const globalDir = path.join(process.cwd(), 'templates', 'tasks');
  const globalTemplate = loadTemplateFromFile(taskType, globalDir);
  if (globalTemplate) return globalTemplate;

  // 3. Fall back to built-in
  return BUILTIN_TEMPLATES[taskType];
}

function loadTemplateFromDir(
  taskType: TaskType,
  groupFolder: string,
  resolveGroupFolderPathFn?: (folder: string) => string,
): TaskTemplate | null {
  try {
    const resolve = resolveGroupFolderPathFn ?? resolveGroupFolderPath;
    const groupPath = resolve(groupFolder);
    const templatesDir = path.join(groupPath, 'templates', 'tasks');
    return loadTemplateFromFile(taskType, templatesDir);
  } catch {
    return null;
  }
}

function loadTemplateFromFile(
  taskType: TaskType,
  dir: string,
): TaskTemplate | null {
  const filePath = path.join(dir, `${taskType}.md`);

  try {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = parseTemplateMarkdown(content, taskType);

    if (parsed) {
      logger.info({ taskType, path: filePath }, 'Loaded custom task template');
      return parsed;
    }
  } catch {
    // File unreadable — use fallback
  }

  return null;
}

// ---------------------------------------------------------------------------
// Markdown template parser
// ---------------------------------------------------------------------------

/**
 * Parse a markdown template file into a TaskTemplate.
 * Expected format:
 *
 * ## Method
 * {step-by-step method}
 *
 * ## Anti-patterns
 * - {anti-pattern 1}
 * - {anti-pattern 2}
 *
 * ## Evaluation
 * - {criterion 1}
 * - {criterion 2}
 *
 * ## Output Format
 * {format template}
 */
export function parseTemplateMarkdown(
  content: string,
  taskType: TaskType,
): TaskTemplate | null {
  const sections = extractSections(content);

  const method = sections['method'];
  if (!method) return null; // Method is required

  return {
    type: taskType,
    method,
    antiPatterns: extractListItems(sections['anti-patterns'] ?? sections['antipatterns'] ?? ''),
    evaluation: extractListItems(sections['evaluation'] ?? ''),
    outputFormat: sections['output format'] ?? sections['outputformat'] ?? BUILTIN_TEMPLATES[taskType].outputFormat,
  };
}

function extractSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split('\n');

  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      currentSection = headingMatch[1].trim().toLowerCase();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }

  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  return sections;
}

function extractListItems(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter((line) => line.length > 0);
}

// ---------------------------------------------------------------------------
// Prompt wrapping — apply template to a task prompt
// ---------------------------------------------------------------------------

/**
 * Wrap a task prompt with the appropriate template.
 * Returns the enhanced prompt with method, anti-patterns, and evaluation.
 */
export function applyTemplate(
  prompt: string,
  groupFolder?: string,
  resolveGroupFolderPathFn?: (folder: string) => string,
): { enhancedPrompt: string; taskType: TaskType; templateUsed: boolean } {
  const taskType = classifyTask(prompt);
  const template = loadTemplate(taskType, groupFolder, resolveGroupFolderPathFn);

  // Don't wrap conversation or quick-check — keep them lightweight
  if (taskType === 'conversation' || taskType === 'quick-check') {
    return { enhancedPrompt: prompt, taskType, templateUsed: false };
  }

  const sections: string[] = [
    prompt,
    '',
    '<task-template>',
    `<method>`,
    template.method,
    `</method>`,
  ];

  if (template.antiPatterns.length > 0) {
    sections.push(
      `<anti-patterns>`,
      ...template.antiPatterns.map((ap) => `- ${ap}`),
      `</anti-patterns>`,
    );
  }

  if (template.evaluation.length > 0) {
    sections.push(
      `<evaluation>`,
      ...template.evaluation.map((e) => `- ${e}`),
      `</evaluation>`,
    );
  }

  sections.push('</task-template>');

  return {
    enhancedPrompt: sections.join('\n'),
    taskType,
    templateUsed: true,
  };
}
