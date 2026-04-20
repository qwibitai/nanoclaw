export type SubsystemClassification =
  | 'production'
  | 'internal'
  | 'experimental'
  | 'dormant';

export type SubsystemState = 'running' | 'degraded' | 'disabled' | 'on-demand';

export interface SubsystemStatus {
  id: string;
  label: string;
  classification: SubsystemClassification;
  state: SubsystemState;
  details: string;
  updatedAt: string;
}

const subsystemDefaults: Array<Omit<SubsystemStatus, 'updatedAt'>> = [
  {
    id: 'credential-proxy',
    label: 'Credential proxy',
    classification: 'production',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'skill-registry',
    label: 'Skill registry',
    classification: 'production',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'scheduler',
    label: 'Task scheduler',
    classification: 'production',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'agency-dispatch',
    label: 'Agency HQ dispatch',
    classification: 'internal',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'stall-detector',
    label: 'Stall detector',
    classification: 'internal',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'ipc',
    label: 'IPC watcher',
    classification: 'production',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'host-exec',
    label: 'Host exec watcher',
    classification: 'internal',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'uptime-monitor',
    label: 'Uptime monitor',
    classification: 'internal',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'remote-control',
    label: 'Remote control',
    classification: 'experimental',
    state: 'on-demand',
    details: 'Available only when a main-group operator starts a session.',
  },
  {
    id: 'transcript-archiver',
    label: 'Transcript archiver',
    classification: 'internal',
    state: 'on-demand',
    details: 'Used by /clear archival flows.',
  },
  {
    id: 'sprint-retro-watcher',
    label: 'Sprint retro watcher',
    classification: 'internal',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'message-api',
    label: 'Message API',
    classification: 'production',
    state: 'disabled',
    details: 'Not started yet.',
  },
  {
    id: 'meeting-engine',
    label: 'Meeting engine',
    classification: 'experimental',
    state: 'disabled',
    details:
      'Types and tests exist, but the subsystem is not wired into startup.',
  },
];

const subsystemRegistry = new Map<string, SubsystemStatus>(
  subsystemDefaults.map((entry) => [
    entry.id,
    {
      ...entry,
      updatedAt: new Date().toISOString(),
    },
  ]),
);

export function setSubsystemState(
  id: string,
  updates: Pick<SubsystemStatus, 'state' | 'details'>,
): void {
  const existing = subsystemRegistry.get(id);
  if (!existing) {
    return;
  }

  subsystemRegistry.set(id, {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

export function getSubsystemStatuses(): SubsystemStatus[] {
  return [...subsystemRegistry.values()].sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

export function _resetSubsystemStatusesForTesting(): void {
  subsystemRegistry.clear();
  for (const entry of subsystemDefaults) {
    subsystemRegistry.set(entry.id, {
      ...entry,
      updatedAt: new Date().toISOString(),
    });
  }
}
