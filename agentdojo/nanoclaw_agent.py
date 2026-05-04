"""
NanoClaw AgentDojo pipeline adapter.

Builds an AgentDojo pipeline that mirrors NanoClaw's agent configuration:
- System prompt from container/CLAUDE.md (the file modified to harden security)
- Anthropic LLM (same model the container agent-runner uses)
- Standard tool execution loop

Usage:
    from agentdojo.nanoclaw_agent import build_pipeline
    pipeline = build_pipeline()
"""

import pathlib

import anthropic
from agentdojo.agent_pipeline import (
    AgentPipeline,
    AnthropicLLM,
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
    model: str = "claude-3-5-sonnet-20241022",
    max_tokens: int = 4096,
    extra_system_prompt: str | None = None,
) -> AgentPipeline:
    """
    Build an AgentDojo pipeline that mirrors NanoClaw's agent configuration.

    Args:
        model: Claude model ID to use.
        max_tokens: Max tokens per LLM call.
        extra_system_prompt: Extra text appended to the system prompt. Useful
            for testing proposed hardening instructions before committing them.

    Returns:
        An AgentPipeline ready to pass to benchmark_suite_with_injections or
        benchmark_suite_without_injections.
    """
    system_prompt = load_system_prompt(extra_system_prompt)
    client = anthropic.Anthropic()
    llm = AnthropicLLM(client=client, model=model, max_tokens=max_tokens)

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
