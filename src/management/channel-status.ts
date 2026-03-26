import type { Channel } from '../types.js';

export interface ChannelStatus {
  id: string;
  connected: boolean;
  error?: string;
}

export interface StatusReport {
  channels: ChannelStatus[];
}

export interface ReporterOptions {
  intervalMs?: number;
  emit?: (event: string, payload: StatusReport) => void;
}

export class ChannelStatusReporter {
  private channels: Map<string, Channel>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private opts: Required<ReporterOptions>;

  constructor(channels: Map<string, Channel>, opts: ReporterOptions = {}) {
    this.channels = channels;
    this.opts = {
      intervalMs: opts.intervalMs ?? 30_000,
      emit: opts.emit ?? (() => {}),
    };
  }

  getStatus(): StatusReport {
    const statuses: ChannelStatus[] = [];
    for (const [id, channel] of this.channels) {
      statuses.push({
        id,
        connected: channel.isConnected(),
        error: undefined,
      });
    }
    return { channels: statuses };
  }

  start(): void {
    this.stop();
    this.interval = setInterval(() => {
      this.opts.emit('channels.status', this.getStatus());
    }, this.opts.intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
