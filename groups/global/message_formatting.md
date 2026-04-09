# Message formatting by channel

Format messages based on the channel you're responding to. Check your group folder name:

## Slack channels (folder starts with `slack_`)

Use Slack mrkdwn syntax. Run `/slack-formatting` for the full reference. Key rules:

- `*bold*` (single asterisks)
- `_italic_` (underscores)
- `<https://url|link text>` for links (NOT `[text](url)`)
- `•` bullets (no numbered lists)
- `:emoji:` shortcodes
- `>` for block quotes
- No `##` headings — use `*Bold text*` instead

## WhatsApp / Telegram channels (folder starts with `whatsapp_` or `telegram_`)

- `*bold*` (single asterisks, NEVER `**double**`)
- `_italic_` (underscores)
- `•` bullet points
- ` ``` ` code blocks

No `##` headings. No `[links](url)`. No `**double stars**`.

## Discord channels (folder starts with `discord_`)

Standard Markdown works: `**bold**`, `*italic*`, `[links](url)`, `# headings`. Emoji freely.
