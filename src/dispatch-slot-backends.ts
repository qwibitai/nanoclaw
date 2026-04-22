import { PARALLEL_DISPATCH_WORKERS } from './dispatch-pool-constants.js';

import { agencyFetch } from './agency-hq-client.js';
import {
  insertAcquiringSlot,
  getActiveSlots,
  recoverStaleSlotRecords,
  transitionToExecuting,
  transitionToFree,
  transitionToReleasing,
  pruneFreedSlots,
} from './db/dispatch-slots.js';
import { logger } from './logger.js';

export { PARALLEL_DISPATCH_WORKERS };

export function workerSlotJid(i: number): string {
  return `internal:dev-inbox:${i}`;
}

export function isDispatchSlotsPgEnabled(): boolean {
  return process.env.DISPATCH_SLOTS_PG === 'true';
}

export interface SlotClaim {
  slotId: number;
  slotIndex: number;
  slotJid: string;
  worktreePath: string | null;
}

export interface ActiveSlotInfo {
  slotId: number;
  slotIndex: number;
  ahqTaskId: string;
  state: string;
  worktreePath: string | null;
  /** ISO timestamp when the slot entered 'executing' state (null if not yet executing). */
  executingAt: string | null;
}

export interface RecoveredSlotInfo extends ActiveSlotInfo {
  reason: string;
}

export interface DispatchSlotBackend {
  readonly name: 'sqlite' | 'pg';
  claimSlot(
    ahqTaskId: string,
    branchId: string | null,
    localTaskId: string,
    worktreePath: string | null,
  ): Promise<SlotClaim | null>;
  markExecuting(slotId: number): Promise<void>;
  markReleasing(slotId: number): Promise<void>;
  freeSlot(slotId: number): Promise<void>;
  listActiveSlots(): Promise<ActiveSlotInfo[]>;
  recoverStaleSlots(): Promise<RecoveredSlotInfo[]>;
  pruneHistory(): number;
}

class SqliteDispatchSlotBackend implements DispatchSlotBackend {
  readonly name = 'sqlite' as const;

  async claimSlot(
    ahqTaskId: string,
    branchId: string | null,
    localTaskId: string,
    worktreePath: string | null,
  ): Promise<SlotClaim | null> {
    for (let i = 0; i < PARALLEL_DISPATCH_WORKERS; i++) {
      const slotId = insertAcquiringSlot(
        i,
        ahqTaskId,
        branchId,
        localTaskId,
        worktreePath,
      );
      if (slotId !== null) {
        return {
          slotId,
          slotIndex: i,
          slotJid: workerSlotJid(i),
          worktreePath,
        };
      }
    }

    return null;
  }

  async markExecuting(slotId: number): Promise<void> {
    transitionToExecuting(slotId);
  }

  async markReleasing(slotId: number): Promise<void> {
    transitionToReleasing(slotId);
  }

  async freeSlot(slotId: number): Promise<void> {
    transitionToFree(slotId);
  }

  async listActiveSlots(): Promise<ActiveSlotInfo[]> {
    return getActiveSlots().map((slot) => ({
      slotId: slot.id,
      slotIndex: slot.slot_index,
      ahqTaskId: slot.ahq_task_id,
      state: slot.state,
      worktreePath: slot.worktree_path,
      executingAt: slot.executing_at,
    }));
  }

  async recoverStaleSlots(): Promise<RecoveredSlotInfo[]> {
    return recoverStaleSlotRecords().map((slot) => ({
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      ahqTaskId: slot.ahqTaskId,
      state: slot.state,
      worktreePath: slot.worktreePath,
      executingAt: null,
      reason: slot.reason,
    }));
  }

  pruneHistory(): number {
    return pruneFreedSlots();
  }
}

class PgDispatchSlotBackend implements DispatchSlotBackend {
  readonly name = 'pg' as const;

  async claimSlot(
    ahqTaskId: string,
    branchId: string | null,
    _localTaskId: string,
    worktreePath: string | null,
  ): Promise<SlotClaim | null> {
    const res = await agencyFetch('/dispatch-slots/claim', {
      method: 'POST',
      body: JSON.stringify({ ahq_task_id: ahqTaskId, branch_id: branchId }),
    });

    if (res.status === 409) {
      return null;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[dispatch-slots] claim failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as {
      success: boolean;
      data: { slot_index: number };
    };
    const slotIndex = json.data.slot_index;
    return {
      slotId: slotIndex,
      slotIndex,
      slotJid: workerSlotJid(slotIndex),
      worktreePath,
    };
  }

  async markExecuting(slotId: number): Promise<void> {
    const res = await agencyFetch(`/dispatch-slots/${slotId}/executing`, {
      method: 'PUT',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { slotIndex: slotId, status: res.status, body },
        '[dispatch-slots] markExecuting failed',
      );
    }
  }

  async markReleasing(slotId: number): Promise<void> {
    const res = await agencyFetch(`/dispatch-slots/${slotId}/releasing`, {
      method: 'PUT',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { slotIndex: slotId, status: res.status, body },
        '[dispatch-slots] markReleasing failed',
      );
    }
  }

  async freeSlot(slotId: number): Promise<void> {
    const res = await agencyFetch(`/dispatch-slots/${slotId}`, {
      method: 'DELETE',
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(
        { slotIndex: slotId, status: res.status, body },
        '[dispatch-slots] free failed',
      );
    }
  }

  async listActiveSlots(): Promise<ActiveSlotInfo[]> {
    const res = await agencyFetch('/dispatch-slots/active');
    if (!res.ok) {
      return [];
    }

    const json = (await res.json()) as {
      success: boolean;
      data: Array<{
        slot_index: number;
        ahq_task_id: string;
        status: string;
      }>;
    };

    return (json.data ?? []).map((slot) => ({
      slotId: slot.slot_index,
      slotIndex: slot.slot_index,
      ahqTaskId: slot.ahq_task_id,
      state: slot.status,
      worktreePath: null,
      executingAt: (slot as Record<string, unknown>).executing_at as string | null ?? null,
    }));
  }

  async recoverStaleSlots(): Promise<RecoveredSlotInfo[]> {
    const res = await agencyFetch('/dispatch-slots/reconcile', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Dispatch slot reconcile failed: ${res.status} ${body}`);
    }

    const json = (await res.json()) as {
      success: boolean;
      data: { freed_task_ids: string[] };
    };

    return (json.data?.freed_task_ids ?? []).map((taskId) => ({
      slotId: -1,
      slotIndex: -1,
      ahqTaskId: taskId,
      state: 'reconciled',
      worktreePath: null,
      executingAt: null,
      reason: 'Reconciled in Agency HQ PostgreSQL backend.',
    }));
  }

  pruneHistory(): number {
    return 0;
  }
}

const sqliteBackend = new SqliteDispatchSlotBackend();
const pgBackend = new PgDispatchSlotBackend();

export function getDispatchSlotBackend(): DispatchSlotBackend {
  return isDispatchSlotsPgEnabled() ? pgBackend : sqliteBackend;
}
