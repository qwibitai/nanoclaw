import fs from 'fs';
import path from 'path';

export type SupportedLaneId = 'andy-developer';

export interface ControlPlaneRequestStatus {
  [key: string]: unknown;
  request_id: string;
  state: string;
  worker_run_id?: string;
  worker_group_folder?: string;
  last_status_text?: string;
  last_progress_summary?: string;
  updated_at: string;
}

export interface ControlPlaneLaneStatus {
  [key: string]: unknown;
  lane_id: SupportedLaneId;
  availability: 'idle' | 'busy' | 'queued' | 'offline';
  active_request_id?: string;
  active_run_id?: string;
  summary: string;
  updated_at?: string;
  active_requests: ControlPlaneRequestStatus[];
}

export interface ControlPlaneStatusSnapshot {
  generated_at: string;
  lanes: Partial<Record<SupportedLaneId, ControlPlaneLaneStatus>>;
}

const DEFAULT_LANE_ID: SupportedLaneId = 'andy-developer';
const CONTROL_PLANE_STATUS_PATH = path.join(
  '/workspace/ipc',
  'control_plane_status.json',
);

type ToolResponse = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: ControlPlaneLaneStatus;
  isError?: boolean;
};

function formatAvailability(status: ControlPlaneLaneStatus): string {
  switch (status.availability) {
    case 'busy':
      return 'Andy Developer is busy.';
    case 'queued':
      return 'Andy Developer has queued work.';
    case 'offline':
      return 'Andy Developer is offline.';
    case 'idle':
    default:
      return 'Andy Developer is idle.';
  }
}

export function readControlPlaneStatusSnapshot(
  snapshotPath = CONTROL_PLANE_STATUS_PATH,
): ControlPlaneStatusSnapshot {
  const raw = fs.readFileSync(snapshotPath, 'utf8');
  return JSON.parse(raw) as ControlPlaneStatusSnapshot;
}

export function buildLaneStatusToolResponse(
  laneId: string | undefined,
  options: {
    isMain: boolean;
    snapshotPath?: string;
  },
): ToolResponse {
  if (!options.isMain) {
    return {
      content: [
        {
          type: 'text',
          text: 'Only the main lane can read control-plane lane status.',
        },
      ],
      isError: true,
    };
  }

  const resolvedLaneId = laneId ?? DEFAULT_LANE_ID;

  if (resolvedLaneId !== DEFAULT_LANE_ID) {
    return {
      content: [
        {
          type: 'text',
          text: `Unsupported lane status target: ${resolvedLaneId}`,
        },
      ],
      isError: true,
    };
  }

  let snapshot: ControlPlaneStatusSnapshot;
  try {
    snapshot = readControlPlaneStatusSnapshot(options.snapshotPath);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Control-plane status is temporarily unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      isError: true,
    };
  }

  const laneStatus = snapshot.lanes['andy-developer'];
  if (!laneStatus) {
    return {
      content: [
        {
          type: 'text',
          text: 'No control-plane status snapshot is available for andy-developer yet.',
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: `${formatAvailability(laneStatus)} ${laneStatus.summary}`.trim(),
      },
    ],
    structuredContent: laneStatus,
  };
}
