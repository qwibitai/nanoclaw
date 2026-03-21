## Intent

Append `import './feishu.js'` to the channel barrel.

This single-line addition causes the Feishu channel module to self-register
via `registerChannel('feishu', ...)` when the application starts.

## Invariants

- The file must end with `import './feishu.js'` on its own line.
- No other imports or code should be changed.
- If any other channel barrel import already exists (e.g. `import './slack.js'`),
  the new line should be appended after it, not before.
