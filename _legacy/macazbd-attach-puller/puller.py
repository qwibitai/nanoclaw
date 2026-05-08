#!/usr/bin/env python3
"""
nanoclaw attachment puller — runs on macazbd.

Listens on 127.0.0.1:9091. Each POST /sync {"file": "<basename>"} pulls
~/nanoclaw/data/attachments/<basename> from jibotmac (over the existing
ssh keys macazbd has into jibotmac) into ATTACH_DEST on macazbd.

Wired into the container-side amplifier-remote provider via
AMPLIFIERD_ATTACH_PULL_URL=http://host.docker.internal:9091/sync. The
container reaches host.docker.internal:9091 → jibotmac:9091, which is
forwarded into macazbd:9091 by the `-R 9091:localhost:9091` option on
macazbd's existing ssh tunnel command (the same ssh that already opens
the amplifierd reverse tunnel).

Env vars:
  ATTACH_PULLER_PORT      default 9091
  ATTACH_PULLER_HOST      default 127.0.0.1
  JIBOTMAC_SSH_HOST       ssh alias for jibotmac (default 'jibotmac')
  JIBOTMAC_ATTACH_DIR     remote path (default '~/nanoclaw/data/attachments')
  ATTACH_DEST             local cache (default '~/.local/share/nanoclaw-attachments')
  ATTACH_PULLER_LOG       optional log path; defaults to stderr only

Symlink amplifierd's session working_dir/workspace/attachments at ATTACH_DEST
so /workspace/attachments/<file> resolves the same on both sides.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shlex
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

PORT = int(os.environ.get("ATTACH_PULLER_PORT", "9091"))
HOST = os.environ.get("ATTACH_PULLER_HOST", "127.0.0.1")
SSH_HOST = os.environ.get("JIBOTMAC_SSH_HOST", "jibotmac")
SRC_DIR = os.environ.get("JIBOTMAC_ATTACH_DIR", "~/nanoclaw/data/attachments")
DST_DIR = Path(os.environ.get("ATTACH_DEST", "~/.local/share/nanoclaw-attachments")).expanduser()

# Channel adapters validate filenames via isSafeAttachmentName, which only
# rejects path separators and NUL — anything else (spaces, parens, unicode)
# is allowed. Mirror that here. The "." / ".." special cases are checked
# separately at the call site.
BASENAME_RE = re.compile(r"^[^/\\\0\r\n]+$")

logger = logging.getLogger("attach-puller")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [attach-puller] %(message)s",
    handlers=[logging.StreamHandler(sys.stderr)],
)


def write_json(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def rsync_one(name: str) -> tuple[bool, str]:
    DST_DIR.mkdir(parents=True, exist_ok=True)
    # The remote path is interpreted by ssh's remote shell, which word-splits
    # on whitespace. shlex.quote wraps spaces/special chars in single quotes
    # so "Letter to Banks.pdf" round-trips intact. We deliberately don't use
    # rsync's --protect-args (-s) because macOS ships rsync 2.6.9 by default,
    # which predates that flag and exits 1 with "unknown option".
    remote_path = f"{SRC_DIR}/{shlex.quote(name)}"
    src = f"{SSH_HOST}:{remote_path}"
    dst = str(DST_DIR / name)
    cmd = [
        "rsync",
        "-a",
        "--timeout=20",
        # -e ssh defaults are fine; ControlMaster in user's ~/.ssh/config
        # will reuse the existing macazbd→jibotmac connection if configured.
        src,
        dst,
    ]
    logger.info("rsync %s → %s", src, dst)
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=25)
    except subprocess.TimeoutExpired:
        return False, "rsync timed out"
    if result.returncode != 0:
        msg = (result.stderr or result.stdout or "").strip().splitlines()
        tail = msg[-1] if msg else f"rsync exited {result.returncode}"
        return False, f"rsync exit {result.returncode}: {tail}"
    if not Path(dst).exists():
        return False, "rsync succeeded but destination file missing"
    return True, dst


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 — http.server API
        logger.info("%s - %s", self.address_string(), fmt % args)

    def do_POST(self) -> None:  # noqa: N802 — http.server API
        if self.path != "/sync":
            write_json(self, 404, {"detail": "unknown path"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else ""
            body = json.loads(raw) if raw else {}
        except (ValueError, json.JSONDecodeError) as e:
            write_json(self, 400, {"detail": f"bad JSON: {e}"})
            return
        name = body.get("file")
        if not isinstance(name, str) or not name:
            write_json(self, 400, {"detail": "missing 'file' (string)"})
            return
        if not BASENAME_RE.match(name) or name in (".", ".."):
            write_json(self, 400, {"detail": f"invalid basename: {name!r}"})
            return
        ok, info = rsync_one(name)
        if ok:
            write_json(self, 200, {"file": name, "path": info})
        else:
            write_json(self, 503, {"file": name, "detail": info})


def main() -> None:
    DST_DIR.mkdir(parents=True, exist_ok=True)
    logger.info(
        "starting on %s:%d (src=%s:%s dst=%s)",
        HOST,
        PORT,
        SSH_HOST,
        SRC_DIR,
        DST_DIR,
    )
    server = HTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("shutting down")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
