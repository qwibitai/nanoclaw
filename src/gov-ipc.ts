import {
  createGovApproval,
  createGovTask,
  getGovTaskById,
  logGovActivity,
  updateGovTask,
} from './gov-db.js';
import { GateTypes, TaskStates } from './governance/constants.js';
import type { GateType as GateTypeEnum } from './governance/gates.js';
import { checkApprover, checkApproverNotExecutor } from './governance/gates.js';
import { validateTransition } from './governance/policy.js';
import { logger } from './logger.js';

export interface GovIpcData {
  type: string;
  // gov_create
  id?: string;
  title?: string;
  description?: string;
  task_type?: string;
  priority?: string;
  product?: string;
  assigned_group?: string;
  gate?: string;
  // gov_transition
  taskId?: string;
  toState?: string;
  reason?: string;
  expectedVersion?: number;
  // gov_approve
  gate_type?: string;
  notes?: string;
  // gov_assign
  executor?: string;
}

export async function processGovIpc(
  data: GovIpcData,
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const now = new Date().toISOString();

  switch (data.type) {
    case 'gov_create': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized gov_create blocked');
        break;
      }
      if (!data.title || !data.task_type) {
        logger.warn({ data }, 'gov_create missing required fields (title, task_type)');
        break;
      }
      // Validate task_type
      if (!['EPIC', 'FEATURE', 'BUG', 'SECURITY', 'REVOPS', 'OPS', 'RESEARCH', 'CONTENT', 'DOC', 'INCIDENT'].includes(data.task_type)) {
        logger.warn({ task_type: data.task_type }, 'gov_create invalid task_type');
        break;
      }
      // Validate gate if provided
      if (data.gate && !GateTypes.includes(data.gate as typeof GateTypes[number])) {
        logger.warn({ gate: data.gate }, 'gov_create invalid gate');
        break;
      }

      const taskId = data.id || `gov-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      createGovTask({
        id: taskId,
        title: data.title,
        description: data.description || null,
        task_type: data.task_type,
        state: 'INBOX',
        priority: data.priority || 'P2',
        product: data.product || null,
        assigned_group: data.assigned_group || null,
        executor: null,
        created_by: sourceGroup,
        gate: data.gate || 'None',
        dod_required: 0,
        metadata: null,
        created_at: now,
        updated_at: now,
      });
      logGovActivity({
        task_id: taskId,
        action: 'create',
        from_state: null,
        to_state: 'INBOX',
        actor: sourceGroup,
        reason: null,
        created_at: now,
      });
      logger.info({ taskId, sourceGroup, title: data.title }, 'Governance task created');
      break;
    }

    case 'gov_transition': {
      if (!data.taskId || !data.toState) {
        logger.warn({ data }, 'gov_transition missing required fields');
        break;
      }
      // Validate target state
      if (!TaskStates.includes(data.toState as typeof TaskStates[number])) {
        logger.warn({ toState: data.toState }, 'gov_transition invalid state');
        break;
      }

      const task = getGovTaskById(data.taskId);
      if (!task) {
        logger.warn({ taskId: data.taskId }, 'gov_transition task not found');
        break;
      }

      // Authorization: main or assigned group
      if (!isMain && task.assigned_group !== sourceGroup) {
        logger.warn(
          { sourceGroup, assigned: task.assigned_group },
          'Unauthorized gov_transition blocked',
        );
        break;
      }

      // Idempotent: already in target state → no-op
      if (task.state === data.toState) {
        logger.debug({ taskId: data.taskId, state: task.state }, 'gov_transition no-op (already in target state)');
        break;
      }

      // Version check if provided (P0-4: snapshot staleness protection)
      if (data.expectedVersion !== undefined && data.expectedVersion !== task.version) {
        logger.warn(
          { taskId: data.taskId, expected: data.expectedVersion, actual: task.version },
          'gov_transition version mismatch (stale)',
        );
        break;
      }

      // Policy validation — strict mode is host-only (P0-4), never from container
      const strict = process.env.GOV_STRICT === '1';
      const result = validateTransition(
        task.state as Parameters<typeof validateTransition>[0],
        data.toState as Parameters<typeof validateTransition>[1],
        undefined, // TaskLike for strict validation (v1)
        strict,
      );
      if (!result.ok) {
        logger.warn(
          { taskId: data.taskId, from: task.state, to: data.toState, errors: result.errors },
          'gov_transition denied by policy',
        );
        break;
      }

      // Optimistic locking update
      const updated = updateGovTask(data.taskId, task.version, {
        state: data.toState as typeof task.state,
      });
      if (!updated) {
        logger.warn({ taskId: data.taskId }, 'gov_transition version conflict (concurrent update)');
        break;
      }

      logGovActivity({
        task_id: data.taskId,
        action: 'transition',
        from_state: task.state,
        to_state: data.toState,
        actor: sourceGroup,
        reason: data.reason || null,
        created_at: now,
      });
      logger.info(
        { taskId: data.taskId, from: task.state, to: data.toState, actor: sourceGroup },
        'Governance task transitioned',
      );
      break;
    }

    case 'gov_approve': {
      if (!data.taskId || !data.gate_type) {
        logger.warn({ data }, 'gov_approve missing required fields');
        break;
      }
      // Validate gate type
      const validGates: GateTypeEnum[] = ['Security', 'RevOps', 'Claims', 'Product'];
      if (!validGates.includes(data.gate_type as GateTypeEnum)) {
        logger.warn({ gate_type: data.gate_type }, 'gov_approve invalid gate_type');
        break;
      }
      const gate = data.gate_type as GateTypeEnum;

      const task = getGovTaskById(data.taskId);
      if (!task) {
        logger.warn({ taskId: data.taskId }, 'gov_approve task not found');
        break;
      }

      // P0-1: enforce gate→group mapping via requireApprover
      const approverError = checkApprover(
        gate,
        sourceGroup,
        isMain,
      );
      if (approverError) {
        logger.warn({ sourceGroup, gate: data.gate_type }, approverError);
        break;
      }

      // P0-1: approver ≠ executor
      const executorError = checkApproverNotExecutor(
        sourceGroup,
        task.executor || task.assigned_group,
      );
      if (executorError) {
        logger.warn({ sourceGroup, executor: task.executor }, executorError);
        break;
      }

      createGovApproval({
        task_id: data.taskId,
        gate_type: data.gate_type,
        approved_by: sourceGroup,
        approved_at: now,
        notes: data.notes || null,
      });
      logGovActivity({
        task_id: data.taskId,
        action: 'approve',
        from_state: task.state,
        to_state: null,
        actor: sourceGroup,
        reason: `Gate ${data.gate_type} approved${data.notes ? ': ' + data.notes : ''}`,
        created_at: now,
      });
      logger.info(
        { taskId: data.taskId, gate: data.gate_type, approver: sourceGroup },
        'Gate approved',
      );
      break;
    }

    case 'gov_assign': {
      if (!isMain) {
        logger.warn({ sourceGroup }, 'Unauthorized gov_assign blocked');
        break;
      }
      if (!data.taskId || !data.assigned_group) {
        logger.warn({ data }, 'gov_assign missing required fields');
        break;
      }

      const task = getGovTaskById(data.taskId);
      if (!task) {
        logger.warn({ taskId: data.taskId }, 'gov_assign task not found');
        break;
      }

      const updates: Record<string, unknown> = {
        assigned_group: data.assigned_group,
      };
      if (data.executor) {
        updates.executor = data.executor;
      }

      const updated = updateGovTask(data.taskId, task.version, updates as Parameters<typeof updateGovTask>[2]);
      if (!updated) {
        logger.warn({ taskId: data.taskId }, 'gov_assign version conflict');
        break;
      }

      logGovActivity({
        task_id: data.taskId,
        action: 'assign',
        from_state: task.state,
        to_state: null,
        actor: sourceGroup,
        reason: `Assigned to ${data.assigned_group}${data.executor ? ` (executor: ${data.executor})` : ''}`,
        created_at: now,
      });
      logger.info(
        { taskId: data.taskId, assigned: data.assigned_group },
        'Governance task assigned',
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown governance IPC type');
  }
}
