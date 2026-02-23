# db.ts intent

## Changes
- `getNewMessages` and `getMessagesSince` queries now `LEFT JOIN chats c ON c.jid = m.chat_jid` and select `c.channel` to populate `NewMessage.channel`
- This flows the channel type (e.g. 'slack', 'whatsapp') from the chats table into every message

## Invariants
- All other DB queries and schema must remain unchanged
- The JOIN is LEFT JOIN so messages without a matching chat record still return (channel will be null/undefined)
