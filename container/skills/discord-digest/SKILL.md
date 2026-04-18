---
name: discord-digest
description: Generate and send a daily Discord digest summarizing activity across all monitored servers. Run manually or scheduled at 9 AM daily.
---

# Discord Daily Digest

Generate a summary of Discord activity from the past 24 hours across all servers the Safeclawd Dev bot has access to, and DM it to Jonathan.

## Configuration

```
BOT_TOKEN: from DISCORD_BOT_TOKEN env var
DM_CHANNEL_ID: 1483524392649752638
SERVERS:
  - WhoisXML API Inc (967207972876980284)
  - Inbox SuperPilot (1474510000524230678)
```

## When triggered

Run this skill daily at 9 AM, or when the user asks for a Discord digest.

## Steps

1. For each server, fetch messages from the past 24 hours across all text channels
2. Skip channels in categories named "CLOSED" or with no activity
3. Group messages by channel and summarize:
   - Key discussions and decisions
   - Action items or requests (especially in #*-requests channels)
   - @mentions of Jonathan
   - Important announcements (in #*-news channels)
4. Format as a structured digest and DM to Jonathan via Discord

## Digest format

```
**📋 Daily Discord Digest — Apr 10, 2026**

**WhoisXML API Inc**

🔴 **Action items for you:**
• [#engineering-requests] Mike asked for API rate limit increase for Acme Corp
• [#management-requests] Sarah needs budget approval for Q3 tooling

📢 **Key announcements:**
• [#product-news] v3.2 DNS lookup API released
• [#revenue-news] Q1 ARR target hit at 103%

💬 **Active discussions:**
• [#api-development] Team debating GraphQL vs REST for v4 (12 messages)
• [#threat-research] New phishing campaign targeting financial sector

👤 **You were mentioned:**
• [#product-management] @jonathan.zhang can you review the roadmap draft?

**Inbox SuperPilot**
• [#bugs] 2 new bug reports
• [#feature-requests] 1 new request for Outlook support
```

## How to run manually

From NanoClaw main channel: `@Andy run discord digest`
