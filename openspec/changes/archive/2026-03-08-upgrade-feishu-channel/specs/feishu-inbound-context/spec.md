## ADDED Requirements

### Requirement: Post Message Inbound Parsing
FeishuChannel SHALL parse inbound messages of type `post` (rich text) into plain Markdown text using `parsePostContent`, so the agent receives readable content instead of raw JSON.

#### Scenario: Post text is extracted to Markdown
- **WHEN** an inbound message with `message_type: 'post'` arrives
- **THEN** `parsePostContent` is called on the raw content
- **AND** the resulting `textContent` is used as the message `content` field delivered to the agent
- **AND** the raw JSON is not forwarded

#### Scenario: Unsupported post elements degrade gracefully
- **WHEN** a post message contains elements with unrecognized tags
- **THEN** FeishuChannel still delivers the extracted text content
- **AND** unknown elements are omitted without throwing

### Requirement: Quoted Message Context
FeishuChannel SHALL fetch and prepend the content of a quoted (replied-to) message when an inbound message has a `parent_id`, so the agent can see the full conversation context.

#### Scenario: Quoted message is prepended
- **WHEN** an inbound message has a non-empty `parent_id`
- **THEN** FeishuChannel calls `im.message.get()` with that `parent_id`
- **AND** the resolved text is prepended to `content` as `[Quoted: <text>]\n<original content>`

#### Scenario: Quoted fetch failure does not block delivery
- **WHEN** `im.message.get()` for the `parent_id` fails or returns no data
- **THEN** the message is still delivered with its original content
- **AND** no error is thrown

#### Scenario: Quoted post message is parsed
- **WHEN** the quoted message has `msg_type: 'post'`
- **THEN** its content is parsed via `parsePostContent` before prepending

### Requirement: Media Download
FeishuChannel SHALL download inbound media attachments (`image`, `file`, `audio`) and embedded images in `post` messages to the group's media directory, appending the local file path to message content so the agent can access the file.

#### Scenario: Standalone image message is downloaded
- **WHEN** an inbound message has `message_type: 'image'`
- **THEN** FeishuChannel downloads the image via `im.messageResource.get()` with `type: 'image'`
- **AND** saves it to `groups/{folder}/media/{timestamp}_{filename}`
- **AND** sets `content` to `[Downloaded: <path>]`

#### Scenario: Standalone file message is downloaded
- **WHEN** an inbound message has `message_type: 'file'` or `message_type: 'audio'`
- **THEN** FeishuChannel downloads via `im.messageResource.get()` with `type: 'file'`
- **AND** saves it to `groups/{folder}/media/{timestamp}_{filename}`
- **AND** sets `content` to `[Downloaded: <path>]`

#### Scenario: Embedded images in post message are downloaded
- **WHEN** `parsePostContent` returns one or more `imageKeys` from a `post` message
- **THEN** each image is downloaded via `im.messageResource.get()` with `type: 'image'`
- **AND** each saved path is appended to `content` as `\n[Image: <path>]`

#### Scenario: Download failure produces placeholder
- **WHEN** the media download API call throws or returns an error
- **THEN** content is set to `[<type>: unable to download]` for standalone media
- **AND** the failed image is silently skipped (not appended) for embedded post images

#### Scenario: Unregistered group skips media download
- **WHEN** an inbound media message arrives for a jid with no registered group
- **THEN** no download is attempted
- **AND** the message is dropped as per the existing unregistered-group policy
