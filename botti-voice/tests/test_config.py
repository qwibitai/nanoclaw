"""Tests for web.config module."""
import os
import tempfile
from unittest.mock import patch

import pytest

from web.config import load_agent_memory, VOICE_PREAMBLE, WORKSPACE_FUNCTIONS


class TestLoadAgentMemory:
    """Tests for load_agent_memory."""

    def test_file_exists_returns_content(self):
        """When memory file exists, returns its content."""
        with tempfile.NamedTemporaryFile(mode="w", suffix=".md", delete=False) as f:
            f.write("# Agent Memory\nSome instructions here.")
            f.flush()
            tmp_path = f.name

        try:
            with patch.dict("web.config.NANOCLAW_MEMORY_PATHS", {"test_agent": tmp_path}):
                result = load_agent_memory("test_agent")
            assert result is not None
            assert "Agent Memory" in result
            assert "Some instructions here." in result
        finally:
            os.unlink(tmp_path)

    def test_file_missing_returns_none(self):
        """When memory file does not exist, returns None."""
        with patch.dict("web.config.NANOCLAW_MEMORY_PATHS", {"test_agent": "/nonexistent/path/CLAUDE.md"}):
            result = load_agent_memory("test_agent")
        assert result is None

    def test_unknown_agent_returns_none(self):
        """Agent not in NANOCLAW_MEMORY_PATHS returns None."""
        result = load_agent_memory("nonexistent_agent")
        assert result is None


class TestVoicePreamble:
    """Tests for VOICE_PREAMBLE content."""

    def test_contains_tutoiement_rule(self):
        """VOICE_PREAMBLE must contain the tutoiement instruction."""
        assert "Tutoie toujours" in VOICE_PREAMBLE
        assert "Jamais de vouvoiement" in VOICE_PREAMBLE

    def test_vocal_mode_declared(self):
        """VOICE_PREAMBLE declares vocal mode."""
        assert "mode vocal" in VOICE_PREAMBLE


class TestWorkspaceFunctions:
    """Tests for WORKSPACE_FUNCTIONS declarations."""

    def test_has_correct_function_names(self):
        """WORKSPACE_FUNCTIONS has all expected function declarations."""
        names = {f.name for f in WORKSPACE_FUNCTIONS}
        expected = {"search_emails", "read_email", "list_calendar_events",
                    "create_calendar_event", "search_drive", "send_email"}
        assert names == expected

    def test_search_emails_has_query_param(self):
        """search_emails function requires a query parameter."""
        func = next(f for f in WORKSPACE_FUNCTIONS if f.name == "search_emails")
        assert "query" in func.parameters.required
