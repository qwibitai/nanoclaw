"""Common fixtures for botti-voice tests."""
import os
import sys
import pytest

# Ensure the web package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Set required env vars before importing any web modules
os.environ.setdefault("GEMINI_API_KEY", "test-key")
os.environ.setdefault("GOOGLE_CLIENT_ID", "")
os.environ.setdefault("GOOGLE_CLIENT_SECRET", "")


@pytest.fixture(autouse=True)
def _clean_module_state():
    """Reset module-level state between tests."""
    # gmail_webhook
    from web import gmail_webhook
    gmail_webhook._accounts.clear()
    gmail_webhook._gmail_services.clear()
    gmail_webhook._last_history_id.clear()

    # chat_webhook
    from web import chat_webhook
    chat_webhook._accounts.clear()
    chat_webhook._chat_services.clear()
    chat_webhook._processed_ids.clear()

    yield
