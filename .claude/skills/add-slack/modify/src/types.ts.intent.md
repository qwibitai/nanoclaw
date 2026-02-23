# types.ts intent

## Changes
- Added optional `sendFile?(jid, filePath, comment?)` to `Channel` interface — lets channels that support it (e.g. Slack) send file attachments
- Added optional `channel?: string` to `NewMessage` interface — populated from the `chats` table so the agent knows which channel (slack/whatsapp) a message came from

## Invariants
- All existing Channel interface methods must remain unchanged
- NewMessage interface fields must remain unchanged; only additions allowed
