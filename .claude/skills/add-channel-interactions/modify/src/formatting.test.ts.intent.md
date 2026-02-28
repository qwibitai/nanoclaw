# Intent: src/formatting.test.ts modifications

## What changed
Added channel-agnosticism tests verifying that msg-id, quote, and attachment formatting works correctly across different channel types.

## Key sections

### msg-id agnosticism tests
- WhatsApp (hex IDs like `BAE5D2F9F95C5B08`) — no msg-id attribute (correct, no prefix)
- Signal (`signal-1709283600`) — gets `msg-id="1709283600:sender"`
- Telegram (`telegram-1709283600`) — gets `msg-id="1709283600:sender"`
- Discord (`discord-1709283600`) — gets `msg-id="1709283600:sender"`
- Numeric-only IDs — no msg-id (no prefix match)
- Empty sender — no msg-id (sender required)

### Quote and attachment tests
- Long quotes truncated to 100 chars with ellipsis
- Attachments rendered as `<attachment>` child elements
- Attachments without filename show type only
- Combined features (msg-id + quote + attachments) work together

## Invariants
- All original escapeXml and formatMessages tests unchanged
- New tests are additive — appended after existing describe blocks
- No test helpers or fixtures modified
