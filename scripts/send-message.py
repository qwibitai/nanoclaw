#!/usr/bin/env python3
"""send-message.py — send messages through NanoClaw recipients (v2-ready).

After the v2 cutover, the v1 file-IPC pattern (drop a JSON into
data/ipc/<group>/messages/) is no longer drained by the daemon. This script
now talks directly to each platform's REST API using credentials from
data/env/env, keeping recipients.json as the alias→jid registry.

Commands:
    send  <recipient> <message>           Send a text message
    send-file <recipient> <path> [caption] [--as name]   Attach a file
    email <to> <subject> <body>           Send email via gog CLI
    resolve <query>                        Fuzzy search recipients
    list                                   List all known recipients
    init                                   Auto-discover from v2.db + groups dir

Supported channels for `send`:
    discord, slack, telegram, line, email   → direct REST API
    signal                                   → direct TCP JSON-RPC to signal-cli (port 7583)
    whatsapp                                 → via NanoClaw daemon's `cli.sock` 'deliver' opcode
                                               (Baileys session lives in the daemon)

Migration history:
    Pre-2026-05-08: dropped JSON files into ~/nanoclaw/data/ipc/<group>/messages/.
                    Worked under v1.2.x; broken under v2 (daemon does not drain
                    that directory).
    2026-05-08:     rewritten to call platform REST APIs directly. Keeps the
                    same recipients.json registry and the same CLI surface.
"""

import json
import mimetypes
import os
import re
import socket
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import NoReturn

# ── Paths (v2) ───────────────────────────────────────────────────────────
HOME = Path.home()
NANOCLAW = HOME / "nanoclaw"
REGISTRY_PATH = NANOCLAW / "data" / "recipients.json"
DB_PATH = NANOCLAW / "data" / "v2.db"
ENV_PATH = NANOCLAW / "data" / "env" / "env"
GROUPS_DIR = NANOCLAW / "groups"
CLI_SOCK = NANOCLAW / "data" / "cli.sock"
SIGNAL_RPC_HOST = "127.0.0.1"
SIGNAL_RPC_PORT = 7583


# ── Output helpers ───────────────────────────────────────────────────────
def err(msg: str) -> None:
    print(msg, file=sys.stderr)


def ok(data: dict) -> NoReturn:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    sys.exit(0)


def fail(msg: str) -> NoReturn:
    err(f"ERROR: {msg}")
    sys.exit(1)


# ── Environment loader ───────────────────────────────────────────────────
_ENV_CACHE: dict | None = None


def load_env() -> dict:
    """Parse ~/nanoclaw/data/env/env into a dict (cached)."""
    global _ENV_CACHE
    if _ENV_CACHE is not None:
        return _ENV_CACHE
    env: dict = {}
    if ENV_PATH.exists():
        for raw in ENV_PATH.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                val = val[1:-1]
            env[key.strip()] = val
    _ENV_CACHE = env
    return env


def env_or_fail(name: str) -> str:
    val = load_env().get(name)
    if not val:
        fail(f"Missing env var {name} in {ENV_PATH}")
    return val


# ── Registry ─────────────────────────────────────────────────────────────
def load_registry() -> dict:
    if REGISTRY_PATH.exists():
        try:
            with open(REGISTRY_PATH) as f:
                data = json.load(f)
            return data.get("recipients", {})
        except (json.JSONDecodeError, IOError) as e:
            err(f"Warning: failed to load registry: {e}")
    return {}


def save_registry(recipients: dict) -> None:
    REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(REGISTRY_PATH, "w") as f:
        json.dump({"recipients": recipients}, f, indent=2, ensure_ascii=False)
        f.write("\n")


# ── HTTP helper ──────────────────────────────────────────────────────────
def _http_json(
    url: str,
    payload: dict | None,
    headers: dict | None = None,
    method: str = "POST",
    timeout: int = 15,
):
    """POST/GET JSON. Returns (status, parsed_body_or_text)."""
    body_bytes = None
    hdrs = {"User-Agent": "jibot/send-message.py"}
    if headers:
        hdrs.update(headers)
    if payload is not None:
        body_bytes = json.dumps(payload).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body_bytes, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


# ── Recipient resolution ─────────────────────────────────────────────────
def resolve_recipient(query: str, recipients: dict):
    """Return (key, entry) or (None, None). Three-tier match."""
    q = query.lower().strip()
    # 1. exact key
    for k, v in recipients.items():
        if k.lower() == q:
            return k, v
    # 2. exact alias
    for k, v in recipients.items():
        if q in [a.lower() for a in v.get("aliases", [])]:
            return k, v
    # 3. substring on key/aliases/description
    matches = []
    for k, v in recipients.items():
        hay = [k.lower()] + [a.lower() for a in v.get("aliases", [])]
        if v.get("description"):
            hay.append(v["description"].lower())
        if any(q in s for s in hay):
            matches.append((k, v))
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        err(f"Multiple matches for {query!r}: {[m[0] for m in matches]}")
        err(f"Using first match: {matches[0][0]}")
        return matches[0]
    return None, None


# ── Channel: Discord ─────────────────────────────────────────────────────
def _discord_open_dm(token: str, user_id: str) -> str:
    """Open a DM channel with a Discord user. Returns channel_id."""
    status, body = _http_json(
        "https://discord.com/api/v10/users/@me/channels",
        {"recipient_id": user_id},
        headers={"Authorization": f"Bot {token}"},
    )
    if status != 200 or not isinstance(body, dict) or "id" not in body:
        fail(f"Discord DM open failed (status={status}): {body}")
    return body["id"]


def _discord_resolve_channel(jid: str) -> str:
    """Map a v1-style 'dc:...' jid to a Discord channel_id, opening a DM if needed."""
    parts = jid.split(":")
    if len(parts) < 3 or parts[0] != "dc":
        fail(
            f"Invalid Discord JID {jid!r} (expected dc:GUILD:CHANNEL or dc:dm:USER_ID)"
        )
    if parts[1] == "dm":
        token = env_or_fail("DISCORD_BOT_TOKEN")
        return _discord_open_dm(token, parts[2])
    return parts[2]


def _send_discord(jid: str, text: str, key: str, channel: str) -> None:
    token = env_or_fail("DISCORD_BOT_TOKEN")
    channel_id = _discord_resolve_channel(jid)
    status, body = _http_json(
        f"https://discord.com/api/v10/channels/{channel_id}/messages",
        {"content": text},
        headers={"Authorization": f"Bot {token}"},
    )
    if status != 200:
        fail(f"Discord send failed (status={status}): {body}")
    msg_id = body.get("id") if isinstance(body, dict) else None
    ok(
        {
            "status": "sent",
            "recipient": key,
            "jid": jid,
            "channel": channel,
            "method": "discord-rest",
            "discord_channel_id": channel_id,
            "discord_message_id": msg_id,
            "preview": text[:120] + ("…" if len(text) > 120 else ""),
        }
    )


def _send_discord_file(
    jid: str, abs_path: str, filename: str, caption: str | None, key: str, channel: str
) -> None:
    token = env_or_fail("DISCORD_BOT_TOKEN")
    channel_id = _discord_resolve_channel(jid)
    mime, _ = mimetypes.guess_type(filename)
    mime = mime or "application/octet-stream"
    with open(abs_path, "rb") as f:
        file_bytes = f.read()

    boundary = "----jbnd" + uuid.uuid4().hex
    payload_json = json.dumps(
        {
            "content": caption or "",
            "attachments": [{"id": 0, "filename": filename}],
        }
    ).encode("utf-8")

    parts: list[bytes] = []
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(b'Content-Disposition: form-data; name="payload_json"\r\n')
    parts.append(b"Content-Type: application/json\r\n\r\n")
    parts.append(payload_json + b"\r\n")
    parts.append(f"--{boundary}\r\n".encode())
    parts.append(
        f'Content-Disposition: form-data; name="files[0]"; filename="{filename}"\r\n'.encode()
    )
    parts.append(f"Content-Type: {mime}\r\n\r\n".encode())
    parts.append(file_bytes + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{channel_id}/messages",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": "jibot/send-message.py",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp_body = json.loads(resp.read().decode("utf-8", errors="replace"))
        ok(
            {
                "status": "sent",
                "recipient": key,
                "jid": jid,
                "channel": channel,
                "method": "discord-rest-attachment",
                "discord_channel_id": channel_id,
                "discord_message_id": resp_body.get("id"),
                "filename": filename,
                "mime": mime,
            }
        )
    except urllib.error.HTTPError as e:
        b = e.read().decode("utf-8", errors="replace")
        fail(f"Discord file send failed (status={e.code}): {b}")


# ── Channel: Slack (multi-tenant) ────────────────────────────────────────
def _slack_token_for_namespace(namespace: str) -> str | None:
    """Pick the right Slack bot token. SLACK_BOT_TOKEN is the default
    workspace; SLACK_2/3/4_BOT_TOKEN are paired with SLACK_N_NAMESPACE
    markers in data/env/env.
    """
    env = load_env()
    if not namespace or namespace in ("default", "henkaku"):
        return env.get("SLACK_BOT_TOKEN")
    for n in range(2, 10):
        ns = env.get(f"SLACK_{n}_NAMESPACE")
        if ns == namespace:
            return env.get(f"SLACK_{n}_BOT_TOKEN")
    return None


def _send_slack(jid: str, text: str, key: str, channel: str) -> None:
    """JID formats observed in recipients.json:
    slack:CHANNEL_ID                         → default workspace channel/user
    slack:USER_ID                             → default workspace DM (target starts with U)
    slack:NAMESPACE:USER_ID                   → namespaced DM
    slack:NAMESPACE:channel:CHANNEL_ID        → namespaced channel
    """
    parts = jid.split(":")
    if len(parts) < 2 or parts[0] != "slack":
        fail(f"Invalid Slack JID {jid!r}")

    namespace = "default"
    target = ""
    if len(parts) == 2:
        target = parts[1]
    elif len(parts) == 3:
        namespace, target = parts[1], parts[2]
    elif len(parts) >= 4:
        namespace, target = parts[1], parts[3]
    else:
        fail(f"Invalid Slack JID {jid!r}")

    token = _slack_token_for_namespace(namespace)
    if not token:
        fail(f"No Slack token found for namespace={namespace!r}. Check {ENV_PATH}.")

    # If target is a user (Slack user IDs start with 'U' or 'W'), open a DM first.
    if target and target[0] in ("U", "W"):
        status, body = _http_json(
            "https://slack.com/api/conversations.open",
            {"users": target},
            headers={"Authorization": f"Bearer {token}"},
        )
        if status != 200 or not (isinstance(body, dict) and body.get("ok")):
            fail(f"Slack conversations.open failed: {body}")
        target = body["channel"]["id"]

    status, body = _http_json(
        "https://slack.com/api/chat.postMessage",
        {"channel": target, "text": text},
        headers={"Authorization": f"Bearer {token}"},
    )
    if status != 200 or not (isinstance(body, dict) and body.get("ok")):
        fail(f"Slack chat.postMessage failed (status={status}): {body}")
    ok(
        {
            "status": "sent",
            "recipient": key,
            "jid": jid,
            "channel": channel,
            "method": "slack-rest",
            "slack_namespace": namespace,
            "slack_channel": target,
            "slack_ts": body.get("ts"),
            "preview": text[:120] + ("…" if len(text) > 120 else ""),
        }
    )


# ── Channel: Telegram ────────────────────────────────────────────────────
def _send_telegram(jid: str, text: str, key: str, channel: str) -> None:
    token = env_or_fail("TELEGRAM_BOT_TOKEN")
    parts = jid.split(":", 1)
    if len(parts) != 2 or parts[0] != "tg":
        fail(f"Invalid Telegram JID {jid!r} (expected tg:CHAT_ID)")
    chat_id = parts[1]
    status, body = _http_json(
        f"https://api.telegram.org/bot{token}/sendMessage",
        {"chat_id": chat_id, "text": text},
    )
    if status != 200 or not (isinstance(body, dict) and body.get("ok")):
        fail(f"Telegram sendMessage failed (status={status}): {body}")
    ok(
        {
            "status": "sent",
            "recipient": key,
            "jid": jid,
            "channel": channel,
            "method": "telegram-rest",
            "telegram_message_id": body.get("result", {}).get("message_id"),
            "preview": text[:120] + ("…" if len(text) > 120 else ""),
        }
    )


# ── Channel: LINE ────────────────────────────────────────────────────────
def _send_line(jid: str, text: str, key: str, channel: str) -> None:
    token = env_or_fail("LINE_CHANNEL_ACCESS_TOKEN")
    parts = jid.split(":", 1)
    if len(parts) != 2 or parts[0] != "line":
        fail(f"Invalid LINE JID {jid!r}")
    target = parts[1]
    if target == "dm":
        fail(
            "LINE 'dm' placeholder JIDs are not sendable. Use the explicit user/group ID."
        )
    status, body = _http_json(
        "https://api.line.me/v2/bot/message/push",
        {"to": target, "messages": [{"type": "text", "text": text}]},
        headers={"Authorization": f"Bearer {token}"},
    )
    if status != 200:
        fail(f"LINE push failed (status={status}): {body}")
    ok(
        {
            "status": "sent",
            "recipient": key,
            "jid": jid,
            "channel": channel,
            "method": "line-rest",
            "preview": text[:120] + ("…" if len(text) > 120 else ""),
        }
    )


# ── Channel: Email (via gog) ─────────────────────────────────────────────
def _send_email_via_jid(jid: str, text: str, key: str, channel: str) -> None:
    parts = jid.split(":", 1)
    if len(parts) != 2 or parts[0] != "email":
        fail(f"Invalid Email JID {jid!r}")
    to = parts[1]
    cmd = [
        "gog",
        "gmail",
        "send",
        "-a",
        "jibot@ito.com",
        "--to",
        to,
        "--subject",
        "(no subject)",
        "--body",
        text,
        "--force",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        fail("gog not found on PATH")
    except subprocess.TimeoutExpired:
        fail("gog send timed out after 30s")
    if result.returncode != 0:
        fail(f"gog gmail send failed: {result.stderr.strip()}")
    ok(
        {
            "status": "sent",
            "recipient": key,
            "jid": jid,
            "channel": channel,
            "method": "gog",
            "preview": text[:120] + ("…" if len(text) > 120 else ""),
        }
    )


# ── Channel: Signal (direct via signal-cli TCP JSON-RPC) ─────────────────
def _signal_rpc(method: str, params: dict, timeout: float = 30.0) -> dict:
    """Send a JSON-RPC 2.0 call to signal-cli's TCP daemon (port 7583).

    signal-cli's `--tcp` mode exposes a newline-delimited JSON-RPC socket;
    the v2 NanoClaw daemon talks to the same port (see src/channels/signal.ts).
    We open a fresh connection per call rather than holding the socket open,
    because the daemon's long-lived connection multiplexes inbound + outbound
    and we don't want to fight it for read framing.
    """
    rpc_id = uuid.uuid4().hex[:12]
    payload = json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": rpc_id}) + "\n"
    try:
        sock = socket.create_connection((SIGNAL_RPC_HOST, SIGNAL_RPC_PORT), timeout=5.0)
    except (ConnectionRefusedError, OSError) as e:
        fail(
            f"signal-cli daemon not reachable at {SIGNAL_RPC_HOST}:{SIGNAL_RPC_PORT} ({e}). "
            f"Is the NanoClaw service running? Check `launchctl list | grep com.jibot.nanoclaw`."
        )
    sock.settimeout(timeout)
    try:
        sock.sendall(payload.encode("utf-8"))
        # Read newline-delimited responses; daemon may interleave notifications
        # (jsonrpc messages without `id`); skip those until we see our reply.
        buf = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                fail("signal-cli closed the socket before responding")
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(msg, dict) and msg.get("id") == rpc_id:
                    return msg
                # else: notification or unrelated reply; keep reading
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _send_signal(jid: str, text: str, key: str, channel: str) -> None:
    """JID formats observed in recipients.json:
        sig:+PHONE              → DM by phone (e.g. sig:+819048411965)
        sig:UUID                → DM by ACI/PNI uuid
        sig:group:KEY=          → group (KEY is base64; may contain '+/=')
    """
    if not jid.startswith("sig:"):
        fail(f"Invalid Signal JID {jid!r} (expected sig:...)")
    target = jid[len("sig:"):]
    params: dict = {"message": text}
    account = load_env().get("SIGNAL_ACCOUNT")
    if account:
        params["account"] = account
    if target.startswith("group:"):
        params["groupId"] = target[len("group:"):]
    elif target:
        params["recipient"] = [target]
    else:
        fail(f"Invalid Signal JID {jid!r}: empty target after 'sig:' prefix")

    reply = _signal_rpc("send", params)
    if isinstance(reply, dict) and "error" in reply:
        err_obj = reply["error"]
        msg = err_obj.get("message") if isinstance(err_obj, dict) else str(err_obj)
        fail(f"signal-cli send failed: {msg}")
    result = reply.get("result") if isinstance(reply, dict) else None
    timestamp = result.get("timestamp") if isinstance(result, dict) else None
    sig_target = (
        ("group:" + params["groupId"]) if "groupId" in params
        else params["recipient"][0]
    )
    ok({
        "status": "sent",
        "recipient": key,
        "jid": jid,
        "channel": channel,
        "method": "signal-cli-jsonrpc",
        "signal_target": sig_target,
        "signal_timestamp": timestamp,
        "preview": text[:120] + ("…" if len(text) > 120 else ""),
    })


# ── Channel: daemon-mediated outbound (WhatsApp + future channels) ───────
def _send_via_daemon(channel_type: str, platform_id: str, text: str,
                     thread_id: str | None = None) -> dict:
    """Send through the NanoClaw daemon's `cli.sock` 'deliver' opcode.

    The daemon (see src/channels/cli.ts) accepts a JSON line of the form:
        {"deliver": {"channelType": "...", "platformId": "...",
                      "threadId": ..., "text": "..."}}
    and replies with a JSON line:
        {"ok": true, "messageId": "..."}        on success
        {"ok": false, "error": "..."}          on failure

    Used for channels whose outbound session lives in the daemon (WhatsApp's
    Baileys websocket, future iMessage, etc.) where a separate REST or TCP
    client cannot reach the same conversation.
    """
    if not CLI_SOCK.exists():
        fail(
            f"NanoClaw cli.sock not found at {CLI_SOCK}. Daemon is not running. "
            f"Try `launchctl kickstart -k gui/$(id -u)/com.jibot.nanoclaw`."
        )
    payload = json.dumps({
        "deliver": {
            "channelType": channel_type,
            "platformId": platform_id,
            "threadId": thread_id,
            "text": text,
        }
    }) + "\n"
    try:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(30.0)
        sock.connect(str(CLI_SOCK))
    except (FileNotFoundError, ConnectionRefusedError, OSError) as e:
        fail(f"Could not connect to {CLI_SOCK}: {e}")
    try:
        sock.sendall(payload.encode("utf-8"))
        buf = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            buf += chunk
            if b"\n" in buf:
                line, _ = buf.split(b"\n", 1)
                line = line.strip()
                if line:
                    try:
                        return json.loads(line)
                    except json.JSONDecodeError:
                        fail(f"Daemon returned non-JSON reply: {line[:200]!r}")
        if buf.strip():
            try:
                return json.loads(buf.strip())
            except json.JSONDecodeError:
                fail(f"Daemon returned non-JSON reply: {buf[:200]!r}")
        fail(
            "Daemon closed the socket without replying — opcode may not be wired up. "
            "Ensure ~/nanoclaw was rebuilt + restarted after the cli.ts change."
        )
    finally:
        try:
            sock.close()
        except OSError:
            pass


def _send_whatsapp(jid: str, text: str, key: str, channel: str) -> None:
    """JID format: bare WhatsApp jid, e.g. '120363406306168518@g.us' (group)
    or '<phone>@s.whatsapp.net' (DM). Routed through the daemon because the
    Baileys websocket session lives there — there is no public REST API.
    """
    if not jid:
        fail(f"Empty WhatsApp JID for {key!r}")
    reply = _send_via_daemon("whatsapp", jid, text)
    if not (isinstance(reply, dict) and reply.get("ok")):
        fail(f"WhatsApp daemon-deliver failed: {reply}")
    ok({
        "status": "sent",
        "recipient": key,
        "jid": jid,
        "channel": channel,
        "method": "nanoclaw-cli-deliver",
        "whatsapp_message_id": reply.get("messageId"),
        "preview": text[:120] + ("…" if len(text) > 120 else ""),
    })


# ── Channel: not yet supported ───────────────────────────────────────────
def _unsupported_v2(jid: str, text: str, key: str, channel: str) -> None:
    fail(
        f"Channel {channel!r} (jid={jid!r}) is not yet supported by send-message.py. "
        f"Either the channel is unknown to the v2 daemon, or no outbound path has "
        f"been wired (file an issue or extend send-message.py)."
    )


CHANNEL_SENDERS = {
    "discord": _send_discord,
    "slack": _send_slack,
    "telegram": _send_telegram,
    "line": _send_line,
    "email": _send_email_via_jid,
    "signal": _send_signal,
    "whatsapp": _send_whatsapp,
    "unknown": _unsupported_v2,
}


# ── v2.db helpers ────────────────────────────────────────────────────────
def _v2_to_v1_jid(channel_type: str, platform_id: str) -> str:
    """Map v2 messaging_groups.platform_id → v1-style JID prefix used in
    recipients.json so existing aliases keep working with the same shape."""
    if channel_type == "discord" and platform_id.startswith("discord:"):
        return "dc:" + platform_id[len("discord:") :]
    if (
        channel_type
        and channel_type.startswith("slack")
        and platform_id.startswith("slack:")
    ):
        return platform_id  # slack: prefix already canonical
    if channel_type == "telegram" and platform_id.startswith("telegram:"):
        return "tg:" + platform_id[len("telegram:") :]
    if channel_type == "line" and platform_id.startswith("line:group:"):
        return "line:" + platform_id[len("line:group:") :]
    if channel_type == "signal" and platform_id.startswith("group:"):
        return "sig:" + platform_id
    return platform_id


# ── Commands ─────────────────────────────────────────────────────────────
def cmd_send(args: list[str]) -> None:
    if len(args) < 2:
        fail("Usage: send <recipient> <message>")
    query, message = args[0], args[1]
    recipients = load_registry()
    key, entry = resolve_recipient(query, recipients)
    if not entry:
        fail(f"No recipient found for {query!r}. Try: resolve {query!r}")
    channel = entry.get("channel", "unknown")
    sender = CHANNEL_SENDERS.get(channel, _unsupported_v2)
    sender(jid=entry["jid"], text=message, key=key, channel=channel)


def cmd_send_file(args: list[str]) -> None:
    """Currently Discord-only. Slack files.upload v2 + others can be added."""
    filename_override: str | None = None
    pos: list[str] = []
    i = 0
    while i < len(args):
        if args[i] == "--as" and i + 1 < len(args):
            filename_override = args[i + 1]
            i += 2
        else:
            pos.append(args[i])
            i += 1
    if len(pos) < 2:
        fail("Usage: send-file <recipient> <file-path> [<caption>] [--as <name>]")
    query = pos[0]
    file_path_str = pos[1]
    caption = pos[2] if len(pos) > 2 else None

    if not os.path.isfile(file_path_str):
        fail(f"File not found or not a regular file: {file_path_str}")
    if not os.access(file_path_str, os.R_OK):
        fail(f"File is not readable: {file_path_str}")
    abs_path = os.path.abspath(file_path_str)
    filename = filename_override or os.path.basename(abs_path)

    recipients = load_registry()
    key, entry = resolve_recipient(query, recipients)
    if not entry:
        fail(f"No recipient found for {query!r}")
    channel = entry.get("channel", "unknown")
    if channel != "discord":
        fail(
            f"send-file currently only supports discord (got {channel!r}). "
            f"Slack files.upload + others can be added; file an issue."
        )
    _send_discord_file(entry["jid"], abs_path, filename, caption, key, channel)


def cmd_email(args: list[str]) -> None:
    if len(args) < 3:
        fail("Usage: email <to> <subject> <body>")
    to, subject, body = args[0], args[1], args[2]
    cmd = [
        "gog",
        "gmail",
        "send",
        "-a",
        "jibot@ito.com",
        "--to",
        to,
        "--subject",
        subject,
        "--body",
        body,
        "--force",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        fail("gog not found on PATH")
    except subprocess.TimeoutExpired:
        fail("gog send timed out after 30s")
    if result.returncode != 0:
        err(f"gog send failed (exit {result.returncode}): {result.stderr.strip()}")
        fail("Email send failed.")
    ok(
        {
            "status": "sent",
            "to": to,
            "subject": subject,
            "method": "gog",
            "stdout": result.stdout.strip(),
        }
    )


def cmd_resolve(args: list[str]) -> None:
    if not args:
        fail("Usage: resolve <query>")
    query = args[0]
    q = query.lower().strip()
    recipients = load_registry()
    matches: list[dict] = []
    for k, v in recipients.items():
        hay = [k.lower()] + [a.lower() for a in v.get("aliases", [])]
        if v.get("description"):
            hay.append(v["description"].lower())
        if any(q in s for s in hay):
            matches.append(
                {
                    "name": k,
                    "jid": v["jid"],
                    "channel": v.get("channel", "unknown"),
                    "type": v.get("type", "unknown"),
                    "aliases": v.get("aliases", []),
                    "description": v.get("description", ""),
                }
            )

    db_matches: list[dict] = []
    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.execute(
                "SELECT id, channel_type, platform_id, name, is_group "
                "FROM messaging_groups WHERE LOWER(COALESCE(name, '')) LIKE ?",
                (f"%{q}%",),
            )
            for mg_id, ch, pid, nm, ig in cursor.fetchall():
                v1_jid = _v2_to_v1_jid(ch or "", pid or "")
                if any(m["jid"] == v1_jid for m in matches):
                    continue
                db_matches.append(
                    {
                        "name": nm or mg_id,
                        "jid": v1_jid,
                        "channel": ch or "unknown",
                        "type": "group" if ig else "dm",
                        "source": "v2.db",
                    }
                )
            conn.close()
        except sqlite3.Error as e:
            err(f"v2.db lookup failed: {e}")

    ok(
        {
            "query": query,
            "registry_matches": matches,
            "db_matches": db_matches,
            "total": len(matches) + len(db_matches),
        }
    )


def cmd_list(args: list[str]) -> None:
    recipients = load_registry()
    entries = []
    for k, v in sorted(recipients.items()):
        entries.append(
            {
                "name": k,
                "jid": v["jid"],
                "channel": v.get("channel", "unknown"),
                "type": v.get("type", "unknown"),
                "aliases": v.get("aliases", []),
                "description": v.get("description", ""),
            }
        )
    ok({"count": len(entries), "recipients": entries})


def cmd_init(args: list[str]) -> None:
    """Auto-discover from v2.db messaging_groups + groups dir.

    v1's `chats` table is gone; v2 has `messaging_groups` with a slightly
    different jid prefix scheme. We translate back to v1-style prefixes so
    new entries match the format of the existing 476 hand-curated entries.
    """
    recipients = load_registry()
    added: list[dict] = []
    existing_jids = {e.get("jid", "") for e in recipients.values()}

    if DB_PATH.exists():
        try:
            conn = sqlite3.connect(str(DB_PATH))
            cursor = conn.execute(
                "SELECT id, channel_type, platform_id, name, is_group FROM messaging_groups"
            )
            for mg_id, ch, pid, nm, ig in cursor.fetchall():
                v1_jid = _v2_to_v1_jid(ch or "", pid or "")
                if v1_jid in existing_jids:
                    continue
                if not nm:
                    continue
                key = re.sub(r"[^a-z0-9-]", "", nm.lower().replace(" ", "-"))
                key = re.sub(r"-+", "-", key).strip("-")
                if not key:
                    key = re.sub(r"[^a-z0-9-]", "", v1_jid.lower().replace(":", "-"))
                if key in recipients:
                    key = f"{key}-{ch or 'unknown'}"
                if key in recipients:
                    continue
                entry = {
                    "jid": v1_jid,
                    "aliases": [],
                    "channel": ch or "unknown",
                    "type": "group" if ig else "dm",
                    "description": f"Auto-discovered: {nm}",
                }
                recipients[key] = entry
                existing_jids.add(v1_jid)
                added.append({"key": key, "source": "v2.db", "jid": v1_jid})
            conn.close()
        except sqlite3.Error as e:
            err(f"v2.db scan error: {e}")

    if GROUPS_DIR.exists():
        for g in sorted(GROUPS_DIR.iterdir()):
            if not g.is_dir():
                continue
            folder = g.name
            if folder in ("global",) or folder.startswith("gidc-template"):
                continue
            if folder in recipients:
                continue
            description = f"Group folder: {folder}"
            cm = g / "CLAUDE.md"
            if cm.exists():
                try:
                    first = cm.read_text().strip().split("\n")[0]
                    first = re.sub(r"^#+\s*", "", first).strip()
                    if first:
                        description = first
                except IOError:
                    pass
            entry = {
                "jid": f"group:{folder}",
                "aliases": [],
                "channel": "unknown",
                "type": "group",
                "description": description,
            }
            recipients[folder] = entry
            added.append(
                {"key": folder, "source": "groups_folder", "description": description}
            )

    save_registry(recipients)
    ok(
        {
            "status": "init_complete",
            "total_recipients": len(recipients),
            "newly_added": len(added),
            "added": added,
        }
    )


def main() -> None:
    if len(sys.argv) < 2:
        err("Usage: send-message.py <command> [args...]")
        err("Commands: send, send-file, email, resolve, list, init")
        sys.exit(1)
    command = sys.argv[1].lower()
    args = sys.argv[2:]

    commands = {
        "send": cmd_send,
        "send-file": cmd_send_file,
        "email": cmd_email,
        "resolve": cmd_resolve,
        "list": cmd_list,
        "init": cmd_init,
    }
    if command not in commands:
        fail(f"Unknown command: {command}. Use: {', '.join(commands)}")

    try:
        commands[command](args)
    except SystemExit:
        raise
    except Exception as e:
        fail(f"Unexpected error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
