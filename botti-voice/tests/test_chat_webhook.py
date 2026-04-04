"""Tests for web.chat_webhook module."""
import base64
import json
from unittest.mock import MagicMock

import pytest

from web import chat_webhook
from web.chat_webhook import process_notification, register_account


def _encode(data: dict) -> str:
    """Base64-encode a dict as Pub/Sub would."""
    return base64.b64encode(json.dumps(data).encode()).decode()


def _make_message_event(space_id: str = "spaces/ABC123", msg_id: str = "msg1") -> str:
    """Create a well-formed Chat message-created event."""
    return _encode({
        "type": "google.workspace.chat.message.v1.created",
        "data": {
            "message": {
                "name": f"{space_id}/messages/{msg_id}"
            }
        }
    })


class TestProcessNotification:
    """Tests for process_notification."""

    def test_message_event_returns_record(self):
        """MESSAGE-created event returns a message record."""
        register_account("boty", "spaces/ABC123", "tok")

        mock_service = MagicMock()
        mock_service.spaces().messages().get().execute.return_value = {
            "text": "Hello from user",
            "sender": {"type": "HUMAN"},
            "createTime": "2026-03-31T10:00:00Z",
        }
        chat_webhook._chat_services["boty"] = mock_service

        data = _make_message_event("spaces/ABC123", "msg1")
        result = process_notification(data)

        assert result is not None
        assert result["agent_id"] == "boty"
        assert result["space_id"] == "spaces/ABC123"
        assert result["message"]["text"] == "Hello from user"
        assert result["message"]["id"] == "msg1"

    def test_non_message_event_returns_none(self):
        """Non-message event (e.g. membership change) returns None."""
        data = _encode({
            "type": "google.workspace.chat.membership.v1.created",
            "data": {}
        })
        result = process_notification(data)
        assert result is None

    def test_bot_sender_skipped(self):
        """Messages from BOT senders are skipped."""
        register_account("boty", "spaces/ABC123", "tok")

        mock_service = MagicMock()
        mock_service.spaces().messages().get().execute.return_value = {
            "text": "Bot response",
            "sender": {"type": "BOT"},
            "createTime": "2026-03-31T10:00:00Z",
        }
        chat_webhook._chat_services["boty"] = mock_service

        data = _make_message_event("spaces/ABC123", "bot_msg")
        result = process_notification(data)
        assert result is None

    def test_duplicate_message_skipped(self):
        """Same message ID processed twice -- second call returns None."""
        register_account("boty", "spaces/ABC123", "tok")

        mock_service = MagicMock()
        mock_service.spaces().messages().get().execute.return_value = {
            "text": "Hello",
            "sender": {"type": "HUMAN"},
            "createTime": "2026-03-31T10:00:00Z",
        }
        chat_webhook._chat_services["boty"] = mock_service

        data = _make_message_event("spaces/ABC123", "dup1")
        result1 = process_notification(data)
        assert result1 is not None

        result2 = process_notification(data)
        assert result2 is None


class TestRegisterAccount:
    """Tests for register_account."""

    def test_stores_space_id(self):
        """register_account stores space_id correctly."""
        register_account("boty", "spaces/XYZ", "refresh_tok", "cid", "csecret")
        assert chat_webhook._accounts["boty"]["space_id"] == "spaces/XYZ"
        assert chat_webhook._accounts["boty"]["refresh_token"] == "refresh_tok"
        assert chat_webhook._accounts["boty"]["client_id"] == "cid"
