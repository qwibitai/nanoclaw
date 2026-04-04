"""Common fixtures for chat-gateway tests."""
import os
import sys
import pytest
from unittest.mock import MagicMock, patch

# Ensure server module is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set env vars before importing server
os.environ.setdefault("CHAT_VERIFICATION_TOKEN", "")
os.environ.setdefault("ADMIN_API_KEY", "test-admin-key")


@pytest.fixture(autouse=True)
def _reset_server_state():
    """Reset module-level state between tests."""
    import server as srv
    srv._space_agent_map.clear()
    srv._yacine_cache.clear()
    srv._map_loaded_at = 0
    yield
