# router.ts intent

## Changes
- `formatMessages` now reads `channel` from `messages[0]?.channel` and emits it as an attribute on the `<messages>` wrapper: `<messages channel="slack">`
- This lets the agent know which channel the conversation is on

## Invariants
- All other formatting logic (escapeXml, message format, stripInternalTags, etc.) must remain unchanged
- Falls back to `'unknown'` if channel is not set
