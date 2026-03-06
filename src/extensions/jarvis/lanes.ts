import { MAIN_GROUP_FOLDER } from '../../config.js';
import {
  type LaneAddress,
  type LaneId,
  type LaneKind,
  type RegisteredGroup,
  isJarvisWorkerFolder,
} from '../../types.js';

export type JarvisWorkerLaneId = Extract<
  LaneId,
  'jarvis-worker-1' | 'jarvis-worker-2'
>;

export const MAIN_LANE_ID: LaneId = 'main';
export const ANDY_DEVELOPER_LANE_ID: LaneId = 'andy-developer';
export const JARVIS_WORKER_LANE_IDS: readonly JarvisWorkerLaneId[] = [
  'jarvis-worker-1',
  'jarvis-worker-2',
];

const LANE_KIND_BY_ID: Record<LaneId, LaneKind> = {
  main: 'external',
  'andy-developer': 'agent',
  'jarvis-worker-1': 'worker',
  'jarvis-worker-2': 'worker',
};

const SYNTHETIC_JID_BY_LANE_ID: Partial<Record<LaneId, string>> = {
  'jarvis-worker-1': 'jarvis-worker-1@nanoclaw',
  'jarvis-worker-2': 'jarvis-worker-2@nanoclaw',
};

const LANE_ID_BY_SYNTHETIC_JID: Record<string, JarvisWorkerLaneId> = {
  'jarvis-worker-1@nanoclaw': 'jarvis-worker-1',
  'jarvis-worker-2@nanoclaw': 'jarvis-worker-2',
};

export function isJarvisLaneId(value: string): value is LaneId {
  return (
    value === 'main' ||
    value === 'andy-developer' ||
    value === 'jarvis-worker-1' ||
    value === 'jarvis-worker-2'
  );
}

export function isJarvisWorkerLaneId(
  value: string,
): value is JarvisWorkerLaneId {
  return value === 'jarvis-worker-1' || value === 'jarvis-worker-2';
}

export function getLaneKind(laneId: LaneId): LaneKind {
  return LANE_KIND_BY_ID[laneId];
}

export function getSyntheticLaneJid(laneId: LaneId): string | undefined {
  return SYNTHETIC_JID_BY_LANE_ID[laneId];
}

export function resolveLaneIdFromSyntheticJid(
  jid: string,
): JarvisWorkerLaneId | undefined {
  return LANE_ID_BY_SYNTHETIC_JID[jid];
}

export function isSyntheticWorkerLaneJid(jid: string): boolean {
  return resolveLaneIdFromSyntheticJid(jid) !== undefined;
}

export function resolveLaneIdFromGroupFolder(
  folder: string | null | undefined,
): LaneId | undefined {
  if (!folder) return undefined;
  if (
    folder === MAIN_GROUP_FOLDER ||
    folder === 'main' ||
    folder === 'whatsapp_main'
  ) {
    return MAIN_LANE_ID;
  }
  if (folder === ANDY_DEVELOPER_LANE_ID) {
    return ANDY_DEVELOPER_LANE_ID;
  }
  if (isJarvisWorkerFolder(folder) && isJarvisWorkerLaneId(folder)) {
    return folder;
  }
  return undefined;
}

export function resolveLaneAddress(
  group: RegisteredGroup,
  jid?: string,
): LaneAddress | undefined {
  const laneId = resolveLaneIdFromGroupFolder(group.folder);
  if (!laneId) return undefined;

  const laneKind = getLaneKind(laneId);
  return {
    laneId,
    laneKind,
    syntheticJid: getSyntheticLaneJid(laneId),
    externalChatJid: laneKind === 'worker' ? undefined : jid,
  };
}

export function isInternalWorkerLaneGroup(
  group: RegisteredGroup | undefined,
): boolean {
  if (!group) return false;
  const laneId = resolveLaneIdFromGroupFolder(group.folder);
  return !!laneId && isJarvisWorkerLaneId(laneId);
}
