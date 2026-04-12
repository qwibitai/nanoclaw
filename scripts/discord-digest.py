#!/usr/bin/env python3
"""Discord Daily Digest — fetches 24h of messages, summarizes, DMs to user.

Run standalone:  python3 scripts/discord-digest.py
Run via NanoClaw: scheduled task calls this script

Flags:
  --output-only  Print the digest to stdout only; do NOT send a Discord DM.
                 Used by the morning-briefing skill so it can preview the
                 digest and embed it inline without producing a duplicate
                 DM post every time the briefing runs.

Requires: DISCORD_BOT_TOKEN env var
"""

import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
DM_CHANNEL_ID = "1483524392649752638"  # DM channel with Jonathan
SKIP_CATEGORIES = {"closed 1", "closed 2", "charlie chen - closed 01", "charlie chen - closed 02", "discord resources", "resources (staging)"}
MAX_MESSAGES_PER_CHANNEL = 50

def api(endpoint, method="GET", body=None):
    url = f"https://discord.com/api/v10{endpoint}"
    cmd = ["curl", "-s", "-X", method, "-H", f"Authorization: Bot {BOT_TOKEN}", "-H", "Content-Type: application/json"]
    if body:
        cmd += ["-d", json.dumps(body)]
    cmd.append(url)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return json.loads(result.stdout) if result.stdout else None
    except Exception as e:
        print(f"API error {endpoint}: {e}", file=sys.stderr)
        return None

def snowflake_from_time(dt):
    """Convert datetime to Discord snowflake for message filtering."""
    epoch = datetime(2015, 1, 1, tzinfo=timezone.utc)
    ms = int((dt - epoch).total_seconds() * 1000)
    return str(ms << 22)

def fetch_guilds():
    return api("/users/@me/guilds") or []

def fetch_channels(guild_id):
    return api(f"/guilds/{guild_id}/channels") or []

def fetch_messages(channel_id, after_snowflake):
    return api(f"/channels/{channel_id}/messages?after={after_snowflake}&limit={MAX_MESSAGES_PER_CHANNEL}") or []

def build_digest():
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    after_snowflake = snowflake_from_time(cutoff)
    today = datetime.now().strftime("%b %d, %Y")

    guilds = fetch_guilds()
    digest_parts = [f"**📋 Daily Discord Digest — {today}**\n"]

    for guild in guilds:
        guild_id = guild["id"]
        guild_name = guild["name"]
        channels = fetch_channels(guild_id)

        # Build category map
        categories = {}
        for ch in channels:
            if ch["type"] == 4:  # category
                categories[ch["id"]] = ch["name"].lower()

        # Collect messages per channel
        channel_summaries = []
        action_items = []
        mentions = []
        announcements = []

        text_channels = [ch for ch in channels if ch["type"] == 0]  # text only

        # With 300+ channels, we can't scan all. Focus on important categories.
        priority_cats = {"news", "subjects", "cross-team requests", "departments", "teams", "social",
                         "welcome", "feedback", "product", "community", "team-only"}
        priority_channels = []
        other_channels = []
        for ch in text_channels:
            parent = ch.get("parent_id")
            cat_name = categories.get(parent, "").lower() if parent else ""
            if cat_name in SKIP_CATEGORIES:
                continue
            if cat_name in priority_cats or not parent:
                priority_channels.append(ch)
            else:
                other_channels.append(ch)

        # Scan priority channels first, then a sample of others
        scan_channels = priority_channels + other_channels[:20]

        for ch in scan_channels:
            parent = ch.get("parent_id")
            cat_name = categories.get(parent, "").lower() if parent else ""

            # Skip closed/archived categories
            if cat_name in SKIP_CATEGORIES:
                continue

            messages = fetch_messages(ch["id"], after_snowflake)
            if not messages or not isinstance(messages, list):
                continue

            # Filter bot messages and non-dict entries
            human_msgs = [m for m in messages if isinstance(m, dict) and not m.get("author", {}).get("bot", False)]
            if not human_msgs:
                continue

            ch_name = ch["name"]
            msg_count = len(human_msgs)

            # Check for @mentions of Jonathan
            for m in human_msgs:
                for mention in m.get("mentions", []):
                    if mention.get("id") == "976169295212077066":
                        content_preview = m["content"][:150]
                        mentions.append(f"• [#{ch_name}] {m['author']['username']}: {content_preview}")

            # Check for action items (request channels)
            if "request" in ch_name.lower():
                for m in human_msgs:
                    content_preview = m["content"][:150]
                    action_items.append(f"• [#{ch_name}] {m['author']['username']}: {content_preview}")

            # Check for announcements (news channels)
            if "news" in ch_name.lower():
                for m in human_msgs[:3]:  # Top 3
                    content_preview = m["content"][:150]
                    announcements.append(f"• [#{ch_name}] {content_preview}")

            # General summary
            if msg_count >= 3:  # Only mention active channels
                # Get topic summary from first few messages
                preview = human_msgs[0]["content"][:100] if human_msgs else ""
                channel_summaries.append(f"• [#{ch_name}] {msg_count} messages — {preview}")

        # Build guild section
        guild_section = f"\n**{guild_name}**\n"
        has_content = False

        if action_items:
            guild_section += "\n🔴 **Action items / requests:**\n" + "\n".join(action_items[:10]) + "\n"
            has_content = True

        if announcements:
            guild_section += "\n📢 **Announcements:**\n" + "\n".join(announcements[:10]) + "\n"
            has_content = True

        if mentions:
            guild_section += "\n👤 **You were mentioned:**\n" + "\n".join(mentions[:10]) + "\n"
            has_content = True

        if channel_summaries:
            guild_section += "\n💬 **Active discussions:**\n" + "\n".join(channel_summaries[:15]) + "\n"
            has_content = True

        if has_content:
            digest_parts.append(guild_section)
        else:
            digest_parts.append(f"\n**{guild_name}**\n_No significant activity in the past 24h._\n")

    return "\n".join(digest_parts)

def send_dm(content):
    """Send digest as DM. Split if > 2000 chars (Discord limit)."""
    chunks = []
    while len(content) > 2000:
        # Split at last newline before 2000
        split_at = content[:2000].rfind("\n")
        if split_at == -1:
            split_at = 2000
        chunks.append(content[:split_at])
        content = content[split_at:]
    chunks.append(content)

    for chunk in chunks:
        api(f"/channels/{DM_CHANNEL_ID}/messages", method="POST", body={"content": chunk})

def main():
    output_only = "--output-only" in sys.argv[1:]

    if not BOT_TOKEN:
        # Write a clearly-prefixed error to BOTH stdout and stderr so the
        # briefing skill can surface it as real evidence instead of an
        # invented guess. The DIGEST-ERROR prefix lets downstream tooling
        # distinguish real failures from ordinary output.
        msg = "DIGEST-ERROR: DISCORD_BOT_TOKEN environment variable is not set in the container"
        print(msg, file=sys.stderr)
        print(msg)
        sys.exit(2)

    try:
        if not output_only:
            print("Generating Discord digest...", file=sys.stderr)
        digest = build_digest()
        # Always emit the digest on stdout so callers (briefing skill) can
        # capture and embed it.
        print(digest)
        if not output_only:
            print("\nSending DM...", file=sys.stderr)
            send_dm(digest)
            print("Done!", file=sys.stderr)
    except Exception as e:
        msg = f"DIGEST-ERROR: {type(e).__name__}: {e}"
        print(msg, file=sys.stderr)
        print(msg)
        sys.exit(3)

if __name__ == "__main__":
    main()
