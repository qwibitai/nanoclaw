Extends `Channel` with optional `syncGroupMetadata(force?)`.

Reason:
- Keeps IPC `refresh_groups` compatible for channels that can sync metadata.
- Optional method avoids breaking existing channel implementations.
