/**
 * Skill Evaluator
 * Runs a background loop that evaluates agent interactions after the evaluation
 * deadline passes. Uses a direct Anthropic API call with a cheap model.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { EVALUATION_POLL_INTERVAL } from '../config.js';
import {
  getActiveSkills,
  getRunsNeedingEvaluation,
  getSkillSelectionsForRun,
  recordEvaluation,
  updateSkillPerformance,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';

let evaluatorRunning = false;

const evaluatorPrompt = fs.readFileSync(
  path.join(process.cwd(), 'container', 'evaluator-prompt.md'),
  'utf-8',
);

function getAnthropicClient(): Anthropic | null {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  if (!secrets.ANTHROPIC_API_KEY) {
    logger.warn('No ANTHROPIC_API_KEY found, evaluator disabled');
    return null;
  }
  return new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });
}

interface EvaluatorResponse {
  overall: number;
  dimensions: {
    helpfulness: number;
    accuracy: number;
    efficiency: number;
    tone: number;
  };
  reasoning: string;
  skill_assessment: string;
}

async function evaluateRun(
  client: Anthropic,
  run: {
    id: string;
    group_folder: string;
    prompt_summary: string | null;
    response_summary: string | null;
  },
  selectedSkillNames: string[],
  availableSkillNames: string[],
): Promise<EvaluatorResponse | null> {
  const userMessage = [
    '## User Message',
    run.prompt_summary || '(no summary available)',
    '',
    '## Assistant Response',
    run.response_summary || '(streamed output — summary not available)',
    '',
    '## Skills Used',
    selectedSkillNames.length > 0
      ? selectedSkillNames.map((n) => `- ${n}`).join('\n')
      : '(none)',
    '',
    '## Available Skills',
    availableSkillNames.length > 0
      ? availableSkillNames.map((n) => `- ${n}`).join('\n')
      : '(none — system is in cold start)',
  ].join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 500,
      system: evaluatorPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    // Parse JSON from response, stripping any markdown fencing
    const cleaned = text
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    return JSON.parse(cleaned) as EvaluatorResponse;
  } catch (err) {
    logger.error({ err, runId: run.id }, 'Evaluator API call failed');
    return null;
  }
}

async function processEvaluations(): Promise<void> {
  const client = getAnthropicClient();
  if (!client) return;

  const runs = getRunsNeedingEvaluation();
  if (runs.length === 0) return;

  logger.info({ count: runs.length }, 'Processing pending evaluations');

  for (const run of runs) {
    try {
      const selectedSkillIds = getSkillSelectionsForRun(run.id);
      const allSkills = getActiveSkills(run.group_folder);
      const selectedSkillNames = allSkills
        .filter((s) => selectedSkillIds.includes(s.id))
        .map((s) => s.name);
      const availableSkillNames = allSkills.map((s) => s.name);

      const result = await evaluateRun(
        client,
        run,
        selectedSkillNames,
        availableSkillNames,
      );
      if (!result) continue;

      const evalId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      recordEvaluation({
        id: evalId,
        run_id: run.id,
        score: result.overall,
        dimensions: JSON.stringify(result.dimensions),
        evaluation_source: 'evaluator_agent',
        raw_feedback: JSON.stringify({
          reasoning: result.reasoning,
          skill_assessment: result.skill_assessment,
        }),
        evaluated_at: new Date().toISOString(),
      });

      // Update performance for each skill used in this run
      for (const skillId of selectedSkillIds) {
        updateSkillPerformance(skillId);
      }

      logger.info(
        { runId: run.id, score: result.overall, evalId },
        'Evaluation recorded',
      );
    } catch (err) {
      logger.error({ err, runId: run.id }, 'Error evaluating run');
    }
  }
}

export function startEvaluationLoop(): void {
  if (evaluatorRunning) {
    logger.debug('Evaluation loop already running, skipping duplicate start');
    return;
  }
  evaluatorRunning = true;

  const poll = async () => {
    try {
      await processEvaluations();
    } catch (err) {
      logger.error({ err }, 'Error in evaluation loop');
    }
    setTimeout(poll, EVALUATION_POLL_INTERVAL);
  };

  // Delay first run to let startup settle
  setTimeout(poll, 30_000);
  logger.info('Evaluation loop started');
}
