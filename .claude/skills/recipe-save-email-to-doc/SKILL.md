---
name: recipe-save-email-to-doc
description: "Save a Gmail message body into a Google Doc for archival or reference."
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
        - gws-docs
---

# Save a Gmail Message to Google Docs

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-gmail`, `gws-docs`

Save a Gmail message body into a Google Doc for archival or reference.

## Steps

1. Find the message: `gws gmail users messages list --params '{"userId": "me", "q": "subject:important from:boss@company.com"}' --format table`
2. Get message content: `gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID"}'`
3. Create a doc with the content: `gws docs documents create --json '{"title": "Saved Email - Important Update"}'`
4. Write the email body: `gws docs +write --document-id DOC_ID --text 'From: boss@company.com
Subject: Important Update

[EMAIL BODY]'`

