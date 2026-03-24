"""
calendar_webhook.py — Receives Google Calendar push notifications.

Flow:
1. calendar.events.watch() sends POST to /webhook/calendar
2. Headers: X-Goog-Channel-ID, X-Goog-Resource-State, X-Goog-Resource-ID
3. On "exists" or "update", fetch changes via events.list(syncToken=...)
4. Write to agent state file

Note: Calendar watch() pushes directly to HTTP (no Pub/Sub).
The callback domain must be verified in Google Search Console,
OR use a Cloud Run URL (implicitly trusted by Google).
"""
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

logger = logging.getLogger(__name__)

_accounts: dict[str, dict] = {}
_calendar_services: dict[str, object] = {}
_sync_tokens: dict[str, str] = {}
_channel_ids: dict[str, str] = {}

STATE_DIR = os.environ.get("WEBHOOK_STATE_DIR", "/tmp/webhook-state")
CALLBACK_URL = os.environ.get("CALENDAR_WEBHOOK_URL", "")


def register_account(agent_id: str, calendar_id: str, refresh_token: str,
                     client_id: str = None, client_secret: str = None):
    """Register a calendar for webhook monitoring."""
    _accounts[agent_id] = {
        "calendar_id": calendar_id,
        "refresh_token": refresh_token,
        "client_id": client_id or os.environ.get("GOOGLE_CLIENT_ID_OAUTH", os.environ.get("GOOGLE_CLIENT_ID", "")),
        "client_secret": client_secret or os.environ.get("GOOGLE_CLIENT_SECRET_OAUTH", os.environ.get("GOOGLE_CLIENT_SECRET", "")),
    }
    logger.info(f"Registered Calendar webhook account: {agent_id} (calendar={calendar_id})")


def _get_service(agent_id: str):
    """Get or create Calendar API service for an account."""
    if agent_id in _calendar_services:
        return _calendar_services[agent_id]

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
    service = build("calendar", "v3", credentials=creds)
    _calendar_services[agent_id] = service
    return service


def setup_watch(agent_id: str, callback_url: str) -> dict:
    """Call calendar.events.watch() to start push notifications.
    Must be renewed before expiry (default ~1 week)."""
    service = _get_service(agent_id)
    acct = _accounts[agent_id]
    channel_id = str(uuid.uuid4())

    # First, do an initial sync to get a syncToken
    if agent_id not in _sync_tokens:
        events_result = service.events().list(
            calendarId=acct["calendar_id"],
            maxResults=1,
            singleEvents=True,
        ).execute()
        _sync_tokens[agent_id] = events_result.get("nextSyncToken", "")
        logger.info(f"Calendar initial sync for {agent_id}, got syncToken")

    result = service.events().watch(
        calendarId=acct["calendar_id"],
        body={
            "id": channel_id,
            "type": "web_hook",
            "address": callback_url,
            "token": agent_id,  # passed back in X-Goog-Channel-Token
        },
    ).execute()

    _channel_ids[agent_id] = channel_id
    logger.info(f"Calendar watch started for {agent_id}: channel={channel_id}, expiry={result.get('expiration')}")
    return result


def setup_all_watches(callback_url: str):
    """Setup watch for all registered accounts."""
    for agent_id in _accounts:
        try:
            setup_watch(agent_id, callback_url)
        except Exception as e:
            logger.error(f"Failed to setup calendar watch for {agent_id}: {e}")


def process_notification(channel_token: str, resource_state: str) -> Optional[dict]:
    """Process a Calendar push notification.

    Args:
        channel_token: X-Goog-Channel-Token header (= agent_id)
        resource_state: X-Goog-Resource-State header (sync/exists/update)
    """
    agent_id = channel_token

    if resource_state == "sync":
        logger.info(f"Calendar sync confirmation for {agent_id}")
        return None

    if agent_id not in _accounts:
        logger.warning(f"Calendar notification for unknown agent: {agent_id}")
        return None

    if resource_state not in ("exists", "update"):
        logger.debug(f"Ignoring calendar resource_state: {resource_state}")
        return None

    # Fetch changes using syncToken
    try:
        service = _get_service(agent_id)
        acct = _accounts[agent_id]
        sync_token = _sync_tokens.get(agent_id)

        kwargs = {"calendarId": acct["calendar_id"], "singleEvents": True}
        if sync_token:
            kwargs["syncToken"] = sync_token
        else:
            kwargs["maxResults"] = 10

        events_result = service.events().list(**kwargs).execute()
        _sync_tokens[agent_id] = events_result.get("nextSyncToken", sync_token)

        events = events_result.get("items", [])
        if not events:
            logger.info(f"Calendar notification for {agent_id}: no new events")
            return None

        records = []
        for event in events:
            records.append({
                "id": event.get("id", ""),
                "summary": event.get("summary", "(no title)"),
                "start": event.get("start", {}).get("dateTime", event.get("start", {}).get("date", "")),
                "end": event.get("end", {}).get("dateTime", event.get("end", {}).get("date", "")),
                "status": event.get("status", ""),
                "updated": event.get("updated", ""),
                "detected_at": datetime.now(timezone.utc).isoformat(),
            })

        _write_state(agent_id, records)
        logger.info(f"Calendar webhook: {len(records)} event change(s) for {agent_id}")
        return {"agent_id": agent_id, "event_count": len(records), "events": records}

    except Exception as e:
        error_str = str(e)
        if "Sync token" in error_str and "invalid" in error_str.lower():
            # syncToken expired — do a full sync
            logger.warning(f"Calendar syncToken expired for {agent_id}, resetting")
            _sync_tokens.pop(agent_id, None)
            return process_notification(channel_token, resource_state)
        logger.error(f"Failed to fetch calendar changes for {agent_id}: {e}")
        return None


def _write_state(agent_id: str, events: list):
    """Write calendar changes to agent state file."""
    os.makedirs(STATE_DIR, exist_ok=True)
    state_file = os.path.join(STATE_DIR, f"{agent_id}-calendar-webhook.json")

    state = {}
    if os.path.exists(state_file):
        with open(state_file) as f:
            state = json.load(f)

    state["last_updated"] = datetime.now(timezone.utc).isoformat()
    state["last_events"] = events
    state["last_webhook_at"] = datetime.now(timezone.utc).isoformat()

    with open(state_file, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
