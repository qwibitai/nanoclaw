"""
cloudrun_server.py — Lightweight Cloud Run endpoint for /agent-action.
No polling, no orchestrator — just the action proxy for Claude Enterprise.
GWS credentials baked into the container image.
"""
import json
import logging
import os
import subprocess
import base64 as b64

from fastapi import FastAPI, Request
from pydantic import BaseModel
import uvicorn

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("cloudrun")

app = FastAPI(title="Agent Hub Actions")

API_KEY = os.environ.get("AGENT_HUB_API_KEY", "")

# Agent → GWS config dir mapping
AGENT_GWS_DIRS = {
    "thais": "/app/gws-creds/accounts/thais",
    "botti": "/app/gws-creds/accounts/sam",
}
DEFAULT_GWS_DIR = "/app/gws-creds"

# Agent policies
AGENT_POLICIES = {
    "thais": {"external_comms": "supervised", "internal_domains": ["@bestoftours.co.uk", "@botler360.com"]},
    "botti": {"external_comms": "supervised", "internal_domains": ["@bestoftours.co.uk", "@botler360.com"]},
}


def check_api_key(request: Request) -> bool:
    if not API_KEY:
        return True
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:] == API_KEY
    return auth == API_KEY


class AgentActionRequest(BaseModel):
    action: str
    agent: str
    params: dict = {}


@app.post("/agent-action")
async def agent_action(req: AgentActionRequest, request: Request):
    if not check_api_key(request):
        return {"status": "error", "message": "Invalid API key"}

    gws_dir = AGENT_GWS_DIRS.get(req.agent)
    if not gws_dir:
        return {"status": "error", "message": f"Unknown agent: {req.agent}"}

    if req.action == "send-email":
        return _handle_send_email(req, gws_dir)
    elif req.action == "fetch-sheet":
        return _handle_fetch_sheet(req, gws_dir)
    else:
        return {"status": "error", "message": f"Unknown action: {req.action}"}


def _handle_send_email(req: AgentActionRequest, gws_dir: str):
    to = req.params.get("to", "")
    subject = req.params.get("subject", "")
    body = req.params.get("body", "")
    cc = req.params.get("cc", "")
    if not to or not subject:
        return {"status": "error", "message": "Missing 'to' or 'subject'"}

    policy = AGENT_POLICIES.get(req.agent, {})
    internal_domains = policy.get("internal_domains", [])
    ext_mode = policy.get("external_comms", "blocked")
    is_internal = any(to.lower().endswith(d) for d in internal_domains)

    if not is_internal:
        if ext_mode == "blocked":
            return {"status": "blocked", "message": f"Agent {req.agent} cannot send to external addresses"}
        if ext_mode == "supervised":
            # Create draft instead
            try:
                result = _create_draft(gws_dir, to, subject, body)
                logger.info(f"[{req.agent}] DRAFT created (supervised) to {to}: {subject}")
                return {"status": "draft_created", "message": f"External email to {to} saved as draft (supervised)", "draft": result}
            except Exception as e:
                return {"status": "error", "message": str(e)}

    try:
        result = _send_email(gws_dir, to, subject, body, cc)
        logger.info(f"[{req.agent}] Email sent to {to}: {subject}")
        return {"status": "sent", "to": to, "subject": subject, "result": result}
    except Exception as e:
        logger.error(f"[{req.agent}] Send failed: {e}")
        return {"status": "error", "message": str(e)}


def _handle_fetch_sheet(req: AgentActionRequest, gws_dir: str):
    spreadsheet_id = req.params.get("spreadsheet_id", "")
    range_ = req.params.get("range", "A1:Z100")
    if not spreadsheet_id:
        return {"status": "error", "message": "Missing 'spreadsheet_id'"}

    for config_dir in [gws_dir, DEFAULT_GWS_DIR]:
        try:
            result = _read_sheet(config_dir, spreadsheet_id, range_)
            source = req.agent if config_dir == gws_dir else "default"
            logger.info(f"[{req.agent}] Sheet read OK (via {source})")
            return {"status": "ok", "data": result, "source": source}
        except Exception:
            continue

    return {"status": "error", "message": "Sheet read failed with all accounts"}


def _gws_env(config_dir: str) -> dict:
    env = os.environ.copy()
    env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir
    env["GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND"] = "file"
    return env


def _send_email(config_dir: str, to: str, subject: str, body: str, cc: str = "") -> dict:
    cmd = ["gws", "gmail", "+send", "--to", to, "--subject", subject, "--body", body]
    if cc:
        cmd.extend(["--cc", cc])
    r = subprocess.run(cmd, capture_output=True, text=True, env=_gws_env(config_dir), timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"gws send failed: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"raw": r.stdout.strip()[:200]}


def _create_draft(config_dir: str, to: str, subject: str, body: str) -> dict:
    raw_msg = f"To: {to}\r\nSubject: {subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n{body}"
    encoded = b64.urlsafe_b64encode(raw_msg.encode()).decode()
    r = subprocess.run(
        ["gws", "gmail", "users", "drafts", "create", "--params",
         json.dumps({"userId": "me"}), "--json",
         json.dumps({"message": {"raw": encoded}})],
        capture_output=True, text=True, env=_gws_env(config_dir), timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"gws draft failed: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout) if r.stdout.strip().startswith("{") else {"raw": r.stdout.strip()[:200]}


def _read_sheet(config_dir: str, spreadsheet_id: str, range_: str) -> dict:
    r = subprocess.run(
        ["gws", "sheets", "+read", "--spreadsheet", spreadsheet_id, "--range", range_],
        capture_output=True, text=True, env=_gws_env(config_dir), timeout=30,
    )
    if r.returncode != 0:
        raise RuntimeError(f"gws sheets failed: {r.stderr.strip()[:200]}")
    return json.loads(r.stdout)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "agent-hub-cloudrun"}


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="warning")
