"""
gmail_webhook.py — Receives Gmail push notifications via Pub/Sub.

Flow:
1. Pub/Sub delivers POST to /webhook/gmail with {message: {data: base64(historyId+email)}}
2. We decode the notification, fetch new messages via Gmail API
3. Write to agent state file (same format as gmail_poll.py)
4. Optionally notify NanoClaw via IPC

Setup:
- Topic: projects/adp-413110/topics/gmail-notifications
- gmail-api-push@system.gserviceaccount.com must be Publisher on the topic
- Subscription: push to https://botti-voice-xxx.run.app/webhook/gmail
- Call watch() at boot for each monitored account
"""
import base64
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

# Accounts to monitor: agent_id -> {refresh_token, client_id, client_secret, email}
# Loaded from GMAIL_WEBHOOK_ACCOUNTS env var (JSON) or populated at startup
_accounts: dict[str, dict] = {}
_gmail_services: dict[str, object] = {}

# Track historyId per account to avoid reprocessing
_last_history_id: dict[str, str] = {}

# State dir for writing agent state (same format as boty-agent/modules/state.py)
STATE_DIR = os.environ.get("WEBHOOK_STATE_DIR", "/tmp/webhook-state")
PUBSUB_TOPIC = os.environ.get("GMAIL_PUBSUB_TOPIC", "projects/adp-413110/topics/gmail-notifications")


def register_account(agent_id: str, email: str, refresh_token: str,
                     client_id: str = None, client_secret: str = None):
    """Register a Gmail account for webhook monitoring.
    If client_id/secret not provided, falls back to GOOGLE_CLIENT_ID_OAUTH env vars."""
    _accounts[agent_id] = {
        "email": email,
        "refresh_token": refresh_token,
        "client_id": client_id or os.environ.get("GOOGLE_CLIENT_ID_OAUTH", os.environ.get("GOOGLE_CLIENT_ID", "")),
        "client_secret": client_secret or os.environ.get("GOOGLE_CLIENT_SECRET_OAUTH", os.environ.get("GOOGLE_CLIENT_SECRET", "")),
    }
    logger.info(f"Registered Gmail webhook account: {agent_id} ({email})")


def _get_service(agent_id: str):
    """Get or create Gmail API service for an account."""
    if agent_id in _gmail_services:
        return _gmail_services[agent_id]

    acct = _accounts.get(agent_id)
    if not acct:
        raise ValueError(f"Unknown account: {agent_id}")

    creds = Credentials(
        token=None,
        refresh_token=acct["refresh_token"],
        client_id=acct["client_id"],
        client_secret=acct["client_secret"],
        token_uri="https://oauth2.googleapis.com/token",
    )
    service = build("gmail", "v1", credentials=creds)
    _gmail_services[agent_id] = service
    return service


def setup_watch(agent_id: str) -> dict:
    """Call gmail.users.watch() to start push notifications for an account.
    Must be called at boot and renewed every 7 days."""
    service = _get_service(agent_id)
    result = service.users().watch(
        userId="me",
        body={
            "topicName": PUBSUB_TOPIC,
            "labelIds": ["INBOX"],
        },
    ).execute()
    _last_history_id[agent_id] = str(result.get("historyId", ""))
    logger.info(f"Gmail watch started for {agent_id}: expiry={result.get('expiration')}, historyId={result.get('historyId')}")
    return result


def setup_all_watches():
    """Setup watch for all registered accounts."""
    for agent_id in _accounts:
        try:
            setup_watch(agent_id)
        except Exception as e:
            logger.error(f"Failed to setup watch for {agent_id}: {e}")


def process_notification(pubsub_data: str) -> Optional[dict]:
    """Process a Pub/Sub notification from Gmail.

    Args:
        pubsub_data: base64-encoded JSON from Pub/Sub message.data

    Returns:
        dict with new messages, or None if no new messages.
    """
    try:
        decoded = json.loads(base64.b64decode(pubsub_data))
    except Exception as e:
        logger.error(f"Failed to decode Pub/Sub data: {e}")
        return None

    email = decoded.get("emailAddress", "")
    history_id = str(decoded.get("historyId", ""))

    # Find which agent this email belongs to
    agent_id = None
    for aid, acct in _accounts.items():
        if acct["email"] == email:
            agent_id = aid
            break

    if not agent_id:
        logger.warning(f"Gmail notification for unknown email: {email}")
        return None

    logger.info(f"Gmail notification: {agent_id} ({email}), historyId={history_id}")

    # Fetch new messages since last known historyId
    previous_history = _last_history_id.get(agent_id)
    if not previous_history:
        # First notification — just store the historyId
        _last_history_id[agent_id] = history_id
        logger.info(f"First notification for {agent_id}, storing historyId={history_id}")
        return None

    try:
        service = _get_service(agent_id)
        history_response = service.users().history().list(
            userId="me",
            startHistoryId=previous_history,
            historyTypes=["messageAdded"],
            labelId="INBOX",
        ).execute()
    except Exception as e:
        logger.error(f"Failed to fetch history for {agent_id}: {e}")
        # History ID may be too old — reset
        _last_history_id[agent_id] = history_id
        return None

    _last_history_id[agent_id] = history_id

    # Extract new message IDs
    message_ids = []
    for record in history_response.get("history", []):
        for msg_added in record.get("messagesAdded", []):
            msg = msg_added.get("message", {})
            msg_id = msg.get("id")
            # Skip messages not in INBOX (e.g. sent, spam)
            labels = msg.get("labelIds", [])
            if msg_id and "INBOX" in labels:
                message_ids.append(msg_id)

    if not message_ids:
        logger.info(f"No new inbox messages for {agent_id}")
        return None

    # Fetch message metadata
    emails = []
    for msg_id in message_ids[:10]:
        try:
            msg = service.users().messages().get(
                userId="me",
                id=msg_id,
                format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            ).execute()
            headers = {h["name"]: h["value"] for h in msg.get("payload", {}).get("headers", [])}
            emails.append({
                "id": msg_id,
                "from": headers.get("From", ""),
                "subject": headers.get("Subject", ""),
                "date": headers.get("Date", ""),
                "snippet": msg.get("snippet", ""),
                "detected_at": datetime.now(timezone.utc).isoformat(),
            })
        except Exception as e:
            logger.warning(f"Failed to fetch message {msg_id}: {e}")

    if not emails:
        return None

    # Write to state file (same format as boty-agent state.py)
    _write_state(agent_id, emails)

    logger.info(f"Gmail webhook: {len(emails)} new message(s) for {agent_id}")
    return {"agent_id": agent_id, "email": email, "new_count": len(emails), "messages": emails}


def _write_state(agent_id: str, emails: list):
    """Write new messages to agent state file."""
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, f"{agent_id}-gmail-webhook.json")

    # Read existing state
    state = {}
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)

    # Append new message IDs (dedup)
    existing_ids = set(state.get("processed_ids", []))
    new_ids = [e["id"] for e in emails if e["id"] not in existing_ids]

    state["processed_ids"] = list(existing_ids | set(new_ids))[-500:]
    state["last_updated"] = datetime.now(timezone.utc).isoformat()
    state["last_messages"] = emails
    state["last_webhook_at"] = datetime.now(timezone.utc).isoformat()

    with open(state_file, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
