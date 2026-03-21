/**
 * Skill Evolution Agent
 * Periodically reviews interaction data and evolves behavioral skills.
 * Uses a direct Anthropic API call with Sonnet for cost control.
 */
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import {
  COLD_START_THRESHOLD,
  EVOLUTION_COOLDOWN_MS,
  EVOLUTION_EVAL_TRIGGER,
  EVOLUTION_POLL_INTERVAL,
  EVOLUTION_SCORE_THRESHOLD,
} from '../config.js';
import {
  getActiveSkills,
  getAllSkillPerformance,
  getLastEvolutionTimestamp,
  getLowScoringRollouts,
  getRecentEvaluationCount,
  getSkillById,
  getSkillPerformance,
  getSkillSelectionsForRun,
  getSkillVersionCount,
  getTotalEvaluatedRuns,
  insertEvolutionLog,
  insertSkill,
  updateSkillStatus,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { BehavioralSkill } from '../types.js';

import {
  checkForbiddenPatterns,
  shouldRollback,
  validateNewSkill,
  validateSkillModification,
} from './validator.js';

let evolutionRunning = false;

const MAX_VERSIONS_PER_SKILL = 20;

const evolutionPrompt = fs.readFileSync(
  path.join(process.cwd(), 'container', 'evolution-prompt.md'),
  'utf-8',
);

function getAnthropicClient(): Anthropic | null {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  if (!secrets.ANTHROPIC_API_KEY) {
    logger.warn('No ANTHROPIC_API_KEY found, evolution agent disabled');
    return null;
  }
  return new Anthropic({ apiKey: secrets.ANTHROPIC_API_KEY });
}

interface EvolutionAction {
  type: 'modify' | 'create' | 'retire';
  skill_name: string;
  new_content?: string;
  new_description?: string;
  content?: string;
  description?: string;
  reasoning: string;
}

interface EvolutionResponse {
  actions: EvolutionAction[];
  missed_selections: Array<{
    run_id: string;
    skill_name: string;
    reasoning: string;
  }>;
  summary: string;
}

function shouldRunEvolution(): boolean {
  const lastEvolution = getLastEvolutionTimestamp();

  // Cooldown check
  if (lastEvolution) {
    const elapsed = Date.now() - new Date(lastEvolution).getTime();
    if (elapsed < EVOLUTION_COOLDOWN_MS) {
      logger.debug(
        { elapsedMs: elapsed, cooldownMs: EVOLUTION_COOLDOWN_MS },
        'Evolution cooldown active',
      );
      return false;
    }
  }

  // Cold start: need enough interactions before first evolution
  const totalEvals = getTotalEvaluatedRuns();
  if (totalEvals < COLD_START_THRESHOLD) {
    logger.debug(
      { totalEvals, threshold: COLD_START_THRESHOLD },
      'Not enough evaluations for evolution (cold start)',
    );
    return false;
  }

  // Check trigger conditions
  const sinceTimestamp = lastEvolution || '1970-01-01T00:00:00.000Z';
  const recentEvals = getRecentEvaluationCount(sinceTimestamp);

  if (recentEvals >= EVOLUTION_EVAL_TRIGGER) {
    return true;
  }

  // Check if any skill's recent score dropped below threshold
  const performances = getAllSkillPerformance();
  for (const perf of performances) {
    if (
      perf.total_runs >= 3 &&
      perf.recent_avg_score < EVOLUTION_SCORE_THRESHOLD
    ) {
      logger.info(
        { skillId: perf.skill_id, score: perf.recent_avg_score },
        'Skill score decline detected, triggering evolution',
      );
      return true;
    }
  }

  return false;
}

function buildEvolutionContext(): string {
  const skills = getActiveSkills(null); // Global skills
  const performances = getAllSkillPerformance();
  const lowRollouts = getLowScoringRollouts(EVOLUTION_SCORE_THRESHOLD, 10);

  const sections: string[] = [];

  // Current skills with full content (including evolution notes)
  sections.push('## Current Skills\n');
  if (skills.length === 0) {
    sections.push('(No skills exist yet — cold start)\n');
  }
  for (const skill of skills) {
    const perf = performances.find((p) => p.skill_id === skill.id);
    sections.push(`### ${skill.name} (${skill.status})`);
    if (perf) {
      sections.push(
        `Performance: ${perf.total_runs} runs, avg ${perf.avg_score.toFixed(2)}, recent ${perf.recent_avg_score.toFixed(2)}`,
      );
    }
    sections.push('```markdown');
    sections.push(skill.content);
    sections.push('```\n');
  }

  // Low-scoring rollouts with full multi-turn context
  sections.push('## Low-Scoring Rollouts\n');
  if (lowRollouts.length === 0) {
    sections.push('(No low-scoring rollouts found)\n');
  }
  for (const rollout of lowRollouts) {
    sections.push(
      `### Rollout ${rollout.rollout_id} (avg score: ${rollout.avg_score.toFixed(2)})`,
    );

    for (let i = 0; i < rollout.runs.length; i++) {
      const run = rollout.runs[i];
      const selectedIds = getSkillSelectionsForRun(run.id);
      const selectedNames = selectedIds
        .map((id) => skills.find((s) => s.id === id)?.name)
        .filter(Boolean);

      sections.push(`#### Turn ${i + 1}`);
      sections.push(`User: ${run.prompt_summary || '(no summary)'}`);
      sections.push(`Response: ${run.response_summary || '(no summary)'}`);

      if (run.tool_calls) {
        try {
          const tools = JSON.parse(run.tool_calls) as Array<{
            name: string;
            input: Record<string, unknown>;
            output: string;
          }>;
          if (tools.length > 0) {
            sections.push('Tools:');
            for (const t of tools) {
              sections.push(`  - ${t.name}: ${t.output.slice(0, 100)}`);
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      if (selectedNames.length > 0) {
        sections.push(`Skills used: ${selectedNames.join(', ')}`);
      }

      if (run.dimensions) {
        try {
          const dims = JSON.parse(run.dimensions);
          sections.push(
            `Scores: helpfulness=${dims.helpfulness}, accuracy=${dims.accuracy}, efficiency=${dims.efficiency}, tone=${dims.tone}, tool_selection=${dims.tool_selection ?? 'n/a'}`,
          );
        } catch {
          // ignore parse errors
        }
      }

      if (run.evaluator_reasoning) {
        sections.push(`Evaluator reasoning: ${run.evaluator_reasoning}`);
      }
      sections.push('');
    }

    const availableNames = skills.map((s) => s.name);
    const usedInRollout = new Set(
      rollout.runs.flatMap((r) =>
        getSkillSelectionsForRun(r.id)
          .map((id) => skills.find((s) => s.id === id)?.name)
          .filter(Boolean),
      ),
    );
    const notUsed = availableNames.filter((n) => !usedInRollout.has(n));
    if (notUsed.length > 0) {
      sections.push(`Skills available but never used in rollout: ${notUsed.join(', ')}`);
    }
    sections.push('');
  }

  // Performance summary
  sections.push('## Skill Performance Summary\n');
  for (const perf of performances) {
    const skill = skills.find((s) => s.id === perf.skill_id);
    sections.push(
      `- ${skill?.name || perf.skill_id}: ${perf.total_runs} runs, avg ${perf.avg_score.toFixed(2)}, recent ${perf.recent_avg_score.toFixed(2)}`,
    );
  }

  return sections.join('\n');
}

async function applyAction(
  action: EvolutionAction,
  triggerReason: string,
): Promise<void> {
  const now = new Date().toISOString();
  const logId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  switch (action.type) {
    case 'modify': {
      const existing = getActiveSkills(null).find(
        (s) => s.name === action.skill_name,
      );
      if (!existing) {
        logger.warn(
          { skill: action.skill_name },
          'Cannot modify non-existent skill',
        );
        return;
      }

      const newContent = action.new_content || existing.content;

      // Validate modification
      const validationError = validateSkillModification(
        existing.content,
        newContent,
      );
      if (validationError) {
        logger.warn(
          { skill: action.skill_name, error: validationError },
          'Skill modification rejected by validator',
        );
        return;
      }

      // Check version limit
      const versionCount = getSkillVersionCount(
        existing.name,
        existing.group_folder,
      );
      if (versionCount >= MAX_VERSIONS_PER_SKILL) {
        logger.warn(
          { skill: action.skill_name, versions: versionCount },
          'Max versions reached, skipping modification',
        );
        return;
      }

      // Create new version
      const newId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newSkill: BehavioralSkill = {
        id: newId,
        name: existing.name,
        version: existing.version + 1,
        content: newContent,
        description: action.new_description || existing.description,
        parent_id: existing.id,
        status: 'active',
        created_at: now,
        group_folder: existing.group_folder,
      };

      // Retire old version
      updateSkillStatus(existing.id, 'retired');
      insertSkill(newSkill);

      insertEvolutionLog({
        id: logId,
        group_folder: existing.group_folder,
        action: 'modify',
        skill_id: newId,
        changes_summary: action.reasoning,
        trigger_reason: triggerReason,
        created_at: now,
      });

      logger.info(
        {
          skill: action.skill_name,
          oldVersion: existing.version,
          newVersion: newSkill.version,
        },
        'Skill modified by evolution',
      );
      break;
    }

    case 'create': {
      const content = action.content || '';
      const validationError = validateNewSkill(content);
      if (validationError) {
        logger.warn(
          { skill: action.skill_name, error: validationError },
          'New skill rejected by validator',
        );
        return;
      }

      const newId = `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newSkill: BehavioralSkill = {
        id: newId,
        name: action.skill_name,
        version: 1,
        content,
        description: action.description || action.skill_name,
        parent_id: null,
        status: 'candidate', // New skills start as candidate
        created_at: now,
        group_folder: null, // Global by default
      };

      insertSkill(newSkill);

      insertEvolutionLog({
        id: logId,
        group_folder: null,
        action: 'create',
        skill_id: newId,
        changes_summary: action.reasoning,
        trigger_reason: triggerReason,
        created_at: now,
      });

      logger.info(
        { skill: action.skill_name, id: newId },
        'New candidate skill created by evolution',
      );
      break;
    }

    case 'retire': {
      const existing = getActiveSkills(null).find(
        (s) => s.name === action.skill_name,
      );
      if (!existing) {
        logger.warn(
          { skill: action.skill_name },
          'Cannot retire non-existent skill',
        );
        return;
      }

      updateSkillStatus(existing.id, 'retired');

      insertEvolutionLog({
        id: logId,
        group_folder: existing.group_folder,
        action: 'retire',
        skill_id: existing.id,
        changes_summary: action.reasoning,
        trigger_reason: triggerReason,
        created_at: now,
      });

      logger.info({ skill: action.skill_name }, 'Skill retired by evolution');
      break;
    }
  }
}

/**
 * Check candidate skills for promotion or demotion.
 * Candidates with 5+ runs get promoted if avg score >= baseline, else retired.
 */
function processCandidates(): void {
  const skills = getActiveSkills(null);
  const candidates = skills.filter((s) => s.status === 'candidate');
  const performances = getAllSkillPerformance();

  for (const candidate of candidates) {
    const perf = performances.find((p) => p.skill_id === candidate.id);
    if (!perf || perf.total_runs < 5) continue;

    // Calculate baseline: average score of all non-candidate evaluations
    // For simplicity, use 0.5 as baseline if no other data
    const allPerfs = performances.filter((p) => {
      const skill = skills.find((s) => s.id === p.skill_id);
      return skill && skill.status === 'active';
    });
    const baseline =
      allPerfs.length > 0
        ? allPerfs.reduce((sum, p) => sum + p.avg_score, 0) / allPerfs.length
        : 0.5;

    const now = new Date().toISOString();
    const logId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (perf.avg_score >= baseline) {
      updateSkillStatus(candidate.id, 'active');
      insertEvolutionLog({
        id: logId,
        group_folder: candidate.group_folder,
        action: 'modify', // status change
        skill_id: candidate.id,
        changes_summary: `Promoted from candidate: avg ${perf.avg_score.toFixed(2)} >= baseline ${baseline.toFixed(2)}`,
        trigger_reason: 'periodic',
        created_at: now,
      });
      logger.info(
        { skill: candidate.name, avgScore: perf.avg_score, baseline },
        'Candidate skill promoted to active',
      );
    } else {
      updateSkillStatus(candidate.id, 'retired');
      insertEvolutionLog({
        id: logId,
        group_folder: candidate.group_folder,
        action: 'retire',
        skill_id: candidate.id,
        changes_summary: `Candidate retired: avg ${perf.avg_score.toFixed(2)} < baseline ${baseline.toFixed(2)}`,
        trigger_reason: 'periodic',
        created_at: now,
      });
      logger.info(
        { skill: candidate.name, avgScore: perf.avg_score, baseline },
        'Candidate skill retired (below baseline)',
      );
    }
  }
}

/**
 * Check for skills that need rollback due to score decline.
 */
function processRollbacks(): void {
  const skills = getActiveSkills(null);

  for (const skill of skills) {
    if (!skill.parent_id) continue;

    const currentPerf = getSkillPerformance(skill.id);
    if (!currentPerf || currentPerf.total_runs < 3) continue;

    const parent = getSkillById(skill.parent_id);
    if (!parent) continue;

    const parentPerf = getSkillPerformance(parent.id);
    if (!parentPerf) continue;

    if (shouldRollback(parentPerf.avg_score, currentPerf.avg_score)) {
      const now = new Date().toISOString();
      const logId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // Rollback: retire current, re-activate parent
      updateSkillStatus(skill.id, 'retired');
      updateSkillStatus(parent.id, 'active');

      insertEvolutionLog({
        id: logId,
        group_folder: skill.group_folder,
        action: 'modify',
        skill_id: parent.id,
        changes_summary: `Rolled back from v${skill.version} to v${parent.version}: score dropped from ${parentPerf.avg_score.toFixed(2)} to ${currentPerf.avg_score.toFixed(2)}`,
        trigger_reason: 'score_decline',
        created_at: now,
      });

      logger.info(
        {
          skill: skill.name,
          rolledBackFrom: skill.version,
          rolledBackTo: parent.version,
        },
        'Skill rolled back due to score decline',
      );
    }
  }
}

async function runEvolution(): Promise<void> {
  if (!shouldRunEvolution()) return;

  const client = getAnthropicClient();
  if (!client) return;

  logger.info('Running skill evolution');

  // Process candidates and rollbacks first
  processCandidates();
  processRollbacks();

  // Build context for the evolution agent
  const context = buildEvolutionContext();

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4000,
      system: evolutionPrompt,
      messages: [{ role: 'user', content: context }],
    });

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '';
    const cleaned = text
      .replace(/^```json?\s*/m, '')
      .replace(/```\s*$/m, '')
      .trim();
    const result = JSON.parse(cleaned) as EvolutionResponse;

    // Determine trigger reason
    const lastEvolution = getLastEvolutionTimestamp();
    const totalEvals = getTotalEvaluatedRuns();
    const activeSkills = getActiveSkills(null);
    let triggerReason = 'periodic';
    if (activeSkills.length === 0 && totalEvals >= COLD_START_THRESHOLD) {
      triggerReason = 'cold_start';
    } else {
      const performances = getAllSkillPerformance();
      const hasDecline = performances.some(
        (p) =>
          p.total_runs >= 3 && p.recent_avg_score < EVOLUTION_SCORE_THRESHOLD,
      );
      if (hasDecline) triggerReason = 'score_decline';
    }

    // Apply actions
    for (const action of result.actions) {
      try {
        await applyAction(action, triggerReason);
      } catch (err) {
        logger.error(
          { err, action: action.type, skill: action.skill_name },
          'Error applying evolution action',
        );
      }
    }

    // Log missed selections
    for (const missed of result.missed_selections) {
      const logId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      insertEvolutionLog({
        id: logId,
        group_folder: null,
        action: 'modify', // signal, not a real modification
        skill_id: missed.skill_name,
        changes_summary: `Missed selection in ${missed.run_id}: ${missed.reasoning}`,
        trigger_reason: 'gap_detected',
        created_at: new Date().toISOString(),
      });
    }

    logger.info(
      {
        actionsCount: result.actions.length,
        missedCount: result.missed_selections.length,
        summary: result.summary,
      },
      'Evolution cycle complete',
    );
  } catch (err) {
    logger.error({ err }, 'Evolution agent API call failed');
  }
}

export function startEvolutionLoop(): void {
  if (evolutionRunning) {
    logger.debug('Evolution loop already running, skipping duplicate start');
    return;
  }
  evolutionRunning = true;

  const poll = async () => {
    try {
      await runEvolution();
    } catch (err) {
      logger.error({ err }, 'Error in evolution loop');
    }
    setTimeout(poll, EVOLUTION_POLL_INTERVAL);
  };

  // Delay first run to let startup and evaluations settle
  setTimeout(poll, 60_000);
  logger.info('Evolution loop started');
}
