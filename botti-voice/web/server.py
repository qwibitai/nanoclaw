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
