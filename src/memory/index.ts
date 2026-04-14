/**
 * Learning System — Memory module barrel export.
 *
 * Subsystems:
 * - Knowledge Store: Cross-group queryable memory (FTS5)
 * - Outcome Store: Action outcome tracking
 * - Cost Dashboard: On-demand cost reporting
 * - Procedure Store: Learned procedure workflows
 */

export {
  initKnowledgeStore,
  storeFact,
  queryFacts,
  deleteFact,
  getAllFacts,
} from './knowledge-store.js';
export type { Fact, StoreFactInput, QueryFactsOpts } from './knowledge-store.js';

export {
  initOutcomeStore,
  logOutcome,
  queryOutcomes,
  getSuccessRate,
  getTotalCost,
} from './outcome-store.js';
export type {
  Outcome,
  LogOutcomeInput,
  QueryOutcomesOpts,
  SuccessRate,
} from './outcome-store.js';

export {
  saveProcedure,
  findProcedure,
  listProcedures,
  updateProcedureStats,
  deleteProcedure,
} from './procedure-store.js';
export type { Procedure, ProcedureStep } from './procedure-store.js';

export {
  parseAssistantCommand,
  executeAssistantCommand,
  formatCostReport,
  getCostBreakdown,
} from './cost-dashboard.js';
export type { AssistantCommand } from './cost-dashboard.js';
