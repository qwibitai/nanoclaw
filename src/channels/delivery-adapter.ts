/**
 * Delivery adapter bridge — dispatches outbound messages to whichever
 * channel adapter owns the target `channelType`.
 *
 * The bug this module's behaviour fixes: previously this lambda lived
 * inline in `src/index.ts` and silently returned `undefined` when no
 * adapter was registered for a channel. The caller in `src/delivery.ts`
 * then wrote `markDelivered(msg.id, undefined)` — a row with
 * `status='delivered'` and `platform_message_id=NULL`. Net result: a
 * message that never left the host was indistinguishable in the DB from
 * one that was successfully sent. Operators saw `delivered: delivered`
 * for a row that had in fact been dropped.
 *
 * The pattern is the delivery-side cousin of the silent-task-failure bug
 * fixed in PR #2167. Same shape: a code path that should propagate
 * "I didn't do the thing" instead collapses it to "I did the thing".
 *
 * The fix: throw `MissingChannelAdapterError` instead of returning
 * undefined. The retry loop in `deliverSessionMessages` (delivery.ts)
 * already has the right shape — three attempts then `markDeliveryFailed`
 * — so the row ends as `status='failed'` and is visible to operators.
 *
 * `setTyping` keeps its tolerant behaviour: a missing adapter shouldn't
 * block typing-indicator suppression, and there's no persistent state
 * for it to corrupt.
 */
import type { ChannelDeliveryAdapter } from '../delivery.js';
import type { ChannelAdapter, OutboundFile } from './adapter.js';

export class MissingChannelAdapterError extends Error {
  constructor(public readonly channelType: string) {
    super(
      `No adapter registered for channel type '${channelType}'. ` +
        `The message cannot be delivered — verify the channel adapter started successfully ` +
        `at host startup (search the log for "Channel adapter started channel=\\"${channelType}\\"").`,
    );
    this.name = 'MissingChannelAdapterError';
  }
}

export interface CreateDeliveryAdapterDeps {
  /**
   * Resolves a channel adapter by channelType. Returns null/undefined when
   * no adapter is registered.
   *
   * Injected so tests can drive the factory without spinning up the full
   * channel registry.
   */
  getChannelAdapter: (channelType: string) => ChannelAdapter | null | undefined;
}

/**
 * Build the delivery adapter bridge passed to `setDeliveryAdapter`.
 *
 * On `deliver`: if no channel adapter is registered for `channelType`,
 * throw `MissingChannelAdapterError`. The exception propagates up to
 * `deliverSessionMessages` in delivery.ts, which retries up to three
 * times then calls `markDeliveryFailed` — the row ends as
 * `status='failed'` instead of being silently marked delivered with a
 * NULL platform message id.
 *
 * On `setTyping`: tolerant of a missing adapter. Typing indicators are
 * advisory; not having an adapter to send the indicator to isn't a
 * delivery failure and we have no persistent state to corrupt.
 */
export function createDeliveryAdapter(deps: CreateDeliveryAdapterDeps): ChannelDeliveryAdapter {
  return {
    async deliver(
      channelType: string,
      platformId: string,
      threadId: string | null,
      kind: string,
      content: string,
      files?: OutboundFile[],
    ): Promise<string | undefined> {
      const adapter = deps.getChannelAdapter(channelType);
      if (!adapter) {
        throw new MissingChannelAdapterError(channelType);
      }
      return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content), files });
    },
    async setTyping(channelType: string, platformId: string, threadId: string | null): Promise<void> {
      const adapter = deps.getChannelAdapter(channelType);
      await adapter?.setTyping?.(platformId, threadId);
    },
  };
}
