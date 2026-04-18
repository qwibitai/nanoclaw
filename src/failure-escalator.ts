import type { EventBus } from './event-bus.js';
import type { Action } from './types.js';

interface FailureEscalatorOpts {
  onEscalate: (text: string, actions: Action[]) => void;
}

export class FailureEscalator {
  private unsubscribers: Array<() => void> = [];

  constructor(bus: EventBus, opts: FailureEscalatorOpts) {
    this.unsubscribers.push(
      bus.on('task.complete', (e) => {
        if (e.payload.status !== 'error') return;

        const text = [
          '🚨 <b>Background · failed</b>',
          '',
          `Task <b>${e.payload.taskId}</b> failed after ${Math.round(e.payload.durationMs / 1000)}s.`,
        ].join('\n');

        const actions: Action[] = [
          {
            label: 'Retry',
            callbackData: `retry:${e.payload.taskId}`,
            style: 'primary',
          },
          {
            label: 'View Details ↗',
            callbackData: `details:${e.payload.taskId}`,
            style: 'secondary',
          },
          {
            label: 'Dismiss',
            callbackData: `dismiss:${e.payload.taskId}`,
            style: 'secondary',
          },
        ];

        opts.onEscalate(text, actions);
      }),
    );
  }

  destroy(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
