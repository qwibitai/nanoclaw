---
name: recipe-watch-drive-changes
description: "Subscribe to change notifications on a Google Drive file or folder."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "engineering"
    requires:
      bins:
        - gws
      skills:
        - gws-events
---

# Watch for Drive Changes

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-events`

Subscribe to change notifications on a Google Drive file or folder.

## Steps

1. Create subscription: `gws events subscriptions create --json '{"targetResource": "//drive.googleapis.com/drives/DRIVE_ID", "eventTypes": ["google.workspace.drive.file.v1.updated"], "notificationEndpoint": {"pubsubTopic": "projects/PROJECT/topics/TOPIC"}, "payloadOptions": {"includeResource": true}}'`
2. List active subscriptions: `gws events subscriptions list`
3. Renew before expiry: `gws events +renew --subscription SUBSCRIPTION_ID`

