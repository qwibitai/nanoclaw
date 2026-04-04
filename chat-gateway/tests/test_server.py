"""Tests for chat-gateway server."""
import os
import sys
from unittest.mock import MagicMock, patch, PropertyMock

import pytest
from fastapi.testclient import TestClient

# Must mock firestore and google.auth before importing server
_mock_firestore_module = MagicMock()
_mock_db = MagicMock()
_mock_firestore_module.Client.return_value = _mock_db

sys.modules.setdefault("google.cloud", MagicMock())
sys.modules.setdefault("google.cloud.firestore", _mock_firestore_module)
sys.modules.setdefault("google.auth", MagicMock())

# Now we can import server; patch db at module level
with patch.dict(os.environ, {"ADMIN_API_KEY": "test-admin-key", "CHAT_VERIFICATION_TOKEN": ""}):
    import server as srv
    srv.db = _mock_db

# Reset the load function to not call real Firestore
_mock_db.collection.return_value.document.return_value.get.return_value = MagicMock(
    exists=False, to_dict=lambda: {}
)


@pytest.fixture
def client():
    """TestClient for the FastAPI app."""
    # Reset state
    srv._space_agent_map.clear()
    srv._yacine_cache.clear()
    srv._map_loaded_at = 0
    # Prevent startup from calling Firestore
    srv._map_loaded_at = 9999999999
    return TestClient(srv.app, raise_server_exceptions=False)


class TestPostChat:
    """Tests for POST /chat."""

    def test_message_event_writes_to_firestore(self, client):
        """MESSAGE event with text writes to Firestore and returns 200."""
        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/ABC", "type": "ROOM", "displayName": "Test Room"},
            "message": {
                "name": "spaces/ABC/messages/msg1",
                "text": "Hello Botti",
                "argumentText": "Hello Botti",
                "sender": {"type": "HUMAN", "displayName": "Yacine", "email": "yacine@bestoftours.co.uk"},
                "createTime": "2026-03-31T10:00:00Z",
            },
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        # Verify Firestore write
        _mock_db.collection.assert_called_with("chat-queue")

    def test_added_to_space_returns_welcome(self, client):
        """ADDED_TO_SPACE returns a welcome text message."""
        body = {
            "type": "ADDED_TO_SPACE",
            "space": {"name": "spaces/NEW", "displayName": "My Space"},
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        data = resp.json()
        assert "text" in data
        assert "My Space" in data["text"]

    def test_removed_from_space_returns_empty(self, client):
        """REMOVED_FROM_SPACE returns empty dict."""
        body = {
            "type": "REMOVED_FROM_SPACE",
            "space": {"name": "spaces/OLD"},
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        assert resp.json() == {}

    def test_bot_sender_skipped(self, client):
        """MESSAGE from BOT sender returns empty (skipped)."""
        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/ABC"},
            "message": {
                "name": "spaces/ABC/messages/bot1",
                "text": "I am a bot",
                "sender": {"type": "BOT", "displayName": "SomeBot"},
                "createTime": "2026-03-31T10:00:00Z",
            },
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        assert resp.json() == {}

    def test_at_sam_routing(self, client):
        """Message starting with @Sam routes to sam agent."""
        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/ABC", "type": "ROOM"},
            "message": {
                "name": "spaces/ABC/messages/msg2",
                "text": "@sam check flights",
                "argumentText": "@sam check flights",
                "sender": {"type": "HUMAN", "displayName": "Yacine", "email": "y@b.co.uk"},
                "createTime": "2026-03-31T10:00:00Z",
            },
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        # The last call to Firestore should route to sam
        # Check the document path: collection("chat-queue").document("sam")
        calls = _mock_db.collection("chat-queue").document.call_args_list
        # At least one call should have "sam"
        agent_args = [c[0][0] for c in calls if c[0]]
        assert "sam" in agent_args


class TestAgentEndpoint:
    """Tests for POST /{agent_name}."""

    def test_valid_agent_returns_200(self, client):
        """POST to a valid agent name returns 200."""
        body = {
            "type": "MESSAGE",
            "space": {"name": "spaces/DEF"},
            "message": {
                "name": "spaces/DEF/messages/m1",
                "text": "hi",
                "sender": {"type": "HUMAN", "displayName": "User"},
                "createTime": "2026-03-31T10:00:00Z",
            },
        }
        resp = client.post("/sam", json=body)
        assert resp.status_code == 200

    def test_invalid_agent_returns_404(self, client):
        """POST to an unknown agent name returns 404."""
        body = {"type": "MESSAGE", "message": {"text": "hi"}}
        resp = client.post("/nobody", json=body)
        assert resp.status_code == 404


class TestAdminMapSpace:
    """Tests for POST /admin/map-space."""

    def test_no_api_key_configured_returns_503(self, client):
        """When ADMIN_API_KEY is empty, returns 503."""
        original = srv.ADMIN_API_KEY
        srv.ADMIN_API_KEY = ""
        try:
            resp = client.post("/admin/map-space", json={"space": "spaces/X", "agent": "sam"})
            assert resp.status_code == 503
        finally:
            srv.ADMIN_API_KEY = original

    def test_wrong_key_returns_403(self, client):
        """Wrong API key returns 403."""
        resp = client.post(
            "/admin/map-space",
            json={"space": "spaces/X", "agent": "sam"},
            headers={"Authorization": "Bearer wrong-key"},
        )
        assert resp.status_code == 403

    def test_correct_key_maps_space(self, client):
        """Correct API key + valid data maps the space."""
        resp = client.post(
            "/admin/map-space",
            json={"space": "spaces/X", "agent": "sam"},
            headers={"Authorization": f"Bearer {srv.ADMIN_API_KEY}"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["agent"] == "sam"
        assert data["space"] == "spaces/X"


class TestSpaceMappingAutoRegistration:
    """Tests for auto-registration on ADDED_TO_SPACE."""

    def test_added_to_space_registers_mapping(self, client):
        """ADDED_TO_SPACE auto-registers space in _space_agent_map."""
        body = {
            "type": "ADDED_TO_SPACE",
            "space": {"name": "spaces/AUTO", "displayName": "Auto Space"},
        }
        resp = client.post("/chat", json=body)
        assert resp.status_code == 200
        assert "spaces/AUTO" in srv._space_agent_map


class TestHealth:
    """Tests for GET /health."""

    def test_health_returns_200(self, client):
        """GET /health returns 200 with status ok."""
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}
