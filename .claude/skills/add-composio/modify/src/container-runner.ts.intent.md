# Intent: container-runner.ts changes for add-composio

## What changed

Added Composio API key injection inside `buildContainerArgs()`, after the
`--user`/`HOME` uid/gid block and before the volume mounts loop.

Reads the API key from `~/.composio/api.key` on the host. If the file
exists and is non-empty, passes it to the container via `-e COMPOSIO_API_KEY=<key>`.

## Invariants

- The injection is conditional (`fs.existsSync`) — if the user has not yet
  configured Composio, no env var is added and NanoClaw starts normally
  without Composio access.
- The `os` module is already imported (added by the add-google-drive skill).
  No new import is needed.
- The file is read synchronously (consistent with the existing secrets
  pattern in the file) and trimmed to remove trailing newlines.
- All existing `-e` flags, mounts, and the rest of `buildContainerArgs` are
  unchanged.
