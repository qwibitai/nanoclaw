/**
 * Skill Evaluator
 * Runs a background loop that evaluates closed rollouts (multi-turn windows).
 * Each rollout contains up to ROLLOUT_SIZE consecutive turns, with tool calls
 * extracted from session transcripts. Uses a direct Anthropic API call.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { EVALUATION_POLL_INTERVAL } from '../config.js';
import {
  getActiveSkills,
  getClosedRolloutsNeedingEvaluation,
  getRunsForRollout,
  getSkillSelectionsForRun,
  recordEvaluation,
  updateSkillPerformance,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { closeStaleRollouts } from './rollout-manager.js';

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
    tool_selection: number;
  };
  reasoning: string;
  skill_assessment: string;
}

function buildRolloutMessage(
  runs: ReturnType<typeof getRunsForRollout>,
  allSkills: ReturnType<typeof getActiveSkills>,
): string {
  const sections: string[] = [];

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const selectedIds = getSkillSelectionsForRun(run.id);
    const selectedNames = allSkills
      .filter((s) => selectedIds.includes(s.id))
      .map((s) => s.name);

    sections.push(`## Turn ${i + 1} of ${runs.length}`);
    sections.push(`**User:** ${run.prompt_summary ?? '(no prompt recorded)'}`);
    sections.push(
      `**Assistant:** ${run.response_summary ?? '(no response recorded)'}`,
    );

    if (run.tool_calls) {
      try {
        const tools = JSON.parse(run.tool_calls) as Array<{
          name: string;
          input: Record<string, unknown>;
          output: string;
        }>;
        if (tools.length > 0) {
          sections.push('**Tools used:**');
          for (const t of tools) {
            const inputSummary = JSON.stringify(t.input).slice(0, 100);
            sections.push(
              `- ${t.name}(${inputSummary}) → ${t.output.slice(0, 150)}`,
            );
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    if (selectedNames.length > 0) {
      sections.push(`**Skills selected:** ${selectedNames.join(', ')}`);
    }
    sections.push('');
  }

  // Available skills
  const availableNames = allSkills.map((s) => s.name);
  sections.push('## Available Skills');
  sections.push(
    availableNames.length > 0
      ? availableNames.join(', ')
      : '(none — cold start)',
  );

  return sections.join('\n');
}

async function evaluateRollout(
  client: Anthropic,
  rolloutId: string,
  groupFolder: string,
): Promise<EvaluatorResponse | null> {
  const runs = getRunsForRollout(rolloutId);
  if (runs.length === 0) return null;

  const allSkills = getActiveSkills(groupFolder);
  const userMessage = buildRolloutMessage(runs, allSkills);

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 600,
      system: evaluatorPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    return JSON.parse(cleaned) as EvaluatorResponse;
  } catch (err) {
    logger.error({ err, rolloutId }, 'Evaluator API call failed');
    return null;
  }
}

async function processEvaluations(): Promise<void> {
  // Close any stale open rollouts first
  closeStaleRollouts();

  const client = getAnthropicClient();
  if (!client) return;

  const rollouts = getClosedRolloutsNeedingEvaluation();
  if (rollouts.length === 0) return;

  logger.info(
    { count: rollouts.length },
    'Processing pending rollout evaluations',
  );

  for (const rollout of rollouts) {
    try {
      const result = await evaluateRollout(
        client,
        rollout.id,
        rollout.group_folder,
      );
      if (!result) continue;

      const runs = getRunsForRollout(rollout.id);
      const now = new Date().toISOString();

      // Record evaluation against each run in the rollout with the same score
      const skillIds = new Set<string>();
      for (const run of runs) {
        const evalId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        recordEvaluation({
          id: evalId,
          run_id: run.id,
          score: result.overall,
          dimensions: JSON.stringify(result.dimensions),
          evaluation_source: 'evaluator_agent',
          evaluator_reasoning: result.reasoning,
          raw_feedback: JSON.stringify({
            skill_assessment: result.skill_assessment,
          }),
          evaluated_at: now,
        });

        // Collect all skill IDs used across the rollout
        for (const sid of getSkillSelectionsForRun(run.id)) {
          skillIds.add(sid);
        }
      }

      // Update performance for all skills that participated in this rollout
      for (const skillId of skillIds) {
        updateSkillPerformance(skillId);
      }

      logger.info(
        { rolloutId: rollout.id, turns: runs.length, score: result.overall },
        'Rollout evaluation recorded',
      );
    } catch (err) {
      logger.error({ err, rolloutId: rollout.id }, 'Error evaluating rollout');
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

  setTimeout(poll, 30_000);
  logger.info('Evaluation loop started');
}
