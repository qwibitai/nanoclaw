---
name: recipe-create-meet-space
description: "Create a Google Meet meeting space and share the join link."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "scheduling"
    requires:
      bins:
        - gws
      skills:
        - gws-meet
        - gws-gmail
---

# Create a Google Meet Conference

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-meet`, `gws-gmail`

Create a Google Meet meeting space and share the join link.

## Steps

1. Create meeting space: `gws meet spaces create --json '{"config": {"accessType": "OPEN"}}'`
2. Copy the meeting URI from the response
3. Email the link: `gws gmail +send --to team@company.com --subject 'Join the meeting' --body 'Join here: MEETING_URI'`

