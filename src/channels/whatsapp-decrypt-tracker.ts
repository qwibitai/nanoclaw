/**
 * Decrypt-failure tracker for the WhatsApp adapter.
 *
 * libsignal-node throws "Bad MAC" when the Signal Protocol ratchet between
 * the local Baileys client and a remote peer desyncs (typically after a
 * socket reconnect). Baileys catches the failure and emits a stub message
 * with messageStubType=CIPHERTEXT — the plaintext is lost.
 *
 * Without this tracker, those failures only surface in nanoclaw.error.log
 * and the operator finds out by noticing missing replies hours later. The
 * tracker maintains per-sender counters with a sliding window; when a
 * sender crosses the threshold, the adapter sends an operator alert via
 * a different Signal session that's still healthy.
 */

export interface DecryptFailureState {
  count: number;
  firstAt: number;
  lastAlertAt?: number;
}

export interface DecryptFailureConfig {
  /** Number of failures within `windowMs` that triggers an alert. */
  thresholdCount: number;
  /** Sliding window for failure accumulation. */
  windowMs: number;
  /** Suppress repeat alerts for the same sender for this long after one fires. */
  alertCooldownMs: number;
}

export const DEFAULT_DECRYPT_FAILURE_CONFIG: DecryptFailureConfig = {
  thresholdCount: 3,
  windowMs: 60_000,
  alertCooldownMs: 10 * 60_000,
};

export interface TrackDecryptFailureResult {
  state: DecryptFailureState;
  shouldAlert: boolean;
}

/**
 * Pure state machine: record one decrypt failure and decide whether to alert.
 *
 * - The sliding window resets when more than `windowMs` has elapsed since the
 *   first failure in the current window. `lastAlertAt` survives the reset so
 *   cooldown applies across windows.
 * - An alert fires only when the threshold is reached AND the cooldown has
 *   elapsed. Firing updates `lastAlertAt` to start a fresh cooldown.
 */
export function trackDecryptFailure(
  prev: DecryptFailureState | undefined,
  now: number,
  config: DecryptFailureConfig = DEFAULT_DECRYPT_FAILURE_CONFIG,
): TrackDecryptFailureResult {
  const inWindow = prev !== undefined && now - prev.firstAt <= config.windowMs;
  const state: DecryptFailureState = inWindow
    ? { count: prev!.count, firstAt: prev!.firstAt, lastAlertAt: prev!.lastAlertAt }
    : { count: 0, firstAt: now, lastAlertAt: prev?.lastAlertAt };

  state.count += 1;

  if (state.count < config.thresholdCount) {
    return { state, shouldAlert: false };
  }

  if (state.lastAlertAt !== undefined && now - state.lastAlertAt < config.alertCooldownMs) {
    return { state, shouldAlert: false };
  }

  state.lastAlertAt = now;
  return { state, shouldAlert: true };
}
