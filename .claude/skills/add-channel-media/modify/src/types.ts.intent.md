# Intent: src/types.ts modifications

## What changed
Added media-related interfaces and extended existing types to support media attachments.

## Key additions

### New interfaces
- **MediaAttachment**: Represents a media attachment reference (id, filename, mimetype, size). Used in NewMessage.attachments and throughout the media pipeline.
- **MediaSendOptions**: Options for outbound media (caption, filename, mimetype). Used by Channel.sendMedia().

### Extended interfaces
- **NewMessage**: Added optional `attachments?: MediaAttachment[]` field. Messages with media carry attachment metadata alongside text content.
- **Channel**: Added two optional methods:
  - `sendMedia?(jid: string, filePath: string, options?: MediaSendOptions): Promise<void>` — Send a file to a chat
  - `downloadMedia?(ref: unknown): Promise<Buffer>` — Download media from channel-specific reference

## Invariants
- All existing interfaces and types are unchanged
- New interfaces are additive only
- Channel media methods are optional (channels without media support are unaffected)
- MediaAttachment.id follows the URI format `{channel}:media:{uid}`

## Must-keep
- All existing type exports (AdditionalMount, MountAllowlist, ContainerConfig, RegisteredGroup, etc.)
- All existing Channel interface methods
- OnInboundMessage and OnChatMetadata callback types
