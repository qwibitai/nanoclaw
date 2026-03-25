"""
orchestrator.py — Agent Hub entry point.
Single process, multi-agent, event-driven.

Usage:
  python3 orchestrator.py                    # shadow mode (default)
  SHADOW_MODE=false python3 orchestrator.py  # production mode
"""
import asyncio
import json
import logging
import os
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from glob import glob

import uvicorn
from dotenv import load_dotenv

load_dotenv()

from agent_thread import AgentThread
from token_manager import TokenManager
from webhook_server import app, set_event_callback, set_agent_configs
import cost_tracker

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("orchestrator")

AGENTS_DIR = os.environ.get("AGENTS_DIR", os.path.join(os.path.dirname(__file__), "agents"))
SHADOW_MODE = os.environ.get("SHADOW_MODE", "true").lower() == "true"
WEBHOOK_PORT = int(os.environ.get("WEBHOOK_PORT", "8090"))

# Poll intervals (seconds)
GMAIL_POLL = 120          # 2 min, 24/7
CHAT_POLL_DAY = 120       # 2 min
CHAT_POLL_NIGHT = 900     # 15 min
DAY_START = 8    # 8:30 (half-hour handled below)
DAY_END = 18     # 18:30 (half-hour handled below)


class Orchestrator:
    def __init__(self):
        self.agents: dict[str, AgentThread] = {}
        self.agent_configs: list[dict] = []
        self.token_manager: TokenManager = None
        self._stop = threading.Event()
        self._poll_threads: list[threading.Thread] = []

    def load_agents(self):
        """Load all agent configs from AGENTS_DIR."""
        for config_file in sorted(glob(os.path.join(AGENTS_DIR, "*.json"))):
            try:
                with open(config_file) as f:
                    config = json.load(f)
                name = config.get("name", os.path.basename(config_file).replace(".json", ""))
                config["name"] = name
                agent = AgentThread(config)
                self.agents[name] = agent
                self.agent_configs.append(config)
                logger.info(f"Loaded agent: {name} ({config.get('display_name', name)})")
            except Exception as e:
                logger.error(f"Failed to load {config_file}: {e}")

    def start(self):
        logger.info(f"Starting Agent Hub (shadow={SHADOW_MODE}, agents={len(self.agents)})")

        # Start agent threads
        for agent in self.agents.values():
            agent.start()

        # Start token manager
        self.token_manager = TokenManager(self.agent_configs)
        self.token_manager.start()

        # Set webhook callback + agent configs for send-email endpoint
        set_event_callback(self._on_webhook_event)
        set_agent_configs({c["name"]: c for c in self.agent_configs})

        # Start poll threads
        for config in self.agent_configs:
            name = config["name"]
            channels = config.get("channels", [])
            if "gmail" in channels:
                t = threading.Thread(target=self._poll_gmail_loop, args=(name, config), daemon=True)
                t.start()
                self._poll_threads.append(t)
            if "chat" in channels:
                t = threading.Thread(target=self._poll_chat_loop, args=(name, config), daemon=True)
                t.start()
                self._poll_threads.append(t)

        logger.info("All agents and pollers started")

    def stop(self):
        logger.info("Shutting down...")
        self._stop.set()
        for agent in self.agents.values():
            agent.stop()
        if self.token_manager:
            self.token_manager.stop()

    # ---------- Event routing ----------

    def _on_webhook_event(self, event: dict):
        """Route webhook events to the right agent thread."""
        agent_name = event.get("agent", "")
        if agent_name not in self.agents:
            # Try to find by email
            email = event.get("email", "")
            for name, agent in self.agents.items():
                accounts = agent.config.get("gws_accounts", [])
                if email in accounts:
                    agent_name = name
                    break

        if agent_name in self.agents:
            self.agents[agent_name].push_event(event)
            logger.debug(f"Routed {event.get('type')} to {agent_name}")
        else:
            logger.warning(f"No agent for event: {event}")

    # ---------- Polling loops ----------

    def _is_daytime(self) -> bool:
        now = datetime.now()
        t = now.hour * 60 + now.minute
        return 8 * 60 + 30 <= t < 18 * 60 + 30  # 8:30 - 18:30

    def _poll_gmail_loop(self, agent_name: str, config: dict):
        """Gmail fallback poll loop."""
        config_dir = config.get("gws_config_dir", "")
        logger.info(f"Gmail poll started for {agent_name} (config_dir={config_dir})")

        first_run = True
        while not self._stop.is_set():
            if first_run:
                first_run = False
            else:
                logger.info(f"[{agent_name}] Gmail next poll in {GMAIL_POLL}s")
                self._stop.wait(GMAIL_POLL)
                if self._stop.is_set():
                    break

            try:
                emails = self._fetch_gmail(config_dir, agent_name)
                if emails:
                    logger.info(f"[{agent_name}] Gmail poll: {len(emails)} new emails")
                if emails:
                    self.agents[agent_name].push_event({
                        "type": "gmail",
                        "emails": emails,
                    })
            except Exception as e:
                logger.error(f"[{agent_name}] Gmail poll error: {e}", exc_info=True)

    def _poll_chat_loop(self, agent_name: str, config: dict):
        """Chat poll loop (no webhook available)."""
        config_dir = config.get("gws_config_dir", "")
        logger.info(f"Chat poll started for {agent_name} (config_dir={config_dir})")

        first_run = True
        while not self._stop.is_set():
            if first_run:
                first_run = False
            else:
                interval = CHAT_POLL_DAY if self._is_daytime() else CHAT_POLL_NIGHT
                self._stop.wait(interval)
                if self._stop.is_set():
                    break

            try:
                messages = self._fetch_chat(config_dir, agent_name)
                if messages:
                    logger.info(f"[{agent_name}] Chat poll: {len(messages)} new messages")
                if messages:
                    self.agents[agent_name].push_event({
                        "type": "chat",
                        "messages": messages,
                    })
            except Exception as e:
                logger.error(f"[{agent_name}] Chat poll error: {e}", exc_info=True)

    def _fetch_gmail(self, config_dir: str, agent_name: str) -> list:
        """Fetch unread emails via gws CLI."""
        env = os.environ.copy()
        env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir
        r = subprocess.run(
            ["gws", "gmail", "users", "messages", "list", "--params",
             json.dumps({"userId": "me", "q": "is:unread in:inbox", "maxResults": 10})],
            capture_output=True, text=True, env=env, timeout=30,
        )
        if r.returncode != 0:
            return []

        stubs = json.loads(r.stdout).get("messages", [])
        agent = self.agents.get(agent_name)
        if not agent:
            return []

        emails = []
        for stub in stubs[:10]:
            if agent._is_processed("gmail", stub["id"]):
                continue
            try:
                msg = self._fetch_gmail_message(stub["id"], config_dir, env)
                if msg:
                    emails.append(msg)
            except Exception:
                pass
        return emails

    def _fetch_gmail_message(self, msg_id: str, config_dir: str, env: dict) -> dict:
        r = subprocess.run(
            ["gws", "gmail", "users", "messages", "get", "--params",
             json.dumps({"userId": "me", "id": msg_id, "format": "metadata",
                         "metadataHeaders": ["From", "Subject", "Date"]})],
            capture_output=True, text=True, env=env, timeout=15,
        )
        if r.returncode != 0:
            return None
        data = json.loads(r.stdout)
        headers = {h["name"]: h["value"] for h in data.get("payload", {}).get("headers", [])}
        return {
            "id": msg_id,
            "from": headers.get("From", ""),
            "subject": headers.get("Subject", ""),
            "date": headers.get("Date", ""),
            "snippet": data.get("snippet", ""),
        }

    def _fetch_chat(self, config_dir: str, agent_name: str) -> list:
        """Fetch new chat messages from all spaces."""
        env = os.environ.copy()
        env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = config_dir

        # List spaces
        r = subprocess.run(
            ["gws", "chat", "spaces", "list", "--params", json.dumps({"pageSize": 50})],
            capture_output=True, text=True, env=env, timeout=15,
        )
        if r.returncode != 0:
            return []

        spaces = [s for s in json.loads(r.stdout).get("spaces", [])
                  if s.get("type") in ("ROOM", "SPACE", "GROUP_CHAT")]

        agent = self.agents.get(agent_name)
        if not agent:
            return []

        all_new = []
        for space in spaces:
            space_id = space.get("name", "")
            space_name = space.get("displayName", space_id)
            if not space_id:
                continue

            try:
                r = subprocess.run(
                    ["gws", "chat", "spaces", "messages", "list", "--params",
                     json.dumps({"parent": space_id, "pageSize": 15, "orderBy": "createTime desc"})],
                    capture_output=True, text=True, env=env, timeout=15,
                )
                if r.returncode != 0:
                    continue

                for m in json.loads(r.stdout).get("messages", []):
                    mid = m.get("name", "").split("/")[-1]
                    if not mid or agent._is_processed("chat", mid):
                        continue
                    if m.get("sender", {}).get("type") == "BOT":
                        continue
                    all_new.append({
                        "id": mid,
                        "space_id": space_id,
                        "space_name": space_name,
                        "sender_name": m.get("sender", {}).get("displayName", "unknown"),
                        "text": m.get("text", m.get("argumentText", "")),
                        "create_time": m.get("createTime", ""),
                    })
            except Exception:
                continue

        return all_new


def main():
    orch = Orchestrator()
    orch.load_agents()

    if not orch.agents:
        logger.error(f"No agents found in {AGENTS_DIR}")
        sys.exit(1)

    orch.start()

    # Run webhook server in main thread
    def shutdown(sig, frame):
        orch.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    logger.info(f"Webhook server starting on port {WEBHOOK_PORT}")
    uvicorn.run(app, host="0.0.0.0", port=WEBHOOK_PORT, log_level="warning")


if __name__ == "__main__":
    main()
