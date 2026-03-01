/**
 * Smart Model Router — auto-pick the optimal model by task type.
 *
 * Lightweight keyword classifier determines task type from prompt content,
 * then looks up the best model from a configurable route map. Explicit
 * model overrides always win.
 *
 * selectModel is async — tries semantic (embedding-based) classification
 * first, falls back to keyword matching. Testable independently.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { SEMANTIC_ROUTING_ENABLED } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export type TaskType =
  | 'research'
  | 'grunt'
  | 'conversation'
  | 'analysis'
  | 'content'
  | 'code'
  | 'quick-check';

// ---------------------------------------------------------------------------
// Route config schema
// ---------------------------------------------------------------------------

export const ModelRouteSchema = z.object({
  research: z.string().min(1),
  grunt: z.string().min(1),
  conversation: z.string().min(1),
  analysis: z.string().min(1),
  content: z.string().min(1),
  code: z.string().min(1),
  'quick-check': z.string().min(1),
});

export const ModelRoutingConfigSchema = z.object({
  routing: ModelRouteSchema,
  default: z.string().min(1),
});

export type ModelRouteMap = z.infer<typeof ModelRouteSchema>;
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;

// ---------------------------------------------------------------------------
// Default route map
// ---------------------------------------------------------------------------

export const DEFAULT_ROUTES: ModelRoutingConfig = {
  routing: {
    research: 'claude-sonnet-4-6',
    grunt: 'minimax/minimax-m2.5',
    conversation: 'claude-sonnet-4-6',
    analysis: 'claude-sonnet-4-6',
    content: 'claude-sonnet-4-6',
    code: 'claude-sonnet-4-6',
    'quick-check': 'minimax/minimax-m2.5',
  },
  default: 'claude-sonnet-4-6',
};

// ---------------------------------------------------------------------------
// Task classifier — keyword/pattern based, no LLM
// ---------------------------------------------------------------------------

interface ClassifierRule {
  type: TaskType;
  patterns: RegExp[];
  weight: number; // higher = more specific, wins ties
}

const CLASSIFIER_RULES: ClassifierRule[] = [
  {
    type: 'grunt',
    patterns: [
      /\b(format|reformat|convert|csv|json|markdown|list|sort|dedupe|clean up)\b/i,
      /\b(summarize this|translate|extract|parse)\b/i,
    ],
    weight: 10,
  },
  {
    type: 'quick-check',
    patterns: [
      /\b(check|verify|confirm|is it|does it|status|health|ping)\b/i,
      /\b(what time|what date|weather|price of)\b/i,
    ],
    weight: 5,
  },
  {
    type: 'research',
    patterns: [
      /\b(research|investigate|find out|look into|deep dive|explore|search for|analyze .+ trends)\b/i,
      /\b(compare .+ (with|to|vs)|pros and cons|trade-?offs)\b/i,
      /\b(what are the options|alternatives)\b/i,
    ],
    weight: 20,
  },
  {
    type: 'analysis',
    patterns: [
      /\b(analy[sz]e|evaluate|assess|audit|review|diagnose|breakdown|report on)\b/i,
      /\b(metrics|performance|roi|revenue|cost analysis|financial)\b/i,
    ],
    weight: 15,
  },
  {
    type: 'content',
    patterns: [
      /\b(write|draft|compose|create .+ (post|email|article|tweet|message|blog))\b/i,
      /\b(social media|newsletter|copy|headline|caption)\b/i,
      /\b(outreach|follow[- ]up email|cold email)\b/i,
    ],
    weight: 15,
  },
  {
    type: 'code',
    patterns: [
      /\b(code|implement|build|program|script|function|debug|fix .+ bug)\b/i,
      /\b(refactor|deploy|test .+ (code|function)|pull request|commit)\b/i,
      /\b(api|endpoint|database|sql|typescript|python|javascript)\b/i,
    ],
    weight: 15,
  },
  {
    type: 'conversation',
    patterns: [
      /\b(hey|hi|hello|thanks|how are you|what do you think)\b/i,
      /\b(remind me|tell me about|explain|help me understand)\b/i,
    ],
    weight: 1, // lowest — fallback-ish
  },
];

/**
 * Classify a prompt into a task type based on keyword patterns.
 * Returns the highest-weight matching type, or 'conversation' as default.
 */
export function classifyTask(prompt: string): TaskType {
  let bestType: TaskType = 'conversation';
  let bestScore = 0;

  for (const rule of CLASSIFIER_RULES) {
    let matchCount = 0;
    for (const pattern of rule.patterns) {
      if (pattern.test(prompt)) matchCount++;
    }
    if (matchCount === 0) continue;

    const score = matchCount * rule.weight;
    if (score > bestScore) {
      bestScore = score;
      bestType = rule.type;
    }
  }

  return bestType;
}

// ---------------------------------------------------------------------------
// Model selection — main entry point
// ---------------------------------------------------------------------------

/**
 * Pick the optimal model for a prompt. Explicit override always wins.
 * Tries semantic (embedding-based) classification first, falls back to keywords.
 */
export async function selectModel(
  prompt: string,
  config: ModelRoutingConfig,
  explicitModel?: string,
): Promise<{ model: string; taskType: TaskType; reason: string }> {
  if (explicitModel) {
    return {
      model: explicitModel,
      taskType: classifyTask(prompt),
      reason: 'explicit override',
    };
  }

  // Try semantic classification first (if enabled)
  if (SEMANTIC_ROUTING_ENABLED) {
    try {
      const { semanticClassifyTask } = await import('./semantic-router.js');
      const result = await semanticClassifyTask(prompt);
      if (result) {
        const model = config.routing[result.taskType] ?? config.default;
        return {
          model,
          taskType: result.taskType,
          reason: `semantic (similarity=${result.similarity.toFixed(3)})`,
        };
      }
    } catch (err) {
      logger.debug({ err }, 'Semantic classification failed, using keyword fallback');
    }
  }

  const taskType = classifyTask(prompt);
  const model = config.routing[taskType] ?? config.default;

  return { model, taskType, reason: `classified as ${taskType}` };
}

// ---------------------------------------------------------------------------
// Config loading — JSON override from group folder
// ---------------------------------------------------------------------------

export function loadModelRoutingConfig(
  groupFolder: string,
  resolveGroupFolderPathFn?: (folder: string) => string,
): ModelRoutingConfig {
  try {
    const resolve = resolveGroupFolderPathFn ?? resolveGroupFolderPath;
    const groupPath = resolve(groupFolder);
    const configPath = path.join(groupPath, 'model-routing.json');

    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const validated = ModelRoutingConfigSchema.safeParse(parsed);

      if (validated.success) {
        logger.info({ groupFolder }, 'Loaded custom model routing config');
        return validated.data;
      }

      logger.warn(
        { groupFolder, errors: validated.error.issues },
        'Invalid model-routing.json — falling back to defaults',
      );
    }
  } catch {
    // File doesn't exist or can't be read — use defaults
  }

  return DEFAULT_ROUTES;
}
