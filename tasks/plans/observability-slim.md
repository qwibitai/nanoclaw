# Observability + UX slim PR

Three small, infrastructure-shaped changes bundled because they share review surface but DO NOT belong with any sibling PR. The previous attempt (closed for scope creep) bolted on `/celebrate` and a complete media pipeline; this slim version keeps to the explicit three.

## Scope

1. **Sentry init.** `package.json` adds `@sentry/node` ^8.55.2. New `src/sentry-init.ts` calls `Sentry.init({ dsn, environment, tracesSampleRate: 0, sendDefaultPii: false })` if `SENTRY_DSN` is set, returns false otherwise (local dev runs untouched). Imported FIRST in `src/index.ts` so the SDK installs global handlers before any other module load can throw. The `setImmediate(() => processUpdate(...))` in `src/channels/baget-telegram.ts` adds `Sentry.captureException(err, { tags: { source: 'baget-telegram-webhook' }, extra: { updateId } })` alongside the existing `log.error` so detached webhook errors actually surface.

2. **Structured `delivery_failure` log.** `sendBagetBotMessage` in `src/channels/baget-telegram-bind.ts` now requires `agentGroupId: string | null` and emits the cross-repo contract:
   ```ts
   log.warn('Baget channel delivery_failure', {
     kind: 'delivery_failure',
     channelType: 'baget-telegram',
     agentGroupId,
     chatId,
     telegramErrorCode,
     telegramDescription,
     founderActionRequired,
     attempt: 1,
   })
   ```
   Same shape used by `/celebrate` (#19). Three transport-failure paths emit it: non-OK response, 200-with-malformed-body, and network throw — extracted into a small `emitTelegramDeliveryFailure` helper to keep the three callsites in sync.
   `sendBagetTelegramWelcome`, `sendBagetTelegramFarewell` take `agentGroupId: string` and pass through. The local `sendBotMessage` in `baget-telegram.ts` is now a thin shim over `sendBagetBotMessage` so EVERY transport failure in the adapter emits the same shape uniformly. `deliver()` resolves `agentGroupId` from the messaging_group up front so celebrations + persona-prefixed text both carry it.

3. **Pairing failure-msg deeplink.** `FAILURE_MSG` in `handleStartCommand` now reads `process.env.BAGET_DASHBOARD_URL` (default `https://app.baget.ai`) and constructs `"That pairing link isn't valid or has expired. Tap here to get a fresh one: ${BAGET_DASHBOARD_URL}/team"` — turns the typo case into a one-tap recovery instead of a support ticket.

## Out of scope (do NOT add here)

- ❌ `/celebrate` endpoint or batch-completion logic — PR #19 (already merged)
- ❌ Inbound or outbound media handling, attachments, file uploads — PR #18 (already merged)
- ❌ Bot-pool changes — PR #16
- ❌ Inbound debouncer changes — PR #14
- ❌ Test-fixture extraction across `*-farewell.test.ts` / `*-outbound-media.test.ts` — would force touching media-PR territory; defer until channel #4

## Tests

`447` baseline → `458` total (`+11` new):

- `src/sentry-init.test.ts` — DSN unset → no init; DSN set → init exactly once with spec shape; idempotent second call (uses `Sentry.isInitialized()` from the SDK).
- `src/channels/baget-telegram-delivery-failure.test.ts` — non-OK shape with errorCode + description; `founderActionRequired` flag detection; transport throw with `agentGroupId: null`; success path (no log); `200`-with-malformed-body emits delivery_failure too.
- `src/channels/baget-telegram.test.ts` — `deliver()` plumbs the resolved `agentGroupId` into the structured log on transport error; FAILURE_MSG default URL; FAILURE_MSG `BAGET_DASHBOARD_URL` env override.
- `src/channels/baget-telegram-farewell.test.ts` — updated to pass the new required `agentGroupId`.

Mocks `@sentry/node` everywhere — never hits real Sentry servers.

## Cross-repo follow-up (NOT this PR)

Dashboard (apps/web/) consumes `kind: 'delivery_failure'` events to surface "your team tried to reach you and couldn't" UX. Same shape used by `/celebrate` — same dashboard handler.
