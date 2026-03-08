# feishu-channel Specification

## Purpose
TBD - created by archiving change upgrade-feishu-channel. Update Purpose after archive.
## Requirements
### Requirement: Post Message Format
FeishuChannel SHALL send all outbound messages using Feishu `post` msg_type with a `zh_cn` locale block, so that Markdown content (code blocks, tables, bold, italic, links, `<at>` mentions) is rendered correctly by Feishu clients.

#### Scenario: Plain text renders as post
- **WHEN** `sendMessage(jid, "hello")` is called
- **THEN** the Feishu API is called with `msg_type: 'post'` and `content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: 'hello' }]] } })`
- **AND** `msg_type: 'text'` is never used

#### Scenario: Long message is chunked as multiple post messages
- **WHEN** `sendMessage(jid, text)` is called with text exceeding 4000 bytes
- **THEN** the text is split into chunks of at most 4000 bytes
- **AND** each chunk is sent as a separate `post` message in sequence

#### Scenario: @mention tag passes through unmodified
- **WHEN** `sendMessage(jid, '<at user_id="ou_xxx">Name</at> done')` is called
- **THEN** the raw `<at>` tag is included verbatim inside the `md` element of the post payload
- **AND** Feishu renders it as a mention notification to that user

### Requirement: Thread Reply
FeishuChannel SHALL reply to the triggering inbound message using `im.message.reply()` so the bot's response appears as a threaded reply in the Feishu conversation.

#### Scenario: Reply uses cached message ID
- **WHEN** `sendMessage(jid, text)` is called and `lastMessageIdByJid[jid]` contains a message ID
- **THEN** the Feishu API is called via `im.message.reply()` with `path.message_id` set to that cached ID
- **AND** the reply carries `msg_type: 'post'`

#### Scenario: No cached message falls back to create
- **WHEN** `sendMessage(jid, text)` is called and no cached message ID exists for that jid
- **THEN** the Feishu API is called via `im.message.create()` with the appropriate `receive_id_type`

#### Scenario: Withdrawn message triggers create fallback
- **WHEN** `im.message.reply()` returns a response with code `230011` or `231003` (message withdrawn)
- **THEN** FeishuChannel retries by calling `im.message.create()` to the same jid
- **AND** no error is surfaced to the caller

