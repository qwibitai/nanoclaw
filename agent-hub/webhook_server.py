"""
webhook_server.py — FastAPI webhook receiver for Gmail, Calendar, Chat.
Routes events to the appropriate agent thread.
Outbound email endpoint for all agents.
"""
import base64
import json
import logging
import os
import subprocess

from fastapi import FastAPI, Request
from pydantic import BaseModel

logger = logging.getLogger(__name__)

app = FastAPI(title="Agent Hub Webhooks")

# API key auth for external access
API_KEY = os.environ.get("AGENT_HUB_API_KEY", "")

# Set by orchestrator at startup
_event_callback = None
_agent_configs: dict = {}  # name -> config, set by orchestrator


def _check_api_key(request: Request) -> bool:
    """Verify API key from Authorization header."""
    if not API_KEY:
        return True  # No key configured = local dev mode
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:] == API_KEY
    return auth == API_KEY


def set_event_callback(callback):
    global _event_callback
    _event_callback = callback


def set_agent_configs(configs: dict):
    global _agent_configs
    _agent_configs = configs


@app.post("/webhook/{agent_name}/gmail")
async def webhook_gmail(agent_name: str, request: Request):
    try:
        body = await request.json()
        data_b64 = body.get("message", {}).get("data", "")
        if not data_b64:
            return {"status": "ignored"}

        decoded = json.loads(base64.b64decode(data_b64))
        email_addr = decoded.get("emailAddress", "")
        history_id = decoded.get("historyId", "")

        if _event_callback:
            _event_callback({
                "type": "gmail_webhook",
                "agent": agent_name,
                "email": email_addr,
                "history_id": history_id,
            })

        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Gmail webhook error: {e}")
        return {"status": "error"}


@app.post("/webhook/{agent_name}/calendar")
async def webhook_calendar(agent_name: str, request: Request):
    try:
        channel_token = request.headers.get("X-Goog-Channel-Token", agent_name)
        resource_state = request.headers.get("X-Goog-Resource-State", "")

        if resource_state == "sync":
            return {"status": "sync"}

        if _event_callback:
            _event_callback({
                "type": "calendar_webhook",
                "agent": channel_token,
                "resource_state": resource_state,
            })

        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Calendar webhook error: {e}")
        return {"status": "error"}


@app.post("/webhook/{agent_name}/chat")
async def webhook_chat(agent_name: str, request: Request):
    try:
        body = await request.json()
        data_b64 = body.get("message", {}).get("data", "")
        if not data_b64:
            return {"status": "ignored"}

        decoded = json.loads(base64.b64decode(data_b64))

        # Filter out Gmail notifications on shared topic
        if "emailAddress" in decoded and "historyId" in decoded:
            return {"status": "ignored", "reason": "gmail_on_chat_topic"}

        if _event_callback:
            _event_callback({
                "type": "chat_webhook",
                "agent": agent_name,
                "data": decoded,
            })

        return {"status": "ok"}
    except Exception as e:
        logger.error(f"Chat webhook error: {e}")
        return {"status": "error"}


class SendEmailRequest(BaseModel):
    from_agent: str  # "thais", "botti"
    to: str
    subject: str
    body: str
    cc: str = ""


@app.post("/send-email")
async def send_email(req: SendEmailRequest, request: Request = None):
    """Send email via gws CLI. Enforces external_comms policy per agent."""
    if request and not _check_api_key(request):
        return {"status": "error", "message": "Invalid API key"}

    config = _agent_configs.get(req.from_agent)
    if not config:
        return {"status": "error", "message": f"Unknown agent: {req.from_agent}"}

    config_dir = config.get("gws_config_dir", "")
    if not config_dir:
        return {"status": "error", "message": f"No gws_config_dir for {req.from_agent}"}

    ext_mode = config.get("external_comms", "blocked")
    internal_domains = config.get("internal_domains", ["@bestoftours.co.uk", "@botler360.com"])
    whitelist = [w.lower() for w in config.get("recipient_whitelist", [])]
    to_lower = req.to.strip().lower()
    is_internal = any(to_lower.endswith(d) for d in internal_domains)

    # External comms policy
    if not is_internal:
        if ext_mode == "blocked":
            return {"status": "blocked", "message": f"Agent {req.from_agent} cannot send to external addresses (mode=blocked)"}
        if ext_mode == "supervised":
            is_whitelisted = any(to_lower == w or (w.endswith("*") and to_lower.endswith(w[:-1])) for w in whitelist)
            if not is_whitelisted:
                # Create draft instead of sending + notify
                return await _draft_and_notify(req, config_dir, config)

    # Send
    try:
        result = _send_via_gws(config_dir, req.to, req.subject, req.body, req.cc)
        logger.info(f"[{req.from_agent}] Email sent to {req.to}: {req.subject}")
        return {"status": "sent", "to": req.to, "subject": req.subject, "result": result}
    except Exception as e:
        logger.error(f"[{req.from_agent}] Email send failed: {e}")
        return {"status": "error", "message": str(e)}


async def _draft_and_notify(req: SendEmailRequest, config_dir: str, config: dict):
    """For supervised mode: create draft + notify owner."""
    try:
        # Create draft
        draft_result = _create_draft_via_gws(config_dir, req.to, req.subject, req.body)
        logger.info(f"[{req.from_agent}] DRAFT created (supervised) to {req.to}: {req.subject}")

        # Notify via IPC file for NanoClaw/WhatsApp pickup
        ipc_dir = os.path.join(os.path.dirname(__file__), "data", "ipc")
        os.makedirs(ipc_dir, exist_ok=True)
        import time
        with open(os.path.join(ipc_dir, f"{req.from_agent}-draft-review.json"), "w") as f:
            json.dump({
                "agent": req.from_agent,
                "action": "DRAFT_REVIEW",
                "to": req.to,
                "subject": req.subject,
                "body": req.body[:500],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, f, indent=2, ensure_ascii=False)

        return {
            "status": "draft_created",
            "message": f"External email to {req.to} saved as draft (supervised mode). Owner notified for review.",
            "draft": draft_result,
        }
    except Exception as e:
        logger.error(f"[{req.from_agent}] Draft creation failed: {e}")
        return {"status": "error", "message": str(e)}


def _send_via_gws(config_dir: str, to: str, subject: str, body: str, cc: str = "") -> dict:
    env = os.environ.copy()
    env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir
    cmd = ["gws", "gmail", "+send", "--to", to, "--subject", subject, "--body", body]
    if cc:
        cmd.extend(["--cc", cc])
    r = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"gws send failed: {r.stderr.strip()[:200]}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"raw": r.stdout.strip()[:200]}


def _create_draft_via_gws(config_dir: str, to: str, subject: str, body: str) -> dict:
    env = os.environ.copy()
    env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir
    # Create draft using raw API
    import base64 as b64
    raw_msg = f"To: {to}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}"
    encoded = b64.urlsafe_b64encode(raw_msg.encode()).decode()
    r = subprocess.run(
        ["gws", "gmail", "users", "drafts", "create", "--params",
         json.dumps({"userId": "me"}), "--json",
         json.dumps({"message": {"raw": encoded}})],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"gws draft failed: {r.stderr.strip()[:200]}")
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"raw": r.stdout.strip()[:200]}


class AgentActionRequest(BaseModel):
    action: str  # "send-email", "fetch-sheet"
    agent: str   # "thais", "botti"
    params: dict = {}


@app.post("/agent-action")
async def agent_action(req: AgentActionRequest, request: Request):
    """Unified agent action endpoint. Routes to the right handler."""
    if not _check_api_key(request):
        return {"status": "error", "message": "Invalid API key"}

    config = _agent_configs.get(req.agent)
    if not config:
        return {"status": "error", "message": f"Unknown agent: {req.agent}"}

    config_dir = config.get("gws_config_dir", "")

    if req.action == "send-email":
        return await _handle_send_email(req, config, config_dir)
    elif req.action == "fetch-sheet":
        return await _handle_fetch_sheet(req, config, config_dir)
    else:
        return {"status": "error", "message": f"Unknown action: {req.action}"}


async def _handle_send_email(req: AgentActionRequest, config: dict, config_dir: str):
    to = req.params.get("to", "")
    subject = req.params.get("subject", "")
    body = req.params.get("body", "")
    cc = req.params.get("cc", "")
    if not to or not subject:
        return {"status": "error", "message": "Missing 'to' or 'subject' in params"}

    email_req = SendEmailRequest(from_agent=req.agent, to=to, subject=subject, body=body, cc=cc)
    return await send_email(email_req)


async def _handle_fetch_sheet(req: AgentActionRequest, config: dict, config_dir: str):
    spreadsheet_id = req.params.get("spreadsheet_id", "")
    range_ = req.params.get("range", "A1:Z100")
    if not spreadsheet_id:
        return {"status": "error", "message": "Missing 'spreadsheet_id' in params"}

    # Try with agent's own account first, fallback to default gws
    for attempt_config_dir in [config_dir, ""]:
        try:
            result = _read_sheet_via_gws(attempt_config_dir, spreadsheet_id, range_)
            source = req.agent if attempt_config_dir else "default"
            logger.info(f"[{req.agent}] Sheet read OK (via {source}): {spreadsheet_id} {range_}")
            return {"status": "ok", "data": result, "source": source}
        except Exception as e:
            if attempt_config_dir:
                logger.warning(f"[{req.agent}] Sheet read failed with own account, trying default: {e}")
                continue
            logger.error(f"[{req.agent}] Sheet read failed: {e}")
            return {"status": "error", "message": str(e)}

    return {"status": "error", "message": "Sheet read failed with all accounts"}


def _read_sheet_via_gws(config_dir: str, spreadsheet_id: str, range_: str) -> dict:
    env = os.environ.copy()
    if config_dir:
        env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir
    r = subprocess.run(
        ["gws", "sheets", "+read", "--spreadsheet", spreadsheet_id, "--range", range_],
        capture_output=True, text=True, env=env, timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"gws sheets read failed: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


@app.get("/health")
async def health():
    import cost_tracker
    return {"status": "ok", "costs": cost_tracker.get_summary()}
