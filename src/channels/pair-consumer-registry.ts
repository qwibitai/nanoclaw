/**
 * Pair-consumer registry.
 *
 * After a wire-to pairing has done the bare minimum (paired user
 * recorded, messaging group wired to the agent group), registered
 * consumers run to do whatever feature-specific work the channel
 * shouldn't know about. The class feature uses this for: stamp
 * agent_groups.metadata with student details, create the Drive
 * folder, build a tailored welcome message.
 *
 * Each consumer returns a `PairResult`. The channel adapter is
 * responsible for delivering whichever confirmation message is
 * ultimately appropriate:
 *   - If any consumer set `suppressDefaultConfirmation: true`, the
 *     generic "Pairing success!" reply is skipped; the channel
 *     sends the consumer-provided `confirmation` strings instead.
 *   - Otherwise the channel sends the generic confirmation.
 *
 * Multiple consumers can register; they all run sequentially and
 * their results are combined. A consumer that doesn't want to
 * affect the response can return `{}` (or omit both fields).
 */

export interface PairContext {
  /** Agent group the pairing wired to (always set for wire-to flow). */
  agentGroupId: string;
  /** User ID that was paired, in `<channel>:<id>` form. */
  pairedUserId: string;
  /** Email captured alongside the pairing code, if the channel extracts one. */
  consumedEmail: string | null;
  /** Folder name on disk for the wired agent group. */
  targetFolder: string;
  /** Originating channel — 'telegram', 'discord', etc. Reserved for future use. */
  channel: string;
}

export interface PairResult {
  /** Optional message text for the channel to deliver. */
  confirmation?: string;
  /**
   * When true, suppresses the channel's default "Pairing success!"
   * confirmation. The consumer's own `confirmation` (if any) is
   * delivered instead. Only one consumer needs to set this for the
   * default to be suppressed.
   */
  suppressDefaultConfirmation?: boolean;
}

export type PairConsumer = (ctx: PairContext) => Promise<PairResult>;

const consumers: PairConsumer[] = [];

/**
 * Append a consumer. Multiple consumers can register; they all run
 * in registration order. Each consumer runs even if a previous one
 * threw — the registry catches and logs (via the channel's error
 * path) so one buggy extension can't break pairing.
 */
export function registerPairConsumer(consumer: PairConsumer): void {
  consumers.push(consumer);
}

/**
 * Run all registered consumers sequentially. Returns the combined
 * list of `PairResult`s for the channel to act on. An exception
 * from a consumer is converted to an empty result + a warning;
 * pairing succeeds regardless.
 *
 * Sequential rather than parallel because consumers may write to
 * the same metadata blob (last writer wins; ordering matters).
 */
export async function runPairConsumers(
  ctx: PairContext,
  onError?: (consumerIndex: number, err: unknown) => void,
): Promise<PairResult[]> {
  const out: PairResult[] = [];
  for (let i = 0; i < consumers.length; i++) {
    try {
      out.push(await consumers[i](ctx));
    } catch (err) {
      onError?.(i, err);
      out.push({});
    }
  }
  return out;
}

/** Test hook — clear the consumer chain. */
export function _resetConsumersForTest(): void {
  consumers.length = 0;
}
