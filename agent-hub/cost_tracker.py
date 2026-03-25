"""
cost_tracker.py — Unified cost tracking for Anthropic + Vertex AI.
Single JSON file, per-agent and per-provider breakdown.
Hard limit enforcement with WhatsApp alert.
"""
import json
import os
import threading
from datetime import datetime, timezone

COST_FILE = os.environ.get("COST_FILE", os.path.join(os.path.dirname(__file__), "data", "costs.json"))
HARD_LIMIT = float(os.environ.get("COST_HARD_LIMIT_USD", "20.0"))

# Approximate costs per 1M tokens/chars
PRICING = {
    "anthropic": {
        "claude-opus-4-6":   {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0},
        "default":           {"input": 3.0,  "output": 15.0},
    },
    "gemini": {
        "gemini-2.5-flash":  {"input": 0.15, "output": 0.60},
        "default":           {"input": 0.15, "output": 0.60},
    },
}

_lock = threading.Lock()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _load() -> dict:
    today = _today()
    try:
        with open(COST_FILE) as f:
            data = json.load(f)
            if data.get("date") == today:
                return data
    except (FileNotFoundError, json.JSONDecodeError):
        pass
    return {
        "date": today,
        "hard_limit_usd": HARD_LIMIT,
        "total_usd": 0.0,
        "limit_hit": False,
        "by_agent": {},
        "by_provider": {},
    }


def _save(data: dict):
    os.makedirs(os.path.dirname(COST_FILE), exist_ok=True)
    with open(COST_FILE, "w") as f:
        json.dump(data, f, indent=2)


def track(agent_id: str, provider: str, model: str,
          input_tokens: int, output_tokens: int) -> dict:
    """Track an LLM call. Returns current daily spend."""
    pricing = PRICING.get(provider, {}).get(model, PRICING.get(provider, {}).get("default", {"input": 3.0, "output": 15.0}))
    cost = (input_tokens / 1_000_000) * pricing["input"] + (output_tokens / 1_000_000) * pricing["output"]

    with _lock:
        data = _load()

        # Per-agent
        if agent_id not in data["by_agent"]:
            data["by_agent"][agent_id] = {
                "anthropic_input_tokens": 0, "anthropic_output_tokens": 0,
                "gemini_input_tokens": 0, "gemini_output_tokens": 0,
                "usd": 0.0, "calls": 0,
            }
        agent = data["by_agent"][agent_id]
        if provider == "anthropic":
            agent["anthropic_input_tokens"] += input_tokens
            agent["anthropic_output_tokens"] += output_tokens
        else:
            agent["gemini_input_tokens"] += input_tokens
            agent["gemini_output_tokens"] += output_tokens
        agent["usd"] += cost
        agent["calls"] += 1

        # Per-provider
        if provider not in data["by_provider"]:
            data["by_provider"][provider] = {"usd": 0.0, "calls": 0}
        data["by_provider"][provider]["usd"] += cost
        data["by_provider"][provider]["calls"] += 1

        # Total
        data["total_usd"] += cost

        # Hard limit check
        if data["total_usd"] >= HARD_LIMIT and not data["limit_hit"]:
            data["limit_hit"] = True

        _save(data)
        return data


def is_limit_hit() -> bool:
    with _lock:
        return _load().get("limit_hit", False)


def get_summary() -> dict:
    with _lock:
        return _load()
