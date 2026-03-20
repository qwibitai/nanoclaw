/**
 * Re-exports DB accessor functions for behavioral skills.
 * This module exists so skill-related code can import from a single place.
 */
export {
  getActiveSkills,
  getSkillByName,
  getSkillById,
  insertSkill,
  updateSkillStatus,
  recordSkillTaskRun,
  getTaskRun,
  recordSkillSelections,
  getRunsNeedingEvaluation,
  recordEvaluation,
  getEvaluationForRun,
  updateSkillPerformance,
  getSkillPerformance,
  getAllSkillPerformance,
  getSkillSelectionsForRun,
  getRecentEvaluationCount,
  getLowScoringRuns,
  insertEvolutionLog,
  getLastEvolutionTimestamp,
  getSkillVersionCount,
  getTotalEvaluatedRuns,
} from '../db.js';
