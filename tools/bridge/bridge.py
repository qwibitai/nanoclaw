"""MarvinClaw Host Bridge.

Lightweight HTTP server exposing read-only macOS operations
to the MarvinClaw Docker container. Endpoints are allowlisted —
the container cannot run arbitrary commands on the host.

Usage:
  python3 bridge.py [--port 19876] [--host 127.0.0.1]
"""

import json
import os
import subprocess
from http.server import HTTPServer, BaseHTTPRequestHandler

# AppleScript paths — co-located with this bridge script
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MAIL_SEARCH_SCRIPT = os.path.join(_SCRIPT_DIR, "mail-search.applescript")
MAIL_READ_SCRIPT = os.path.join(_SCRIPT_DIR, "mail-read.applescript")

ICALBUDDY = "/opt/homebrew/bin/icalBuddy"


def run_command(args, timeout=120, **kwargs):
    try:
        result = subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, shell=False,
            **kwargs
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "timeout"


class BridgeHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        pass

    def _send_json(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def _read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_GET(self):
        if self.path == "/health":
            self._handle_health()
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path == "/health":
            self._send_json(405, {"error": "Method not allowed. Use GET."})
            return
        try:
            body = self._read_json_body()
        except (json.JSONDecodeError, ValueError):
            self._send_json(400, {"error": "Invalid JSON body"})
            return

        if self.path == "/calendar/today":
            self._handle_calendar_today(body)
        elif self.path == "/calendar/range":
            self._handle_calendar_range(body)
        elif self.path == "/mail/search":
            self._handle_mail_search(body)
        elif self.path == "/mail/read":
            self._handle_mail_read(body)
        elif self.path == "/mail/draft":
            self._handle_mail_draft(body)
        else:
            self._send_json(404, {"error": "Not found"})

    def _handle_health(self):
        self._send_json(200, {"status": "ok", "service": "marvinclaw-bridge"})

    def _handle_calendar_today(self, body):
        args = [
            ICALBUDDY, "-nc",
            "-ec", "morgan.gandal@gmail.com",
            "eventsToday"
        ]
        code, stdout, stderr = run_command(args, timeout=30)
        if code != 0:
            self._send_json(502, {"error": f"iCalBuddy failed: {stderr}"})
            return
        self._send_json(200, {"output": stdout})

    def _handle_calendar_range(self, body):
        days = body.get("days", 7)
        if not isinstance(days, int) or days < 0:
            self._send_json(400, {"error": "days must be a non-negative integer"})
            return
        days = min(days, 30)
        args = [
            ICALBUDDY, "-nc",
            "-ec", "morgan.gandal@gmail.com",
            f"eventsToday+{days}"
        ]
        code, stdout, stderr = run_command(args, timeout=30)
        if code != 0:
            self._send_json(502, {"error": f"iCalBuddy failed: {stderr}"})
            return
        self._send_json(200, {"output": stdout})

    def _handle_mail_search(self, body):
        query = body.get("query", "")
        if not query or not query.strip():
            self._send_json(400, {"error": "query is required and cannot be empty"})
            return
        days = body.get("days", 7)
        if isinstance(days, int):
            days = min(days, 90)
        else:
            days = 7
        account = body.get("account", "all")
        args = [
            "osascript", MAIL_SEARCH_SCRIPT,
            query, str(days), account
        ]
        code, stdout, stderr = run_command(args, timeout=120)
        if code == -1:
            self._send_json(504, {"error": "Mail search timed out"})
            return
        if code != 0:
            self._send_json(502, {"error": f"Mail search failed: {stderr}"})
            return
        self._send_json(200, {"output": stdout})

    def _handle_mail_read(self, body):
        msg_id = body.get("id", "")
        if not msg_id:
            self._send_json(400, {"error": "id is required"})
            return
        account = body.get("account", "all")
        args = ["osascript", MAIL_READ_SCRIPT, str(msg_id), account]
        code, stdout, stderr = run_command(args, timeout=30)
        if code == -1:
            self._send_json(504, {"error": "Mail read timed out"})
            return
        if code != 0:
            self._send_json(502, {"error": f"Mail read failed: {stderr}"})
            return
        if stdout.startswith("ERROR:"):
            self._send_json(404, {"error": stdout})
            return
        self._send_json(200, {"output": stdout})

    def _handle_mail_draft(self, body):
        to = body.get("to", "")
        subject = body.get("subject", "")
        draft_body = body.get("body", "")
        account = body.get("account", "Exchange")
        if not to:
            self._send_json(400, {"error": "to is required"})
            return
        if not subject:
            self._send_json(400, {"error": "subject is required"})
            return
        if not draft_body:
            self._send_json(400, {"error": "body is required"})
            return
        safe_to = to.replace('"', '\\"')
        safe_subject = subject.replace('"', '\\"')
        safe_body = draft_body.replace('"', '\\"')
        safe_account = account.replace('"', '\\"')
        applescript = (
            f'tell application "Mail"\n'
            f'  set newMessage to make new outgoing message with properties '
            f'{{subject:"{safe_subject}", content:"{safe_body}", visible:true}}\n'
            f'  tell newMessage\n'
            f'    make new to recipient at end of to recipients '
            f'with properties {{address:"{safe_to}"}}\n'
            f'  end tell\n'
            f'  set message viewer of newMessage to account "{safe_account}"\n'
            f'end tell'
        )
        args = ["osascript", "-e", applescript]
        code, stdout, stderr = run_command(args, timeout=30)
        if code == -1:
            self._send_json(504, {"error": "Draft creation timed out"})
            return
        if code != 0:
            self._send_json(502, {"error": f"Draft creation failed: {stderr}"})
            return
        self._send_json(200, {"status": "draft_created", "to": to, "subject": subject})


def create_server(host="127.0.0.1", port=19876):
    return HTTPServer((host, port), BridgeHandler)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="MarvinClaw Host Bridge")
    parser.add_argument("--port", type=int, default=19876)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()

    server = create_server(args.host, args.port)
    print(f"MarvinClaw bridge listening on {args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.shutdown()
