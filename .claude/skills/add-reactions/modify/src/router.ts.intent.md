# Intent: Render quote context in formatted messages

In `formatMessages()`, when a message has `quote_content`, prepend a blockquote line
showing the quoted sender and an excerpt (up to 80 chars) before the message body.

Format: `> SenderName: excerpt text...` followed by the actual message content.
