#!/usr/bin/env python3
"""browser-agent: AI-driven browser automation for NanoClaw containers.

Uses browser-use library with pure CDP (Chrome DevTools Protocol) to drive
Chromium autonomously. The LLM sees page state and decides actions.

Commands:
    run           Execute a browser task using AI
    screenshot    Take a screenshot of the current page
    export-storage Export browser cookies/localStorage
    get-credential Fetch a credential from 1Password via IPC
"""

import asyncio
import json
import os
import sys
import time

import click

STORAGE_STATE_PATH = "/workspace/browser-state/storage.json"
IPC_TASKS_DIR = "/workspace/ipc/tasks"
IPC_OP_RESULTS_DIR = "/workspace/ipc/op_results"


@click.group()
def cli():
    """AI-driven browser automation for NanoClaw containers."""
    pass


@cli.command()
@click.argument("task")
@click.option("--storage-state", default=None, help="Path to storage state JSON file")
@click.option(
    "--sensitive-data", default=None, help="Path to JSON file with sensitive data"
)
@click.option(
    "--allowed-domains", default=None, help="Comma-separated list of allowed domains"
)
@click.option("--max-steps", default=50, type=int, help="Maximum browser action steps")
@click.option(
    "--model",
    default=None,
    help="LLM model override (e.g. claude-opus-4.6-1m for complex tasks)",
)
@click.option(
    "--use-vision/--no-vision",
    default=True,
    help="Send screenshots to LLM (disable for sensitive pages)",
)
def run(task, storage_state, sensitive_data, allowed_domains, max_steps, model, use_vision):
    """Execute a browser task using AI.

    The browser agent autonomously navigates, clicks, types, and extracts data
    based on your task description. Be specific about what you want.

    Examples:
        browser-agent run "Go to https://example.com and get the page title"
        browser-agent run --model claude-opus-4.6-1m "Complex multi-step task"
        browser-agent run --no-vision "Login to sensitive site"
    """
    asyncio.run(
        _run(task, storage_state, sensitive_data, allowed_domains, max_steps, model, use_vision)
    )


async def _run(
    task,
    storage_state_path,
    sensitive_data_path,
    allowed_domains_str,
    max_steps,
    model_override,
    use_vision,
):
    from browser_use import Agent, Browser
    from langchain_openai import ChatOpenAI

    browser_kwargs = {
        "headless": True,
        "executable_path": os.environ.get(
            "BROWSER_EXECUTABLE_PATH", "/usr/bin/chromium"
        ),
        "chromium_sandbox": False,
        "args": ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    }

    # Auto-load global storage state if available
    state_path = storage_state_path or (
        STORAGE_STATE_PATH if os.path.exists(STORAGE_STATE_PATH) else None
    )
    if state_path:
        browser_kwargs["storage_state"] = state_path

    if allowed_domains_str:
        browser_kwargs["allowed_domains"] = [
            d.strip() for d in allowed_domains_str.split(",")
        ]

    browser = Browser(**browser_kwargs)

    # LiteLLM provides OpenAI-compatible API for all models including Claude
    llm = ChatOpenAI(
        model=model_override
        or os.environ.get("BROWSER_LLM_MODEL", "claude-sonnet-4.6"),
        api_key=os.environ.get("BROWSER_LLM_API_KEY", "sk-local"),
        base_url=os.environ.get(
            "BROWSER_LLM_BASE_URL", "http://host.docker.internal:4000/v1"
        ),
    )

    sensitive = {}
    if sensitive_data_path and os.path.exists(sensitive_data_path):
        with open(sensitive_data_path) as f:
            sensitive = json.load(f)

    agent = Agent(
        task=task,
        browser=browser,
        llm=llm,
        sensitive_data=sensitive or None,
        max_steps=max_steps,
        use_vision=use_vision,
    )

    try:
        result = await agent.run()
        final = (
            result.final_result() if hasattr(result, "final_result") else str(result)
        )
        is_error = result.is_error() if hasattr(result, "is_error") else False
        output = {"success": not is_error, "result": final}
    except Exception as e:
        output = {"success": False, "result": None, "error": str(e)}
    finally:
        await browser.close()

    print(json.dumps(output))


@cli.command()
@click.argument("path", default="/tmp/screenshot.png")
def screenshot(path):
    """Take a quick screenshot of a URL.

    Opens a browser, navigates to the URL, takes a screenshot, and exits.
    Useful for quick visual checks.

    Example:
        browser-agent screenshot /tmp/page.png
    """
    asyncio.run(_screenshot(path))


async def _screenshot(output_path):
    from browser_use import Browser

    browser = Browser(
        headless=True,
        executable_path=os.environ.get("BROWSER_EXECUTABLE_PATH", "/usr/bin/chromium"),
        chromium_sandbox=False,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )

    state_path = (
        STORAGE_STATE_PATH if os.path.exists(STORAGE_STATE_PATH) else None
    )
    if state_path:
        browser = Browser(
            headless=True,
            executable_path=os.environ.get(
                "BROWSER_EXECUTABLE_PATH", "/usr/bin/chromium"
            ),
            chromium_sandbox=False,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            storage_state=state_path,
        )

    try:
        await browser.start()
        page = await browser.get_current_page()
        await page.screenshot(path=output_path, full_page=True)
        print(json.dumps({"success": True, "path": output_path}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
    finally:
        await browser.close()


@cli.command("export-storage")
@click.argument("path", default=STORAGE_STATE_PATH)
def export_storage(path):
    """Export current browser storage state to a JSON file.

    Saves cookies and localStorage from the current browser session.
    The file can be loaded later to restore authenticated sessions.

    Example:
        browser-agent export-storage /workspace/browser-state/storage.json
    """
    asyncio.run(_export_storage(path))


async def _export_storage(output_path):
    from browser_use import Browser

    browser = Browser(
        headless=True,
        executable_path=os.environ.get("BROWSER_EXECUTABLE_PATH", "/usr/bin/chromium"),
        chromium_sandbox=False,
        args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    )

    try:
        await browser.start()
        await browser.export_storage_state(output_path)
        print(json.dumps({"success": True, "path": output_path}))
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
    finally:
        await browser.close()


@cli.command("get-credential")
@click.argument("item_name")
@click.option("--field", default=None, help="Specific field to retrieve")
@click.option("--otp", is_flag=True, help="Get TOTP code instead of item fields")
def get_credential(item_name, field, otp):
    """Fetch a credential from 1Password via IPC (main group only).

    Sends a request to the host process which queries 1Password CLI.
    Only the Dev vault is accessible.

    Examples:
        browser-agent get-credential "GitHub" --field password
        browser-agent get-credential "Google" --otp
        browser-agent get-credential "AWS"
    """
    result = _get_credential_sync(item_name, field, otp)
    print(json.dumps(result))


def _get_credential_sync(item_name, field=None, otp=False):
    """Write IPC request to tasks dir, poll op_results dir for response."""
    request_id = f"{int(time.time() * 1000)}-{os.getpid()}"
    request = {
        "type": "op_get_otp" if otp else "op_get_item",
        "requestId": request_id,
        "itemName": item_name,
    }
    if field:
        request["field"] = field

    # Write IPC request (atomic rename to prevent partial reads)
    os.makedirs(IPC_TASKS_DIR, exist_ok=True)
    filename = f"{request_id}.json"
    tmp_path = os.path.join(IPC_TASKS_DIR, f"{filename}.tmp")
    final_path = os.path.join(IPC_TASKS_DIR, filename)
    with open(tmp_path, "w") as f:
        json.dump(request, f)
    os.rename(tmp_path, final_path)

    # Poll for result
    result_path = os.path.join(IPC_OP_RESULTS_DIR, f"{request_id}.json")
    for _ in range(60):  # 60s timeout
        if os.path.exists(result_path):
            try:
                with open(result_path) as f:
                    result = json.load(f)
                os.unlink(result_path)
                return result
            except (json.JSONDecodeError, OSError) as e:
                return {"success": False, "message": f"Failed to read result: {e}"}
        time.sleep(1)

    return {"success": False, "message": "Timeout waiting for 1Password result (60s)"}


if __name__ == "__main__":
    cli()
