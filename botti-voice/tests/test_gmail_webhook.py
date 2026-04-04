"""Tests for web.gmail_webhook module."""
import base64
import json
import os
from unittest.mock import MagicMock, patch

import pytest

from web import gmail_webhook
from web.gmail_webhook import process_notification, register_account, setup_watch, _write_firestore_signal


def _encode(data: dict) -> str:
    """Base64-encode a dict as Pub/Sub would."""
    return base64.b64encode(json.dumps(data).encode()).decode()


class TestProcessNotification:
    """Tests for process_notification."""

    def test_valid_base64_returns_new_messages(self):
        """Valid notification with prior historyId fetches new messages."""
        register_account("botti", "yacine@bestoftours.co.uk", "tok123")
        # Seed a previous historyId so it won't be the "first notification"
        gmail_webhook._last_history_id["botti"] = "100"

        mock_service = MagicMock()
        # history().list() returns one new message
        mock_service.users().history().list().execute.return_value = {
            "history": [{
                "messagesAdded": [{
                    "message": {"id": "msg1", "labelIds": ["INBOX"]}
                }]
            }]
        }
        # messages().get() returns metadata
        mock_service.users().messages().get().execute.return_value = {
            "payload": {
                "headers": [
                    {"name": "From", "value": "alice@example.com"},
                    {"name": "Subject", "value": "Hello"},
                    {"name": "Date", "value": "Mon, 31 Mar 2026 10:00:00 +0000"},
                ]
            },
            "snippet": "Hi there",
        }
        gmail_webhook._gmail_services["botti"] = mock_service

        data = _encode({"emailAddress": "yacine@bestoftours.co.uk", "historyId": 200})
        result = process_notification(data)

        assert result is not None
        assert result["agent_id"] == "botti"
        assert result["new_count"] == 1
        assert result["messages"][0]["from"] == "alice@example.com"

    def test_empty_data_returns_none(self):
        """Non-base64 / corrupt data returns None."""
        result = process_notification("!!!not-valid-base64!!!")
        assert result is None

    def test_unknown_email_returns_none(self):
        """Notification for email not in _accounts returns None."""
        register_account("botti", "yacine@bestoftours.co.uk", "tok")
        data = _encode({"emailAddress": "unknown@example.com", "historyId": 1})
        result = process_notification(data)
        assert result is None

    def test_first_notification_stores_history_id(self):
        """First notification (no previous historyId) stores and returns None."""
        register_account("botti", "yacine@bestoftours.co.uk", "tok")
        data = _encode({"emailAddress": "yacine@bestoftours.co.uk", "historyId": 42})
        result = process_notification(data)
        assert result is None
        assert gmail_webhook._last_history_id["botti"] == "42"


class TestSetupWatch:
    """Tests for setup_watch."""

    def test_calls_gmail_api_correctly(self):
        """setup_watch calls users().watch() with correct topic and labelIds."""
        register_account("botti", "yacine@bestoftours.co.uk", "tok")
        mock_service = MagicMock()
        mock_service.users().watch().execute.return_value = {
            "historyId": "999",
            "expiration": "1234567890",
        }
        gmail_webhook._gmail_services["botti"] = mock_service

        result = setup_watch("botti")

        mock_service.users().watch.assert_called_with(
            userId="me",
            body={
                "topicName": gmail_webhook.PUBSUB_TOPIC,
                "labelIds": ["INBOX"],
            },
        )
        assert result["historyId"] == "999"
        assert gmail_webhook._last_history_id["botti"] == "999"


class TestRegisterAccount:
    """Tests for register_account."""

    def test_stores_credentials(self):
        """register_account stores email, refresh_token, client_id, client_secret."""
        register_account("sam", "sam@bestoftours.co.uk", "refresh_tok", "cid", "csecret")
        assert gmail_webhook._accounts["sam"]["email"] == "sam@bestoftours.co.uk"
        assert gmail_webhook._accounts["sam"]["refresh_token"] == "refresh_tok"
        assert gmail_webhook._accounts["sam"]["client_id"] == "cid"
        assert gmail_webhook._accounts["sam"]["client_secret"] == "csecret"


class TestFirestoreSignal:
    """Tests for Firestore signal writing."""

    def test_writes_signal_to_firestore(self):
        """_write_firestore_signal writes to the correct Firestore path."""
        mock_db = MagicMock()
        with patch.object(gmail_webhook, "_get_firestore", return_value=mock_db):
            _write_firestore_signal("botti", "yacine@bestoftours.co.uk", "200", ["msg1", "msg2"])

        mock_db.collection.assert_called_with("gmail-notify")
        mock_db.collection().document.assert_called_with("botti")
        mock_db.collection().document().collection.assert_called_with("signals")
        mock_db.collection().document().collection().add.assert_called_once()

        call_args = mock_db.collection().document().collection().add.call_args[0][0]
        assert call_args["messageIds"] == ["msg1", "msg2"]
        assert call_args["email"] == "yacine@bestoftours.co.uk"
        assert call_args["processed"] is False

    def test_no_firestore_client_is_nonfatal(self):
        """If Firestore is unavailable, _write_firestore_signal silently returns."""
        with patch.object(gmail_webhook, "_get_firestore", return_value=None):
            # Should not raise
            _write_firestore_signal("botti", "yacine@bestoftours.co.uk", "200", ["msg1"])
