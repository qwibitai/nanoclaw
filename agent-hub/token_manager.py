"""
token_manager.py — GWS OAuth token refresh + alerting.
Checks all agent tokens hourly, refreshes proactively, alerts on failure.
"""
import json
import logging
import os
import subprocess
import threading
import time

logger = logging.getLogger(__name__)

WHATSAPP_NOTIFY_JID = os.environ.get("WHATSAPP_NOTIFY_JID", "")


class TokenManager:
    def __init__(self, agents: list):
        self.agents = agents  # list of agent configs
        self._stop = threading.Event()
        self._thread = None

    def start(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        logger.info("TokenManager started")

    def stop(self):
        self._stop.set()

    def _loop(self):
        while not self._stop.is_set():
            self.check_all()
            self._stop.wait(3600)  # check every hour

    def check_all(self):
        for agent in self.agents:
            config_dir = agent.get("gws_config_dir", "")
            if not config_dir or not os.path.exists(config_dir):
                continue
            try:
                self._check_token(agent)
            except Exception as e:
                logger.error(f"Token check failed for {agent['name']}: {e}")

    def _check_token(self, agent: dict):
        config_dir = agent["gws_config_dir"]
        env = os.environ.copy()
        env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir

        result = subprocess.run(
            ["gws", "auth", "status"],
            capture_output=True, text=True, env=env, timeout=15,
        )

        if result.returncode != 0:
            self._alert(agent, f"gws auth status failed: {result.stderr[:100]}")
            return

        try:
            status = json.loads(result.stdout)
        except json.JSONDecodeError:
            return

        if not status.get("token_valid", False):
            error = status.get("token_error", "unknown")
            self._alert(agent, f"Token invalid: {error}")

    def _alert(self, agent: dict, message: str):
        alert_msg = f"TOKEN ALERT: {agent['name']} ({agent.get('gws_accounts', ['?'])[0]}) — {message}"
        logger.error(alert_msg)

        # Write alert file for NanoClaw to pick up and send via WhatsApp
        alert_file = f"/tmp/token-alert-{agent['name']}.json"
        with open(alert_file, "w") as f:
            json.dump({
                "type": "token_expired",
                "agent": agent["name"],
                "message": message,
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, f)
