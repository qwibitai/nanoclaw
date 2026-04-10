/**
 * Meeting Engine — Sub-Agent Lifecycle Types
 *
 * Rollback criteria: No schema migrations are required for these types.
 * All state is managed in-memory by the SubAgentResultStore for testing.
 * If a persistent store is added later, the corresponding down migration is:
 *
 *   -- Down migration (drop order respects FK constraints)
 *   DROP TABLE IF EXISTS dead_letter_results;
 *   DROP TABLE IF EXISTS sub_agent_results;
 */

/** A research directive submitted to the sub-agent dispatch layer. */
export interface ResearchDirective {
  id: string;
  prompt: string;
  submitted_at: string;
  callback_url?: string;
}

/**
 * Lifecycle result record for a dispatched sub-agent.
 *
 * State machine:
 *   pending → running → done
 *                    ↘ failed
 */
export interface SubAgentResult {
  id: string;
  directive_id: string;
  ahq_task_id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  result_text: string | null;
  /** ISO timestamp of the most recent heartbeat from the sub-agent. */
  last_heartbeat_at: string | null;
  /** ISO timestamp when the result reached a terminal state (done/failed). */
  terminal_at: string | null;
  /** ISO timestamp when the completion callback was invoked. Null until then. */
  callback_handled_at: string | null;
  created_at: string;
}

/**
 * Dead-letter record for a sub-agent result that could not be processed.
 * Results are moved here when stall detection, dispatch errors, or callback
 * failures exceed the retry limit.
 */
export interface DeadLetterResult {
  id: string;
  directive_id: string;
  ahq_task_id: string;
  failure_reason: 'stall' | 'dispatch_error' | 'callback_error' | 'unknown';
  failed_at: string;
  attempts: number;
  last_error: string | null;
  context: Record<string, unknown> | null;
}

/** Progress signal emitted by a running sub-agent at regular intervals. */
export interface HeartbeatSignal {
  result_id: string;
  sent_at: string;
  progress?: string;
}
