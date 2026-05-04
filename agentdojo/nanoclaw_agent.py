"""
NanoClaw AgentDojo pipeline adapter.

Builds an AgentDojo pipeline that mirrors NanoClaw's agent configuration:
- System prompt from container/CLAUDE.md (the file modified to harden security)
- Anthropic, Google Gemini, or OpenAI LLM
- Standard tool execution loop

Usage:
    from agentdojo.nanoclaw_agent import build_pipeline
    pipeline = build_pipeline()                          # Anthropic (default)
    pipeline = build_pipeline(provider="google")         # Gemini (free tier)
    pipeline = build_pipeline(provider="openai")         # OpenAI
"""

import pathlib

from agentdojo.agent_pipeline import (
    AgentPipeline,
    InitQuery,
    SystemMessage,
    ToolsExecutionLoop,
    ToolsExecutor,
)

REPO_ROOT = pathlib.Path(__file__).parent.parent

# The file that security modifications target.
CONTAINER_CLAUDE_MD = REPO_ROOT / "container" / "CLAUDE.md"

# Simplified destinations section: replaces the runtime-generated addendum
# (which reads from the container's inbound.db) with a plain-text equivalent.
_DESTINATIONS_ADDENDUM = """\
## Sending messages

Your messages are delivered directly to the user. Just write your response \
directly — no special wrapping needed.

To mark something as scratchpad (logged but not sent), wrap it in \
`<internal>...</internal>`."""

# Default models per provider — all in AgentDojo's MODEL_NAMES allowlist.
DEFAULT_MODELS = {
    "anthropic": "claude-3-5-sonnet-20241022",
    "google": "gemini-2.0-flash-001",
    "openai": "gpt-4o-mini-2024-07-18",
}


def load_system_prompt(extra: str | None = None) -> str:
    """
    Load NanoClaw's container/CLAUDE.md and append the destinations addendum.

    Args:
        extra: Optional additional instructions to append after the base prompt.
               Use this to test the effect of proposed security additions before
               committing them to CLAUDE.md.
    """
    base = CONTAINER_CLAUDE_MD.read_text()
    parts = [base.rstrip(), "", _DESTINATIONS_ADDENDUM]
    if extra:
        parts += ["", extra.strip()]
    return "\n".join(parts)


def build_pipeline(
    provider: str = "anthropic",
    model: str | None = None,
    max_tokens: int = 4096,
    extra_system_prompt: str | None = None,
) -> AgentPipeline:
    """
    Build an AgentDojo pipeline that mirrors NanoClaw's agent configuration.

    Args:
        provider: LLM provider — "anthropic", "google", or "openai".
        model: Model ID. Defaults to a sensible cheap model per provider.
        max_tokens: Max tokens per LLM call.
        extra_system_prompt: Extra text appended to the system prompt.

    Returns:
        An AgentPipeline ready to pass to benchmark_suite_with_injections or
        benchmark_suite_without_injections.
    """
    provider = provider.lower()
    if model is None:
        model = DEFAULT_MODELS.get(provider, DEFAULT_MODELS["anthropic"])

    llm = _build_llm(provider, model, max_tokens)
    system_prompt = load_system_prompt(extra_system_prompt)

    pipeline = AgentPipeline(
        [
            SystemMessage(system_prompt),
            InitQuery(),
            llm,
            ToolsExecutionLoop([ToolsExecutor()]),
        ]
    )
    # AgentDojo's attack constructors call get_model_name_from_pipeline(),
    # which requires pipeline.name to contain a known model string.
    pipeline.name = model
    return pipeline


def _build_llm(provider: str, model: str, max_tokens: int):
    if provider == "anthropic":
        import anthropic
        from agentdojo.agent_pipeline import AnthropicLLM
        client = anthropic.Anthropic()
        return AnthropicLLM(client=client, model=model, max_tokens=max_tokens)

    if provider == "google":
        import google.genai as genai
        from agentdojo.agent_pipeline import GoogleLLM
        client = genai.Client()
        return GoogleLLM(model=model, client=client, max_tokens=max_tokens)

    if provider == "openai":
        import openai
        from agentdojo.agent_pipeline import OpenAILLM
        client = openai.OpenAI()
        return OpenAILLM(client=client, model=model, max_tokens=max_tokens)

    raise ValueError(f"Unknown provider '{provider}'. Choose: anthropic, google, openai")
