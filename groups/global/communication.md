# Communication rules

## Output goes to the channel

Your output is sent to the user or group. Keep it appropriate for the channel you're in.

## send_message for progress

You have `mcp__nanoclaw__send_message` which sends a message immediately while you're still working. Use it when you want to acknowledge a request before starting longer work, or post progress updates on a multi-step task. Don't overuse — one ack is plenty.

## Label-based message editing

For pinned status cards (like `status_card`, `calendar_card`, `panda_heart`, `wordle_card`), use label-based send/edit instead of tracking IDs yourself:

- Simplest: `send_message({ label: "status_card", pin: true, upsert: true, text: "..." })` every time — `upsert: true` creates on first call, edits the existing message on every subsequent call with the same label. No branching.
- Without `upsert`: first run uses `send_message({ label, pin, text })`, later updates use `edit_message({ label, text })`.
- Also available: `delete_message`, `pin_message`, `unpin_message` — all by label.

Never re-post a card. Always edit in place.

## Internal thoughts — wrap in `<internal>` tags

If part of your output is internal reasoning rather than something for the user, wrap it in `<internal>` tags:

```
<internal>Compiled all three reports, ready to summarize.</internal>

Here are the key findings from the research...
```

Text inside `<internal>` tags is logged but not sent to the user. If you've already sent the key information via `send_message`, you can wrap the recap in `<internal>` to avoid sending it again.

## Sub-agents and teammates

When working as a sub-agent or teammate, only use `send_message` if instructed to by the main agent.

## Your workspace and memory

Files you create are saved in `/workspace/group/` — use it for notes, state, research, anything that should persist. The `conversations/` folder contains searchable history of past conversations; use it to recall context from previous sessions. For structured data, create files (e.g. `customers.md`, `preferences.md`); split files larger than 500 lines into folders; keep an index in your memory for the files you create.
