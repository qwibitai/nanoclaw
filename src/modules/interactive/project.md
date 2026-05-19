## Interactive module

Generic ask_user_question flow. Lives in `src/modules/interactive/`.

The container-side MCP tool `ask_user_question` writes a chat-sdk card to outbound.db and polls inbound.db for a `question_response` system message. The host side of this is split:

- **Inline in `src/delivery.ts`:** the `deliverMessage` path intercepts `content.type === 'ask_question'` messages and writes a row to `pending_questions`. Guarded by `hasTable(db, 'pending_questions')`.
- **This module:** registers a `ResponseHandler` that runs when a button-click arrives via the channel adapter's `onAction`. It looks up the `pending_questions` row, writes a `question_response` system message into the session's inbound.db, wakes the container.

The `pending_questions` table is in the core `001-initial.ts` migration — the module doesn't own the schema, just the behavior. Removing the module disables the button-click response path only; cards are still delivered.

`getAskQuestionRender` in `src/db/sessions.ts` resolves card render metadata for `chat-sdk-bridge.ts`. It reads both `pending_questions` and `pending_approvals` and degrades via `hasTable`. Stays in core.
