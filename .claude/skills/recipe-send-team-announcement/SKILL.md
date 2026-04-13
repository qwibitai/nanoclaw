---
name: recipe-send-team-announcement
description: "Send a team announcement via both Gmail and a Google Chat space."
metadata:
  version: 0.22.0
  openclaw:
    category: "recipe"
    domain: "communication"
    requires:
      bins:
        - gws
      skills:
        - gws-gmail
        - gws-chat
---

# Announce via Gmail and Google Chat

> **PREREQUISITE:** Load the following skills to execute this recipe: `gws-gmail`, `gws-chat`

Send a team announcement via both Gmail and a Google Chat space.

## Steps

1. Send email: `gws gmail +send --to team@company.com --subject 'Important Update' --body 'Please review the attached policy changes.'`
2. Post in Chat: `gws chat +send --space spaces/TEAM_SPACE --text '📢 Important Update: Please check your email for policy changes.'`

