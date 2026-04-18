# Plan 7: Learning System

**Date:** 2026-04-13
**Status:** Implemented

## Overview

The Learning System makes NanoClaw get smarter over time through four subsystems:

### 7A: Compounding Memory (Knowledge Store)
- SQLite FTS5 full-text search across stored facts
- Cross-group queryable memory
- Functions: `storeFact()`, `queryFacts()`, `deleteFact()`, `getAllFacts()`
- **File:** `src/memory/knowledge-store.ts`

### 7B: Outcome Tracking
- Dedicated `outcomes` table (separate from trust_actions)
- Success rate tracking per action class
- Cost aggregation
- Functions: `logOutcome()`, `queryOutcomes()`, `getSuccessRate()`, `getTotalCost()`
- **File:** `src/memory/outcome-store.ts`

### 7C: Cost Dashboard
- On-demand via `@Andy cost report` (or `@Andy costs`)
- Reads from existing `session_costs` table
- Breakdown by session type with budget display
- **File:** `src/memory/cost-dashboard.ts`

### 7D: Procedure Store
- Learned procedures stored as JSON files
- Global: `store/procedures/`
- Per-group: `groups/{name}/procedures/`
- Functions: `saveProcedure()`, `findProcedure()`, `listProcedures()`, `updateProcedureStats()`
- **File:** `src/memory/procedure-store.ts`

### 7E: Teach Mode
- Triggered by `@Andy teach: how to do X`
- Parses description into procedure steps
- Stores via procedure store
- Handled in `cost-dashboard.ts` via `parseAssistantCommand()`

## Integration Points

1. **DB Init:** `initKnowledgeStore()` and `initOutcomeStore()` called at startup in `index.ts`
2. **Command Interception:** Assistant commands (cost report, teach) intercepted alongside trust commands in the message loop
3. **Outcome Logging:** `task.complete` events automatically logged to outcome store via event bus subscription

## Future Upgrades

- Replace SQLite FTS5 with Mem0 + Qdrant for semantic vector search
- Add browser recording to teach mode (requires Plan 4 browser sidecar)
- Wire knowledge facts into container startup context injection
