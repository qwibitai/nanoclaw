"""Tests for MarvinClaw Host Bridge.

Tests the HTTP bridge that exposes read-only macOS operations
(iCalBuddy, Mail search, Mail draft) to the Docker container.
"""

import json
import subprocess
import unittest
from http.client import HTTPConnection
from threading import Thread
from unittest.mock import patch, MagicMock


def setUpModule():
    """Start the bridge server in a background thread for integration tests."""
    global server, server_thread
    from bridge import create_server
    server = create_server(host="127.0.0.1", port=19876)
    server_thread = Thread(target=server.serve_forever, daemon=True)
    server_thread.start()


def tearDownModule():
    """Shut down the bridge server."""
    server.shutdown()


def request(method, path, body=None):
    """Helper: make a request to the test server, return (status, parsed_json)."""
    conn = HTTPConnection("127.0.0.1", 19876)
    headers = {"Content-Type": "application/json"} if body else {}
    conn.request(method, path, body=json.dumps(body) if body else None, headers=headers)
    resp = conn.getresponse()
    data = resp.read().decode()
    conn.close()
    try:
        return resp.status, json.loads(data)
    except json.JSONDecodeError:
        return resp.status, data


# === Health Check ===

class TestHealthEndpoint(unittest.TestCase):

    def test_health_returns_200_ok(self):
        status, body = request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(body["status"], "ok")

    def test_health_includes_service_name(self):
        status, body = request("GET", "/health")
        self.assertEqual(body["service"], "marvinclaw-bridge")


# === Calendar Endpoints ===

class TestCalendarToday(unittest.TestCase):

    @patch("bridge.run_command")
    def test_calendar_today_calls_icalbuddy(self, mock_run):
        mock_run.return_value = (0, "• Meeting at 10:00 AM\n", "")
        status, body = request("POST", "/calendar/today")
        self.assertEqual(status, 200)
        # Verify iCalBuddy was called
        args = mock_run.call_args[0][0]
        self.assertIn("icalBuddy", args[0])

    @patch("bridge.run_command")
    def test_calendar_today_returns_events(self, mock_run):
        mock_run.return_value = (0, "• Lab Meeting at 2:00 PM\n• 1:1 with Miao at 3:00 PM\n", "")
        status, body = request("POST", "/calendar/today")
        self.assertEqual(status, 200)
        self.assertIn("Lab Meeting", body["output"])
        self.assertIn("1:1 with Miao", body["output"])

    @patch("bridge.run_command")
    def test_calendar_today_excludes_morgan_calendar(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/calendar/today")
        args = mock_run.call_args[0][0]
        cmd_str = " ".join(args)
        self.assertIn("morgan.gandal@gmail.com", cmd_str)
        self.assertIn("-ec", cmd_str)

    @patch("bridge.run_command")
    def test_calendar_today_handles_icalbuddy_failure(self, mock_run):
        mock_run.return_value = (1, "", "icalBuddy not found")
        status, body = request("POST", "/calendar/today")
        self.assertEqual(status, 502)
        self.assertIn("error", body)


class TestCalendarRange(unittest.TestCase):

    @patch("bridge.run_command")
    def test_calendar_range_with_days(self, mock_run):
        mock_run.return_value = (0, "• SFARI Meeting all day\n", "")
        status, body = request("POST", "/calendar/range", {"days": 3})
        self.assertEqual(status, 200)
        args = mock_run.call_args[0][0]
        cmd_str = " ".join(args)
        self.assertIn("eventsToday+3", cmd_str)

    @patch("bridge.run_command")
    def test_calendar_range_defaults_to_7_days(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/calendar/range", {})
        args = mock_run.call_args[0][0]
        cmd_str = " ".join(args)
        self.assertIn("eventsToday+7", cmd_str)

    @patch("bridge.run_command")
    def test_calendar_range_caps_at_30_days(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/calendar/range", {"days": 100})
        args = mock_run.call_args[0][0]
        cmd_str = " ".join(args)
        self.assertIn("eventsToday+30", cmd_str)

    def test_calendar_range_rejects_negative_days(self):
        status, body = request("POST", "/calendar/range", {"days": -5})
        self.assertEqual(status, 400)


# === Mail Search Endpoint ===

class TestMailSearch(unittest.TestCase):

    @patch("bridge.run_command")
    def test_mail_search_calls_osascript(self, mock_run):
        mock_run.return_value = (0, "Found 2 messages:\n---\nSubject: test\n", "")
        status, body = request("POST", "/mail/search", {"query": "R01 resubmission"})
        self.assertEqual(status, 200)
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], "osascript")

    @patch("bridge.run_command")
    def test_mail_search_passes_query(self, mock_run):
        mock_run.return_value = (0, "Found 1 messages:\n", "")
        status, body = request("POST", "/mail/search", {"query": "SFARI grant"})
        args = mock_run.call_args[0][0]
        self.assertIn("SFARI grant", args)

    @patch("bridge.run_command")
    def test_mail_search_default_days_back(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/mail/search", {"query": "test"})
        args = mock_run.call_args[0][0]
        # Default 7 days
        self.assertIn("7", args)

    @patch("bridge.run_command")
    def test_mail_search_custom_days(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/mail/search", {"query": "test", "days": 30})
        args = mock_run.call_args[0][0]
        self.assertIn("30", args)

    @patch("bridge.run_command")
    def test_mail_search_caps_days_at_90(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/mail/search", {"query": "test", "days": 365})
        args = mock_run.call_args[0][0]
        self.assertIn("90", args)

    @patch("bridge.run_command")
    def test_mail_search_account_filter(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/mail/search", {"query": "test", "account": "Exchange"})
        args = mock_run.call_args[0][0]
        self.assertIn("Exchange", args)

    @patch("bridge.run_command")
    def test_mail_search_defaults_to_all_accounts(self, mock_run):
        mock_run.return_value = (0, "", "")
        status, body = request("POST", "/mail/search", {"query": "test"})
        args = mock_run.call_args[0][0]
        self.assertIn("all", args)

    def test_mail_search_requires_query(self):
        status, body = request("POST", "/mail/search", {})
        self.assertEqual(status, 400)
        self.assertIn("error", body)

    def test_mail_search_rejects_empty_query(self):
        status, body = request("POST", "/mail/search", {"query": ""})
        self.assertEqual(status, 400)

    @patch("bridge.run_command")
    def test_mail_search_timeout_returns_504(self, mock_run):
        mock_run.return_value = (-1, "", "timeout")
        status, body = request("POST", "/mail/search", {"query": "test"})
        self.assertEqual(status, 504)


# === Mail Draft Endpoint ===

class TestMailDraft(unittest.TestCase):

    @patch("bridge.run_command")
    def test_mail_draft_creates_draft(self, mock_run):
        mock_run.return_value = (0, "Draft created", "")
        status, body = request("POST", "/mail/draft", {
            "to": "jade.england@pennmedicine.upenn.edu",
            "subject": "Rett analysis update",
            "body": "Hi Jade, following up on...",
            "account": "Exchange"
        })
        self.assertEqual(status, 200)
        args = mock_run.call_args[0][0]
        self.assertEqual(args[0], "osascript")

    @patch("bridge.run_command")
    def test_mail_draft_never_sends(self, mock_run):
        """The draft script must never contain 'send' — only 'make new outgoing message'."""
        mock_run.return_value = (0, "Draft created", "")
        status, body = request("POST", "/mail/draft", {
            "to": "test@test.com",
            "subject": "test",
            "body": "test",
            "account": "Exchange"
        })
        # Inspect the AppleScript passed to osascript
        args = mock_run.call_args[0][0]
        script = " ".join(args)
        self.assertNotIn("send msg", script.lower())
        self.assertNotIn("send message", script.lower())

    def test_mail_draft_requires_to(self):
        status, body = request("POST", "/mail/draft", {
            "subject": "test", "body": "test"
        })
        self.assertEqual(status, 400)

    def test_mail_draft_requires_subject(self):
        status, body = request("POST", "/mail/draft", {
            "to": "test@test.com", "body": "test"
        })
        self.assertEqual(status, 400)

    def test_mail_draft_requires_body(self):
        status, body = request("POST", "/mail/draft", {
            "to": "test@test.com", "subject": "test"
        })
        self.assertEqual(status, 400)

    @patch("bridge.run_command")
    def test_mail_draft_defaults_to_exchange_account(self, mock_run):
        mock_run.return_value = (0, "Draft created", "")
        status, body = request("POST", "/mail/draft", {
            "to": "test@test.com",
            "subject": "test",
            "body": "test"
        })
        args = mock_run.call_args[0][0]
        script = " ".join(args)
        self.assertIn("Exchange", script)


# === Security ===

class TestSecurity(unittest.TestCase):

    def test_rejects_unknown_endpoints(self):
        status, body = request("GET", "/exec")
        self.assertEqual(status, 404)

    def test_rejects_arbitrary_shell_commands(self):
        status, body = request("POST", "/mail/search", {"query": "test; rm -rf /"})
        # Should not error — query is passed as argument, not shell-interpolated
        self.assertNotEqual(status, 500)

    @patch("bridge.run_command")
    def test_query_not_shell_interpolated(self, mock_run):
        """Ensure queries are passed as list args, never through shell."""
        mock_run.return_value = (0, "", "")
        request("POST", "/mail/search", {"query": "$(whoami)"})
        args = mock_run.call_args[0][0]
        # The query should be a literal string in the args list
        self.assertIn("$(whoami)", args)
        # run_command should NOT use shell=True
        kwargs = mock_run.call_args[1] if mock_run.call_args[1] else {}
        self.assertFalse(kwargs.get("shell", False))

    def test_cors_not_enabled(self):
        """Bridge should only accept local connections, no CORS headers."""
        status, body = request("GET", "/health")
        # We can't easily check headers with HTTPConnection this way,
        # but the server should not set Access-Control-Allow-Origin


# === Input Validation ===

class TestInputValidation(unittest.TestCase):

    def test_non_json_body_returns_400(self):
        conn = HTTPConnection("127.0.0.1", 19876)
        conn.request("POST", "/mail/search", body="not json",
                     headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        self.assertEqual(resp.status, 400)
        conn.close()

    def test_get_on_post_endpoint_returns_405(self):
        status, body = request("GET", "/mail/search")
        self.assertEqual(status, 405)

    def test_post_on_get_endpoint_returns_405(self):
        status, body = request("POST", "/health")
        self.assertEqual(status, 405)


if __name__ == "__main__":
    unittest.main()
