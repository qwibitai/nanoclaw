---
name: setup-rss
description: Configure RSS feed polling for NanoClaw channels. Adds rss.channels section to nanoclaw.yaml with per-channel feed URLs, and restarts the service. Triggers on "setup rss", "add rss", "rss feed", or "rss 配信".
---

# RSS Feed Setup

Add RSS feed polling to NanoClaw so new articles are automatically delivered to configured channels every 15 minutes.

## 1. Check Current Configuration

Read `nanoclaw.yaml` to see if an `rss` section already exists:

```bash
cat nanoclaw.yaml
```

If the file doesn't exist, create it with just the `rss` section. If it already has a `providers` section, add the `rss` section alongside it.

## 2. Ask User for Configuration

Use `AskUserQuestion` to ask:

1. **Which channel JID(s)** should receive RSS updates? (e.g., `dc:1234567890` for Discord, `1234567890@g.us` for WhatsApp group)
2. **Which feed URLs?** — one or more RSS/Atom feed URLs to monitor.

## 3. Add RSS Section to nanoclaw.yaml

Add or update the `rss` section in `nanoclaw.yaml`. The structure is:

```yaml
rss:
  channels:
    - jid: "dc:1234567890"
      feeds:
        - url: "https://example.com/feed.xml"
          name: "Example Blog"
        - url: "https://another.example/rss"
    - jid: "1234567890@g.us"
      feeds:
        - url: "https://hackernews.com/rss"
          name: "Hacker News"
```

- `jid`: The channel JID (must match a registered group in NanoClaw)
- `feeds[].url`: RSS/Atom feed URL (required)
- `feeds[].name`: Display name for the feed (optional, used in messages)

Use the Edit tool to insert the `rss` section. If `nanoclaw.yaml` already has content, add `rss` at the same level as `providers`.

## 4. Verify Channel Registration

Ensure the JIDs specified in the RSS config correspond to registered groups:

```bash
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups"
```

If a JID is not registered, RSS items for that channel will be skipped with a warning log. Register the channel first using the NanoClaw interface.

## 5. Restart NanoClaw

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw

# Or manual restart
npm run dev
```

The RSS poller starts automatically on boot and checks for new articles every 15 minutes.

## 6. Verify It Works

Check the logs for RSS poller startup:

```bash
tail -f logs/nanoclaw.log | grep -i rss
```

You should see: `RSS poller started (15-minute interval)` and `RSS config loaded from nanoclaw.yaml`.

## Notes

- RSS items are tracked in the `rss_seen_items` SQLite table — restarts do not cause duplicate deliveries.
- The `guid` element is used as the unique item identifier, falling back to the article URL.
- Feed fetch failures are logged as warnings and do not crash the poller.
- To add or remove feeds, edit `nanoclaw.yaml` and restart. Config is re-read on each poll cycle.