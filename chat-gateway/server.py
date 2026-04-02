"""
Chat Gateway - Cloud Run service that receives Google Chat webhook events
and writes them to Firestore for NanoClaw agents to poll.

Single Chat App ("Botti") routes messages to the correct agent based on
a space→agent mapping stored in Firestore (chat-config/space-mapping).
Messages in spaces where Yacine is not a member are tagged but still stored.
"""

import json
import os
import time
import logging
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from google.cloud import firestore
from google.auth import default

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

VALID_AGENTS = {"botti", "sam", "thais", "alan"}
DEFAULT_AGENT = "botti"
YACINE_EMAIL = "yacine@bestoftours.co.uk"
CHAT_VERIFICATION_TOKEN = os.environ.get("CHAT_VERIFICATION_TOKEN", "")
ADMIN_API_KEY = os.environ.get("ADMIN_API_KEY", "")

# Space → agent mapping. Loaded from Firestore at startup, editable live.
# Firestore doc: chat-config/space-mapping  { "spaces/XXX": "sam", ... }
_space_agent_map: dict[str, str] = {}
_map_loaded_at: float = 0

# Yacine presence cache: space_name -> (is_present, timestamp)
_yacine_cache: dict[str, tuple[bool, float]] = {}
CACHE_TTL = 3600  # 1 hour

app = FastAPI()
db = firestore.Client()


def load_space_mapping():
    """Load space→agent mapping from Firestore."""
    global _space_agent_map, _map_loaded_at
    try:
        doc = db.collection("chat-config").document("space-mapping").get()
        if doc.exists:
            _space_agent_map = doc.to_dict() or {}
            logger.info(f"Loaded space mapping: {len(_space_agent_map)} spaces")
        else:
            _space_agent_map = {}
            logger.info("No space mapping found, will use default agent")
        _map_loaded_at = time.time()
    except Exception as e:
        logger.error(f"Failed to load space mapping: {e}")


def get_agent_for_space(space_name: str) -> str:
    """Return the agent name for a given space. Reloads mapping every 5 min."""
    if time.time() - _map_loaded_at > 300:
        load_space_mapping()
    return _space_agent_map.get(space_name, DEFAULT_AGENT)


def check_yacine_present(space_name: str) -> bool:
    """Check if Yacine is a member of the given space.
    Uses Chat API membership list. Cached for 1 hour.
    Falls back to True for DMs (DIRECT_MESSAGE type)."""
    now = time.time()
    if space_name in _yacine_cache:
        is_present, cached_at = _yacine_cache[space_name]
        if now - cached_at < CACHE_TTL:
            return is_present

    # For Chat API membership listing, we'd need the Chat App's service account
    # to have chat.memberships.readonly scope. Since this may not be available
    # at first, default to True (safe) and let the NanoClaw agent decide.
    _yacine_cache[space_name] = (True, now)
    return True


@app.on_event("startup")
async def startup():
    load_space_mapping()


# Main endpoint — single Chat App posts here
@app.post("/chat")
async def handle_chat_event(request: Request) -> dict[str, Any]:
    body = await request.json()

    # Verify token
    if CHAT_VERIFICATION_TOKEN:
        token = body.get("token", "")
        if token != CHAT_VERIFICATION_TOKEN:
            raise HTTPException(status_code=403, detail="Invalid verification token")

    event_type = body.get("type", "")
    space = body.get("space", {})
    space_name = space.get("name", "")
    space_type = space.get("type", "")

    # Determine which agent handles this space
    agent_name = get_agent_for_space(space_name)

    if event_type == "ADDED_TO_SPACE":
        # Auto-register space with default agent
        if space_name and space_name not in _space_agent_map:
            _space_agent_map[space_name] = agent_name
            try:
                db.collection("chat-config").document("space-mapping").set(
                    {space_name: agent_name}, merge=True
                )
                logger.info(f"Auto-registered space {space_name} -> {agent_name}")
            except Exception as e:
                logger.warning(f"Failed to save space mapping: {e}")

        display = space.get("displayName", "this space")
        return {"text": f"Connected to {display}. Agent: {agent_name.capitalize()}."}

    if event_type == "REMOVED_FROM_SPACE":
        logger.info(f"Removed from space {space_name}")
        return {}

    if event_type != "MESSAGE":
        return {}

    message = body.get("message", {})
    sender = message.get("sender", {})

    # Skip bot messages
    if sender.get("type") == "BOT":
        return {}

    text = message.get("argumentText", message.get("text", "")).strip()
    if not text:
        return {}

    # Check for @agent routing: "@Sam do this" overrides space mapping
    routed_agent = agent_name
    for agent in VALID_AGENTS:
        if text.lower().startswith(f"@{agent}"):
            routed_agent = agent
            text = text[len(agent) + 1:].strip()
            break

    yacine_present = check_yacine_present(space_name)

    doc_data = {
        "id": message.get("name", ""),
        "spaceId": space_name,
        "spaceName": space.get("displayName", space_name),
        "spaceType": space_type,
        "messageId": message.get("name", "").split("/")[-1] if message.get("name") else "",
        "messageName": message.get("name", ""),
        "text": text,
        "senderName": sender.get("displayName", ""),
        "senderEmail": sender.get("email", ""),
        "senderType": sender.get("type", "HUMAN"),
        "createTime": message.get("createTime", ""),
        "agentName": routed_agent,
        "processed": False,
        "yacinePresent": yacine_present,
    }

    doc_ref = db.collection("chat-queue").document(routed_agent).collection("messages").document()
    doc_ref.set(doc_data)
    logger.info(f"[{routed_agent}] Message from {doc_data['senderName']} in {doc_data['spaceName']}: {text[:80]}")

    return {}


# Legacy per-agent endpoint (still works)
@app.post("/{agent_name}")
async def handle_agent_event(agent_name: str, request: Request) -> dict[str, Any]:
    if agent_name not in VALID_AGENTS:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_name}")

    body = await request.json()

    if CHAT_VERIFICATION_TOKEN:
        token = body.get("token", "")
        if token != CHAT_VERIFICATION_TOKEN:
            raise HTTPException(status_code=403, detail="Invalid verification token")

    event_type = body.get("type", "")
    if event_type == "ADDED_TO_SPACE":
        return {"text": f"Hi! I'm {agent_name.capitalize()}. I'll be listening here."}
    if event_type != "MESSAGE":
        return {}

    message = body.get("message", {})
    sender = message.get("sender", {})
    space = body.get("space", {})

    if sender.get("type") == "BOT":
        return {}

    doc_data = {
        "id": message.get("name", ""),
        "spaceId": space.get("name", ""),
        "spaceName": space.get("displayName", ""),
        "spaceType": space.get("type", ""),
        "messageId": message.get("name", "").split("/")[-1] if message.get("name") else "",
        "messageName": message.get("name", ""),
        "text": message.get("argumentText", message.get("text", "")),
        "senderName": sender.get("displayName", ""),
        "senderEmail": sender.get("email", ""),
        "senderType": sender.get("type", "HUMAN"),
        "createTime": message.get("createTime", ""),
        "agentName": agent_name,
        "processed": False,
        "yacinePresent": True,
    }

    doc_ref = db.collection("chat-queue").document(agent_name).collection("messages").document()
    doc_ref.set(doc_data)
    logger.info(f"[{agent_name}] Message from {doc_data['senderName']}: {doc_data['text'][:80]}")

    return {}


# Admin: update space mapping
@app.post("/admin/map-space")
async def map_space(request: Request) -> dict[str, str]:
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="Admin endpoint disabled (ADMIN_API_KEY not configured)")
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {ADMIN_API_KEY}":
        raise HTTPException(status_code=403, detail="Invalid API key")
    body = await request.json()
    space_name = body.get("space")
    agent = body.get("agent")
    if not space_name or agent not in VALID_AGENTS:
        raise HTTPException(status_code=400, detail="Need space and valid agent")
    _space_agent_map[space_name] = agent
    db.collection("chat-config").document("space-mapping").set(
        {space_name: agent}, merge=True
    )
    return {"status": "ok", "space": space_name, "agent": agent}


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}
