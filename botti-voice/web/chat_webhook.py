"""
chat_webhook.py — Receives Google Chat push notifications via Pub/Sub.

Flow:
1. Workspace Events API subscription pushes to Pub/Sub topic
2. Pub/Sub delivers POST to /webhook/chat
3. We decode the event, fetch the message via Chat API
4. Write to agent state file

Setup:
- Activate Workspace Events API in GCP
- Create Pub/Sub topic (e.g. chat-notifications)
- Create Workspace Events subscription targeting the space
- Pub/Sub push subscription to https://botti-voice-xxx.run.app/webhook/chat
"""
import base64
import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

_accounts: dict[str, dict] = {}
_chat_services: dict[str, object] = {}

STATE_DIR = os.environ.get("WEBHOOK_STATE_DIR", "/tmp/webhook-state")

# Track processed message IDs to avoid duplicates
_processed_ids: dict[str, set] = {}


def register_account(agent_id: str, space_id: str, refresh_token: str,
                     client_id: str = None, client_secret: str = None):
    """Register a Chat space for webhook monitoring."""
    _accounts[agent_id] = {
        "space_id": space_id,
        "refresh_token": refresh_token,
        "client_id": client_id or os.environ.get("GOOGLE_CLIENT_ID_OAUTH", os.environ.get("GOOGLE_CLIENT_ID", "")),
        "client_secret": client_secret or os.environ.get("GOOGLE_CLIENT_SECRET_OAUTH", os.environ.get("GOOGLE_CLIENT_SECRET", "")),
    }
    logger.info(f"Registered Chat webhook account: {agent_id} (space={space_id})")


def _get_service(agent_id: str):
    """Get or create Chat API service for an account."""
    if agent_id in _chat_services:
        return _chat_services[agent_id]

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
    service = build("chat", "v1", credentials=creds)
    _chat_services[agent_id] = service
    return service


def process_notification(pubsub_data: str) -> Optional[dict]:
    """Process a Pub/Sub notification from Workspace Events API for Chat.

    The event payload contains:
    - type: e.g. "google.workspace.chat.message.v1.created"
    - source: the subscription name
    - data: {"message": {"name": "spaces/XXX/messages/YYY"}}
    """
    try:
        decoded = json.loads(base64.b64decode(pubsub_data))
    except Exception as e:
        logger.error(f"Failed to decode Chat Pub/Sub data: {e}")
        return None

    event_type = decoded.get("type", "")
    logger.info(f"Chat event: type={event_type}, keys={list(decoded.keys())}, raw={json.dumps(decoded)[:500]}")

    # We only care about new messages
    if "message" not in event_type.lower() or "created" not in event_type.lower():
        logger.debug(f"Ignoring chat event type: {event_type}")
        return None

    # Extract message resource name
    message_data = decoded.get("data", {})
    # Workspace Events wraps data differently — try common patterns
    message_name = (
        message_data.get("message", {}).get("name") or
        message_data.get("name") or
        decoded.get("resourceName", "")
    )

    if not message_name:
        logger.warning(f"Chat event missing message name: {json.dumps(decoded)[:200]}")
        return None

    # Extract space from message name: spaces/XXX/messages/YYY
    parts = message_name.split("/")
    if len(parts) < 4:
        logger.warning(f"Unexpected message name format: {message_name}")
        return None

    space_id = f"{parts[0]}/{parts[1]}"
    msg_id = parts[3]

    # Find which agent owns this space
    agent_id = None
    for aid, acct in _accounts.items():
        if acct["space_id"] == space_id:
            agent_id = aid
            break

    if not agent_id:
        logger.warning(f"Chat notification for unknown space: {space_id}")
        return None

    # Dedup
    if agent_id not in _processed_ids:
        _processed_ids[agent_id] = set()
    if msg_id in _processed_ids[agent_id]:
        logger.debug(f"Duplicate message {msg_id} for {agent_id}, skipping")
        return None

    # Fetch full message via Chat API
    try:
        service = _get_service(agent_id)
        msg = service.spaces().messages().get(name=message_name).execute()
    except Exception as e:
        logger.error(f"Failed to fetch chat message {message_name}: {e}")
        return None

    # Skip bot messages
    sender_type = msg.get("sender", {}).get("type", "")
    if sender_type == "BOT":
        logger.debug(f"Skipping bot message {msg_id}")
        return None

    text = msg.get("text", msg.get("argumentText", ""))
    create_time = msg.get("createTime", "")

    message_record = {
        "id": msg_id,
        "name": message_name,
        "space_id": space_id,
        "text": text,
        "sender_type": sender_type or "HUMAN",
        "create_time": create_time,
        "detected_at": datetime.now(timezone.utc).isoformat(),
    }

    # Track and persist
    _processed_ids[agent_id].add(msg_id)
    # Keep set bounded
    if len(_processed_ids[agent_id]) > 500:
        _processed_ids[agent_id] = set(list(_processed_ids[agent_id])[-250:])

    _write_state(agent_id, [message_record])

    logger.info(f"Chat webhook: new message for {agent_id} in {space_id}: {text[:80]}")
    return {"agent_id": agent_id, "space_id": space_id, "message": message_record}


def _write_state(agent_id: str, messages: list):
    """Write new messages to agent state file."""
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, f"{agent_id}-chat-webhook.json")

    state = {}
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)

    existing_ids = set(state.get("processed_ids", []))
    new_ids = [m["id"] for m in messages if m["id"] not in existing_ids]

    state["processed_ids"] = list(existing_ids | set(new_ids))[-500:]
    state["last_updated"] = datetime.now(timezone.utc).isoformat()
    state["last_messages"] = messages
    state["last_webhook_at"] = datetime.now(timezone.utc).isoformat()

    with open(state_file, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
