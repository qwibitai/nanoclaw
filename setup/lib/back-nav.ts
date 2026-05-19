/**
 * Channel-flow back-navigation sentinel.
 *
 * Each `runXxxChannel(displayName)` in `setup/channels/` may return either
 * `void` (sub-flow completed normally) or `BACK_TO_CHANNEL_SELECTION` to
 * signal "the user picked '← Back to channel selection' on my first
 * prompt; please re-run the channel chooser." `setup/auto.ts` catches
 * that signal and loops back to `askChannelChoice()`.
 *
 * Back is only offered on the *first* interactive prompt of each channel
 * sub-flow — once the user has answered something, they're committed
 * (subsequent steps may have side effects like opening browsers, hitting
 * APIs, or installing adapter packages, none of which are easily undone).
 */
export const BACK_TO_CHANNEL_SELECTION = Symbol('BACK_TO_CHANNEL_SELECTION');

export type ChannelFlowResult = void | typeof BACK_TO_CHANNEL_SELECTION;
