"""
agent_thread.py — Per-agent processing thread.
Each agent has its own event queue and processes events sequentially.
"""
import json
import logging
import os
import queue
import subprocess
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import cost_tracker
import triage_engine

logger = logging.getLogger(__name__)

SHADOW_MODE = os.environ.get("SHADOW_MODE", "true").lower() == "true"
LOG_DIR = os.environ.get("LOG_DIR", os.path.join(os.path.dirname(__file__), "logs"))


class AgentThread:
    def __init__(self, config: dict):
        self.config = config
        self.name = config["name"]
        self.display_name = config.get("display_name", self.name)
        self.gws_config_dir = config.get("gws_config_dir", "")
        self.internal_domains = config.get("internal_domains", ["@bestoftours.co.uk", "@botler360.com"])
        self.ext_mode = config.get("external_comms", "blocked")
        self.whitelist = [w.lower() for w in config.get("recipient_whitelist", [])]
        self.channels = config.get("channels", [])

        self.event_queue = queue.Queue()
        self._stop = threading.Event()
        self._thread = None

        # State: processed IDs per channel
        self._state_dir = os.path.join(os.path.dirname(__file__), "data", "state", self.name)
        os.makedirs(self._state_dir, exist_ok=True)

    def start(self):
        self._thread = threading.Thread(target=self._loop, name=f"agent-{self.name}", daemon=True)
        self._thread.start()
        logger.info(f"Agent {self.name} thread started (channels={self.channels}, gws_config={self.gws_config_dir})")

    def stop(self):
        self._stop.set()
        self.event_queue.put(None)  # unblock

    def push_event(self, event: dict):
        self.event_queue.put(event)

    def _loop(self):
        while not self._stop.is_set():
            try:
                event = self.event_queue.get(timeout=5)
                if event is None:
                    continue
                self._process_event(event)
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Agent {self.name} error: {e}")

    def _process_event(self, event: dict):
        event_type = event.get("type", "unknown")
        shadow_log = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "agent": self.name,
            "event_type": event_type,
            "shadow": SHADOW_MODE,
        }

        if cost_tracker.is_limit_hit():
            shadow_log["action"] = "BLOCKED_COST_LIMIT"
            self._log_shadow(shadow_log)
            logger.warning(f"Agent {self.name}: cost limit hit, skipping event")
            return

        if event_type == "gmail":
            self._handle_gmail(event, shadow_log)
        elif event_type == "chat":
            self._handle_chat(event, shadow_log)
        elif event_type == "calendar":
            shadow_log["summary"] = event.get("summary", "")
            shadow_log["action"] = "LOG_ONLY"
            self._log_shadow(shadow_log)
        else:
            shadow_log["action"] = "UNKNOWN_EVENT"
            self._log_shadow(shadow_log)

    def _handle_gmail(self, event: dict, shadow_log: dict):
        emails = event.get("emails", [])
        if not emails:
            return

        # Triage via Gemini
        classifications = triage_engine.triage_emails(emails, self.config)
        class_map = {c["id"]: c for c in classifications}

        for email in emails:
            c = class_map.get(email["id"], {"action": "NOTIFY", "urgency": "MEDIUM", "summary": email.get("subject", "")})
            action = c.get("action", "NOTIFY")

            # Enforce external_comms policy
            if action == "RESPOND":
                sender_email = self._extract_email(email.get("from", ""))
                if not self._can_send_direct(sender_email):
                    action = "DRAFT"
                    c["action"] = "DRAFT"
                    c["reason"] = "external_blocked"

            log_entry = {
                **shadow_log,
                "from": email.get("from", ""),
                "subject": email.get("subject", ""),
                "triage_result": action,
                "triage_reason": c.get("summary", ""),
                "urgency": c.get("urgency", "MEDIUM"),
            }

            if SHADOW_MODE:
                log_entry["simulated_action"] = self._describe_action(action, c, email)
                self._log_shadow(log_entry)
            else:
                self._execute_gmail_action(action, c, email)
                log_entry["executed"] = True
                self._log_shadow(log_entry)

            # Mark as processed
            self._add_processed_id("gmail", email["id"])

    def _handle_chat(self, event: dict, shadow_log: dict):
        messages = event.get("messages", [])
        if not messages:
            return

        classifications = triage_engine.triage_chat(messages, self.config)
        class_map = {c["id"]: c for c in classifications}

        for msg in messages:
            c = class_map.get(msg["id"], {"action": "IGNORE"})
            action = c.get("action", "IGNORE")

            log_entry = {
                **shadow_log,
                "space": msg.get("space_name", ""),
                "sender": msg.get("sender_name", ""),
                "text": msg.get("text", "")[:100],
                "triage_result": action,
            }

            if SHADOW_MODE:
                if action == "RESPOND":
                    log_entry["simulated_action"] = f"send_chat_reply('{c.get('reply', '')[:60]}...')"
                else:
                    log_entry["simulated_action"] = action
                self._log_shadow(log_entry)
            else:
                if action == "RESPOND" and c.get("reply"):
                    self._send_chat_reply(msg["space_id"], c["reply"])
                elif action == "ESCALATE":
                    self._escalate(msg, c)
                log_entry["executed"] = True
                self._log_shadow(log_entry)

            self._add_processed_id("chat", msg["id"])

    # ---------- Action execution ----------

    def _execute_gmail_action(self, action: str, classification: dict, email: dict):
        if action == "IGNORE":
            self._mark_gmail_read(email["id"])
        elif action == "RESPOND":
            reply = classification.get("suggested_reply", "")
            if reply:
                self._send_gmail_reply(email["id"], reply)
        elif action == "DRAFT":
            reply = classification.get("suggested_reply", "")
            if reply:
                self._create_gmail_draft(email, reply)
            # Notify via IPC
            self._write_ipc("DRAFT", [{**email, **classification}])
        elif action == "ESCALATE":
            self._escalate(email, classification)
        # NOTIFY: write IPC
        elif action == "NOTIFY":
            self._write_ipc("NOTIFY", [{**email, **classification}])

    def _mark_gmail_read(self, msg_id: str):
        try:
            self._gws(["gmail", "users", "messages", "modify", "--params",
                        json.dumps({"userId": "me", "id": msg_id}),
                        "--json", json.dumps({"removeLabelIds": ["UNREAD"]})])
        except Exception:
            pass

    def _send_gmail_reply(self, msg_id: str, text: str):
        # TODO: implement via gws gmail +reply
        logger.info(f"Agent {self.name}: would reply to {msg_id}: {text[:60]}...")

    def _create_gmail_draft(self, email: dict, text: str):
        # TODO: implement via gws gmail drafts create
        logger.info(f"Agent {self.name}: would draft reply to {email.get('from')}: {text[:60]}...")

    def _send_chat_reply(self, space_id: str, text: str):
        try:
            self._gws(["chat", "+send", "--space", space_id, "--text", text])
            logger.info(f"Agent {self.name}: replied in {space_id}")
        except Exception as e:
            logger.error(f"Agent {self.name}: chat reply failed: {e}")

    def _escalate(self, item: dict, classification: dict):
        """Write escalation IPC file for NanoClaw to pick up and spawn Claude container."""
        self._write_ipc("ESCALATE", [{**item, **classification}])
        logger.info(f"Agent {self.name}: escalated to Claude")

    # ---------- Helpers ----------

    def _gws(self, args: list) -> dict:
        env = os.environ.copy()
        env["GOOGLE_WORKSPACE_CLI_CONFIG_DIR"] = self.gws_config_dir
        r = subprocess.run(["gws"] + args, capture_output=True, text=True, env=env, timeout=30)
        if r.returncode != 0:
            raise RuntimeError(r.stderr.strip()[:200])
        try:
            return json.loads(r.stdout)
        except json.JSONDecodeError:
            return {}

    def _extract_email(self, from_field: str) -> str:
        if "<" in from_field and ">" in from_field:
            return from_field.split("<")[1].split(">")[0].lower()
        return from_field.strip().lower()

    def _can_send_direct(self, email: str) -> bool:
        if any(email.endswith(d) for d in self.internal_domains):
            return True
        if self.ext_mode == "autonomous":
            return True
        if self.ext_mode == "supervised":
            return any(email == w or (w.endswith("*") and email.endswith(w[:-1])) for w in self.whitelist)
        return False

    def _describe_action(self, action: str, c: dict, email: dict) -> str:
        if action == "IGNORE":
            return f"mark_as_read({email['id']})"
        elif action == "RESPOND":
            return f"send_reply(to={email.get('from')}, text='{c.get('suggested_reply', '')[:60]}...')"
        elif action == "DRAFT":
            return f"create_draft(to={email.get('from')}, text='{c.get('suggested_reply', '')[:60]}...')"
        elif action == "ESCALATE":
            return f"escalate_to_claude(subject='{email.get('subject', '')}')"
        return f"notify('{c.get('summary', '')[:60]}')"

    def _write_ipc(self, action: str, items: list):
        ipc_dir = os.path.join(os.path.dirname(__file__), "data", "ipc")
        os.makedirs(ipc_dir, exist_ok=True)
        outfile = os.path.join(ipc_dir, f"{self.name}-{action.lower()}.json")
        with open(outfile, "w") as f:
            json.dump({"agent": self.name, "action": action,
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                        "items": items}, f, indent=2, ensure_ascii=False)

    def _add_processed_id(self, channel: str, msg_id: str):
        state_file = os.path.join(self._state_dir, f"{channel}.json")
        state = {}
        try:
            with open(state_file) as f:
                state = json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        ids = state.get("processed_ids", [])
        if msg_id not in ids:
            ids.append(msg_id)
        state["processed_ids"] = ids[-500:]
        state["last_updated"] = datetime.now(timezone.utc).isoformat()
        with open(state_file, "w") as f:
            json.dump(state, f, indent=2)

    def _is_processed(self, channel: str, msg_id: str) -> bool:
        state_file = os.path.join(self._state_dir, f"{channel}.json")
        try:
            with open(state_file) as f:
                return msg_id in json.load(f).get("processed_ids", [])
        except (FileNotFoundError, json.JSONDecodeError):
            return False

    def _log_shadow(self, entry: dict):
        os.makedirs(LOG_DIR, exist_ok=True)
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        logfile = os.path.join(LOG_DIR, f"shadow_{today}.jsonl")
        with open(logfile, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
