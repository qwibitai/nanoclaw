import { getRegisteredChannelNames } from './channels/registry.js';
import { loadCredentialStateSync } from './credentials.js';
import { getRuntimeStatus } from './runtime-adapter.js';
import { getSubsystemStatuses } from './subsystem-status.js';
import type { Channel, RegisteredGroup } from './types.js';

import { CircuitState, getChannelHealth } from './circuit-breaker.js';

export interface ServiceHealthSnapshot {
  service: 'nanoclaw';
  status: 'ok' | 'degraded';
  timestamp: string;
  degradedReasons: string[];
  runtime: {
    kind: string;
    displayName: string;
    isolation: string;
    ready: boolean;
    activeSessionCount: number;
  };
  credentials: {
    authMode: string;
    source: string;
  };
  channels: {
    registered: string[];
    active: Array<{
      name: string;
      connected: boolean;
      circuitState: CircuitState;
      consecutiveFailures: number;
    }>;
  };
  registeredGroupCount: number;
  subsystems: ReturnType<typeof getSubsystemStatuses>;
}

export function buildServiceHealthSnapshot(
  channels: Channel[],
  registeredGroups: Record<string, RegisteredGroup>,
): ServiceHealthSnapshot {
  const runtimeStatus = getRuntimeStatus();
  const credentialState = loadCredentialStateSync();
  const registeredChannelNames = getRegisteredChannelNames();
  const activeChannels = channels.map((channel) => {
    const health = getChannelHealth(channel.name);
    return {
      name: channel.name,
      connected: channel.isConnected(),
      circuitState: health.state,
      consecutiveFailures: health.consecutiveFailures,
    };
  });
  const subsystems = getSubsystemStatuses();

  const degradedReasons: string[] = [];
  if (!runtimeStatus.ready) {
    degradedReasons.push('runtime dependency unavailable');
  }
  if (registeredChannelNames.length === 0) {
    degradedReasons.push('no channel handlers registered');
  }
  if (channels.length === 0) {
    degradedReasons.push('no channels instantiated');
  } else if (!channels.some((channel) => channel.isConnected())) {
    degradedReasons.push('no channels connected');
  }
  if (
    subsystems.some(
      (subsystem) =>
        subsystem.classification === 'production' &&
        subsystem.state !== 'running' &&
        subsystem.state !== 'on-demand',
    )
  ) {
    degradedReasons.push('production subsystem not healthy');
  }

  return {
    service: 'nanoclaw',
    status: degradedReasons.length === 0 ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    degradedReasons,
    runtime: {
      kind: runtimeStatus.descriptor.kind,
      displayName: runtimeStatus.descriptor.displayName,
      isolation: runtimeStatus.descriptor.isolation,
      ready: runtimeStatus.ready,
      activeSessionCount: runtimeStatus.activeSessions.length,
    },
    credentials: {
      authMode: credentialState.authMode,
      source: credentialState.credentialSource,
    },
    channels: {
      registered: registeredChannelNames,
      active: activeChannels,
    },
    registeredGroupCount: Object.keys(registeredGroups).length,
    subsystems,
  };
}
