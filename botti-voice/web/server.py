import asyncio
import json
import logging
import os
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware

from .auth import verify_session, oauth_router
from .config import SESSION_SECRET, ALLOWED_EMAILS, ACCESS_PIN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
from .gemini_bridge import GeminiBridge
from .gmail_webhook import process_notification as gmail_process, register_account as gmail_register, setup_all_watches
from .chat_webhook import process_notification as chat_process, register_account as chat_register
from .calendar_webhook import process_notification as cal_process, register_account as cal_register, setup_all_watches as cal_setup_watches
from .workspace import WorkspaceClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Botti Voice")
app.add_middleware(SessionMiddleware, secret_key=SESSION_SECRET)
app.include_router(oauth_router)

STATIC_DIR = Path(__file__).parent / "static"
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# Track active connection to enforce single-user
_active_ws = None


@app.get("/")
async def root(request: Request):
    user = verify_session(request)
    if not user:
        return RedirectResponse("/auth/login")
    return HTMLResponse((STATIC_DIR / "index.html").read_text())


# --- Gmail Webhook ---

@app.post("/webhook/gmail")
async def webhook_gmail(request: Request):
    """Receive Gmail push notifications from Pub/Sub."""
    try:
        body = await request.json()
        message = body.get("message", {})
        data = message.get("data", "")
        if not data:
            logger.warning("Gmail webhook: empty message data")
            return {"status": "ignored"}

        result = gmail_process(data)
        if result:
            logger.info(f"Gmail webhook processed: {result['agent_id']}, {result['new_count']} new")
            return {"status": "ok", "new_count": result["new_count"]}
        return {"status": "ok", "new_count": 0}
    except Exception as e:
        logger.error(f"Gmail webhook error: {e}")
        # Always return 200 to Pub/Sub to avoid redelivery loops
        return {"status": "error", "detail": str(e)}


@app.on_event("startup")
async def startup_gmail_watches():
    """Register accounts and start Gmail watches on boot."""
    # Load accounts from env: GMAIL_WEBHOOK_ACCOUNTS='{"boty":{"email":"sam@bestoftours.co.uk","refresh_token":"...","client_id":"...","client_secret":"..."}}'
    accounts_json = os.environ.get("GMAIL_WEBHOOK_ACCOUNTS", "")
    if accounts_json:
        try:
            accounts = json.loads(accounts_json)
            for agent_id, acct in accounts.items():
                gmail_register(
                    agent_id,
                    acct["email"],
                    acct["refresh_token"],
                    acct.get("client_id"),
                    acct.get("client_secret"),
                )
            setup_all_watches()
        except Exception as e:
            logger.error(f"Failed to setup Gmail watches: {e}")
    else:
        logger.info("GMAIL_WEBHOOK_ACCOUNTS not set, Gmail webhooks disabled")


# --- Chat Webhook ---

@app.post("/webhook/chat")
async def webhook_chat(request: Request):
    """Receive Google Chat push notifications from Pub/Sub (via Workspace Events API)."""
    try:
        body = await request.json()
        message = body.get("message", {})
        data = message.get("data", "")
        if not data:
            logger.warning("Chat webhook: empty message data")
            return {"status": "ignored"}

        # Shared topic: filter out Gmail notifications (they have emailAddress/historyId)
        import base64
        try:
            decoded_peek = json.loads(base64.b64decode(data))
            if "emailAddress" in decoded_peek and "historyId" in decoded_peek:
                return {"status": "ignored", "reason": "gmail_notification"}
        except Exception:
            pass

        logger.info(f"Chat webhook data: {json.dumps(decoded_peek)[:500]}")
        result = chat_process(data)
        if result:
            logger.info(f"Chat webhook processed: {result['agent_id']}, space={result['space_id']}")
            return {"status": "ok", "message": result["message"]["text"][:80]}
        return {"status": "ok", "new_count": 0}
    except Exception as e:
        logger.error(f"Chat webhook error: {e}")
        return {"status": "error", "detail": str(e)}


@app.on_event("startup")
async def startup_chat_accounts():
    """Register Chat accounts from env var."""
    # CHAT_WEBHOOK_ACCOUNTS='{"boty":{"space_id":"spaces/AAQAF8zXzRE","refresh_token":"..."}}'
    accounts_json = os.environ.get("CHAT_WEBHOOK_ACCOUNTS", "")
    if accounts_json:
        try:
            accounts = json.loads(accounts_json)
            for agent_id, acct in accounts.items():
                chat_register(
                    agent_id,
                    acct["space_id"],
                    acct["refresh_token"],
                    acct.get("client_id"),
                    acct.get("client_secret"),
                )
        except Exception as e:
            logger.error(f"Failed to register Chat accounts: {e}")
    else:
        logger.info("CHAT_WEBHOOK_ACCOUNTS not set, Chat webhooks disabled")


# --- Calendar Webhook ---

@app.post("/webhook/calendar")
async def webhook_calendar(request: Request):
    """Receive Google Calendar push notifications (direct HTTP from Calendar API)."""
    try:
        channel_token = request.headers.get("X-Goog-Channel-Token", "")
        resource_state = request.headers.get("X-Goog-Resource-State", "")
        logger.info(f"Calendar webhook: state={resource_state}, token={channel_token}")

        result = cal_process(channel_token, resource_state)
        if result:
            logger.info(f"Calendar webhook processed: {result['agent_id']}, {result['event_count']} change(s)")
            return {"status": "ok", "event_count": result["event_count"]}
        return {"status": "ok", "event_count": 0}
    except Exception as e:
        logger.error(f"Calendar webhook error: {e}")
        return {"status": "error", "detail": str(e)}


@app.on_event("startup")
async def startup_calendar_watches():
    """Register calendar accounts and start watches on boot."""
    # CALENDAR_WEBHOOK_ACCOUNTS='{"boty":{"calendar_id":"sam@bestoftours.co.uk","refresh_token":"..."}}'
    callback_url = os.environ.get("CALENDAR_WEBHOOK_URL", "")
    accounts_json = os.environ.get("CALENDAR_WEBHOOK_ACCOUNTS", "")
    if accounts_json and callback_url:
        try:
            accounts = json.loads(accounts_json)
            for agent_id, acct in accounts.items():
                cal_register(
                    agent_id,
                    acct["calendar_id"],
                    acct["refresh_token"],
                    acct.get("client_id"),
                    acct.get("client_secret"),
                )
            cal_setup_watches(callback_url)
        except Exception as e:
            logger.error(f"Failed to setup Calendar watches: {e}")
    else:
        if not callback_url:
            logger.info("CALENDAR_WEBHOOK_URL not set, Calendar webhooks disabled")
        if not accounts_json:
            logger.info("CALENDAR_WEBHOOK_ACCOUNTS not set, Calendar webhooks disabled")


@app.websocket("/ws/audio")
async def audio_websocket(websocket: WebSocket):
    global _active_ws

    # Verify auth from session cookie
    email = websocket.session.get("user_email")
    if not email:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    # In production, check email whitelist
    if GOOGLE_CLIENT_ID and email not in ALLOWED_EMAILS:
        await websocket.close(code=4001, reason="Unauthorized")
        return

    if GOOGLE_CLIENT_ID and ACCESS_PIN and not websocket.session.get("pin_verified"):
        await websocket.close(code=4001, reason="PIN required")
        return

    # Enforce single connection
    if _active_ws is not None:
        await websocket.close(code=4002, reason="Another session is active")
        return

    await websocket.accept()
    _active_ws = websocket
    logger.info(f"WebSocket connected: {email}")

    # Init Workspace client if refresh token is configured
    workspace = None
    if GOOGLE_REFRESH_TOKEN and GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET:
        workspace = WorkspaceClient(GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
        logger.info("Workspace tools enabled (Gmail, Calendar, Drive)")
    elif GOOGLE_REFRESH_TOKEN:
        # Dev mode: use refresh token with client ID/secret from gcp-oauth.keys.json
        # loaded via GOOGLE_CLIENT_ID_OAUTH / GOOGLE_CLIENT_SECRET_OAUTH env vars
        client_id = os.environ.get("GOOGLE_CLIENT_ID_OAUTH", GOOGLE_CLIENT_ID)
        client_secret = os.environ.get("GOOGLE_CLIENT_SECRET_OAUTH", GOOGLE_CLIENT_SECRET)
        if client_id and client_secret:
            workspace = WorkspaceClient(GOOGLE_REFRESH_TOKEN, client_id, client_secret)
            logger.info("Workspace tools enabled (dev mode)")

    bridge = GeminiBridge(workspace=workspace)
    receive_task = None
    keepalive_task = None

    try:
        await bridge.connect()

        async def send_to_browser(msg_type: str, data):
            try:
                if msg_type == "audio":
                    await websocket.send_bytes(data)
                elif msg_type == "text":
                    await websocket.send_text(json.dumps({
                        "type": "text", "content": data
                    }))
                elif msg_type == "turn_complete":
                    await websocket.send_text(json.dumps({
                        "type": "turn_complete"
                    }))
            except Exception:
                pass

        async def keepalive():
            while True:
                await asyncio.sleep(30)
                try:
                    await websocket.send_text(json.dumps({"type": "ping"}))
                except Exception:
                    break

        receive_task = asyncio.create_task(bridge.receive_responses(send_to_browser))
        keepalive_task = asyncio.create_task(keepalive())

        while True:
            message = await websocket.receive()
            if "bytes" in message:
                await bridge.send_audio(message["bytes"])
            elif "text" in message:
                try:
                    cmd = json.loads(message["text"])
                    if cmd.get("type") == "text":
                        await bridge.send_text(cmd["content"])
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        _active_ws = None
        if receive_task:
            receive_task.cancel()
        if keepalive_task:
            keepalive_task.cancel()
        await bridge.disconnect()
        logger.info("Session cleaned up")
