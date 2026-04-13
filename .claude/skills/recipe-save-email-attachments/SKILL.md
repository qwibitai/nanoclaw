---
name: recipe-save-email-attachments
description: "Find Gmail messages with attachments and save them to a Google Drive folder."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "productivity"
    requires:
      bins:
        - gws
      skills:
        - gws-gmail
        - gws-drive
---

# Save Gmail Attachments to Google Drive

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-gmail`, `gws-drive`

Find Gmail messages with attachments and save them to a Google Drive folder.

## Steps

1. Search for emails with attachments: `gws gmail users messages list --params '{"userId": "me", "q": "has:attachment from:client@example.com"}' --format table`
2. Get message details: `gws gmail users messages get --params '{"userId": "me", "id": "MESSAGE_ID"}'`
3. Download attachment: `gws gmail users messages attachments get --params '{"userId": "me", "messageId": "MESSAGE_ID", "id": "ATTACHMENT_ID"}'`
4. Upload to Drive folder: `gws drive +upload --file ./attachment.pdf --parent FOLDER_ID`

