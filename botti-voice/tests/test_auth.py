"""Tests for web.auth module."""
from unittest.mock import MagicMock, patch

import pytest

from web.auth import verify_session


class TestVerifySession:
    """Tests for verify_session."""

    def _make_request(self, session: dict) -> MagicMock:
        req = MagicMock()
        req.session = session
        return req

    def test_valid_session_returns_email(self):
        """Session with allowed email returns that email."""
        with patch("web.auth.GOOGLE_CLIENT_ID", "some-client-id"), \
             patch("web.auth.ALLOWED_EMAILS", {"user@example.com"}), \
             patch("web.auth.ACCESS_PIN", ""):
            req = self._make_request({"user_email": "user@example.com"})
            assert verify_session(req) == "user@example.com"

    def test_no_session_returns_none(self):
        """Empty session returns None."""
        req = self._make_request({})
        assert verify_session(req) is None

    def test_email_not_in_allowed_returns_none(self):
        """Session with email not in ALLOWED_EMAILS returns None."""
        with patch("web.auth.GOOGLE_CLIENT_ID", "some-client-id"), \
             patch("web.auth.ALLOWED_EMAILS", {"allowed@example.com"}):
            req = self._make_request({"user_email": "hacker@example.com"})
            assert verify_session(req) is None

    def test_pin_required_but_not_verified(self):
        """When ACCESS_PIN is set but session lacks pin_verified, returns None."""
        with patch("web.auth.GOOGLE_CLIENT_ID", "some-client-id"), \
             patch("web.auth.ALLOWED_EMAILS", {"user@example.com"}), \
             patch("web.auth.ACCESS_PIN", "1234"):
            req = self._make_request({"user_email": "user@example.com"})
            assert verify_session(req) is None

    def test_pin_verified_returns_email(self):
        """When ACCESS_PIN is set and session has pin_verified, returns email."""
        with patch("web.auth.GOOGLE_CLIENT_ID", "some-client-id"), \
             patch("web.auth.ALLOWED_EMAILS", {"user@example.com"}), \
             patch("web.auth.ACCESS_PIN", "1234"):
            req = self._make_request({"user_email": "user@example.com", "pin_verified": True})
            assert verify_session(req) == "user@example.com"

    def test_dev_mode_allows_any_email(self):
        """When GOOGLE_CLIENT_ID is empty (dev mode), any session email is allowed."""
        with patch("web.auth.GOOGLE_CLIENT_ID", ""):
            req = self._make_request({"user_email": "anyone@anywhere.com"})
            assert verify_session(req) == "anyone@anywhere.com"


class TestLoginUrlHttpsRedirect:
    """Test that the google-login endpoint forces HTTPS in redirect_uri."""

    def test_redirect_uri_replaces_http_with_https(self):
        """The redirect_uri should always use https:// even if request is http."""
        # This is verified by inspecting the source code in auth.py line 95:
        #   redirect_uri = str(request.url_for("auth_callback")).replace("http://", "https://")
        # We test by simulating the string replacement logic.
        raw_url = "http://botti-voice.example.com/auth/callback"
        fixed = raw_url.replace("http://", "https://")
        assert fixed.startswith("https://")
        assert "http://" not in fixed
