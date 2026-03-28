#!/usr/bin/env python3
"""Execute a walkthrough action list with Playwright, capturing frames + metadata.

Usage:
    python execute.py --actions actions.json --output /tmp/frames
    python execute.py --actions actions.json --output /tmp/frames --width 1440 --height 900

Output:
    /tmp/frames/00001.png, 00002.png, ...
    /tmp/frames/metadata.json
"""
import argparse
import base64
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

from anthropic import Anthropic
from playwright.sync_api import sync_playwright

VIEWPORT_WIDTH = 1280
VIEWPORT_HEIGHT = 800
CURSOR_MOVE_STEPS = 8      # frames of cursor animation per action
FRAME_INTERVAL_MS = 67     # ~15fps
SETTLE_FRAMES = 5          # frames captured after each action settles
SPOTLIGHT_FRAMES = 6       # highlight frames before a click/type
RIPPLE_FRAMES = 8          # ripple frames after a click
SCENE_FRAMES = 30          # frames for a scene transition card

# Map prose key names to Playwright key names
KEY_MAP = {
    "cmd": "Meta",
    "ctrl": "Control",
    "alt": "Alt",
    "shift": "Shift",
}


def take_screenshot(page, frames_dir: Path, frame_num: int,
                    cursor: list, keys: list,
                    step_index: int, step_label: str, step_action: str,
                    metadata: list, **extra) -> int:
    """Capture one frame. Returns incremented frame_num."""
    filename = f"{frame_num:05d}.png"
    page.screenshot(path=str(frames_dir / filename))
    entry = {
        "frame": filename,
        "cursor": cursor[:],   # copy so mutations don't affect stored value
        "keys": keys[:],
        "step_index": step_index,
        "step_label": step_label,
        "step_action": step_action,
    }
    entry.update(extra)
    metadata.append(entry)
    return frame_num + 1


def get_element_center(element) -> list:
    """Return [x, y] center of element, or viewport center as fallback."""
    box = element.bounding_box()
    if box:
        return [int(box["x"] + box["width"] / 2), int(box["y"] + box["height"] / 2)]
    return [VIEWPORT_WIDTH // 2, VIEWPORT_HEIGHT // 2]


def resolve_selector_with_vision(page, hint: str, client: Anthropic) -> Optional[str]:
    """Ask Claude vision to identify a CSS/text selector for the hint."""
    screenshot_bytes = page.screenshot()
    b64 = base64.standard_b64encode(screenshot_bytes).decode()
    response = client.messages.create(
        model="claude-opus-4-6",
        max_tokens=256,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image",
                 "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                {"type": "text", "text": (
                    f'Find the element matching: "{hint}"\n'
                    "Return ONLY a Playwright selector on one line.\n"
                    'Format: SELECTOR: <selector>\n'
                    'Prefer: text="exact visible text" or role="button" name="..."'
                )},
            ],
        }],
    )
    text = response.content[0].text
    match = re.search(r"SELECTOR:\s*(.+)", text)
    return match.group(1).strip() if match else None


def find_element(page, hint: str, client: Anthropic):
    """Try text/aria strategies first, fall back to Claude vision."""
    strategies = [
        lambda: page.get_by_text(hint, exact=True),
        lambda: page.get_by_role("button", name=hint),
        lambda: page.get_by_role("link", name=hint),
        lambda: page.get_by_label(hint),
        lambda: page.get_by_placeholder(hint),
        lambda: page.locator(f"text={hint}"),
    ]
    for strategy in strategies:
        try:
            el = strategy()
            if el.count() > 0:
                return el.first
        except Exception:
            continue

    print(f"  Vision fallback for: {hint}", file=sys.stderr)
    selector = resolve_selector_with_vision(page, hint, client)
    if selector:
        try:
            loc = page.locator(selector)
            if loc.count() > 0:
                return loc.first
        except Exception:
            pass
    raise RuntimeError(f"Could not find element: {hint}")


def animate_cursor(page, frames_dir: Path, frame_num: int,
                   cursor: list, target: list,
                   step_index: int, step_label: str, metadata: list) -> tuple:
    """Interpolate cursor from current to target, capturing CURSOR_MOVE_STEPS frames."""
    for i in range(1, CURSOR_MOVE_STEPS + 1):
        t = i / CURSOR_MOVE_STEPS
        t = t * t * (3 - 2 * t)
        interp = [
            int(cursor[0] + (target[0] - cursor[0]) * t),
            int(cursor[1] + (target[1] - cursor[1]) * t),
        ]
        frame_num = take_screenshot(
            page, frames_dir, frame_num, interp, [],
            step_index, step_label, "move", metadata,
        )
    cursor[:] = target
    return frame_num, cursor


def settle(page, frames_dir: Path, frame_num: int, cursor: list, keys: list,
           step_index: int, step_label: str, action: str, metadata: list,
           delay_ms: int = 500) -> int:
    """Capture settling frames after an action completes."""
    total_frames = max(1, int(delay_ms / FRAME_INTERVAL_MS))
    for _ in range(total_frames):
        time.sleep(FRAME_INTERVAL_MS / 1000)
        frame_num = take_screenshot(
            page, frames_dir, frame_num, cursor, keys,
            step_index, step_label, action, metadata,
        )
    return frame_num


def execute_walkthrough(actions: list, frames_dir: Path, client: Anthropic,
                        width: int = VIEWPORT_WIDTH,
                        height: int = VIEWPORT_HEIGHT) -> list:
    frames_dir.mkdir(parents=True, exist_ok=True)
    metadata = []
    frame_num = 1
    cursor = [width // 2, height // 2]

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": width, "height": height})
        page.add_style_tag(content="* { cursor: none !important; }")

        for step_idx, action in enumerate(actions):
            act = action.get("action")
            label = action.get("label", "")
            delay_ms = action.get("delay_ms", 500)

            # Before frame
            frame_num = take_screenshot(
                page, frames_dir, frame_num, cursor, [],
                step_idx, label, act, metadata,
            )

            if act == "goto":
                page.goto(action["url"])
                page.wait_for_load_state("networkidle", timeout=15000)
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata, delay_ms)

            elif act == "click":
                element = find_element(page, action["hint"], client)
                target = get_element_center(element)
                frame_num, cursor = animate_cursor(
                    page, frames_dir, frame_num, cursor, target,
                    step_idx, label, metadata,
                )
                # Spotlight pulse: cursor arrived, highlight the target
                for i in range(SPOTLIGHT_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "spotlight", metadata,
                        spotlight_pos=cursor[:], spotlight_progress=(i + 1) / SPOTLIGHT_FRAMES,
                    )
                element.click()
                try:
                    page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:
                    pass
                # Click ripple animation
                for i in range(RIPPLE_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "ripple", metadata,
                        ripple_center=cursor[:], ripple_progress=(i + 1) / RIPPLE_FRAMES,
                    )
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata, delay_ms)

            elif act == "type":
                element = find_element(page, action["hint"], client)
                target = get_element_center(element)
                frame_num, cursor = animate_cursor(
                    page, frames_dir, frame_num, cursor, target,
                    step_idx, label, metadata,
                )
                # Spotlight pulse: cursor arrived, highlight the target
                for i in range(SPOTLIGHT_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "spotlight", metadata,
                        spotlight_pos=cursor[:], spotlight_progress=(i + 1) / SPOTLIGHT_FRAMES,
                    )
                element.click()
                for char in action.get("text", ""):
                    element.type(char)
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [char],
                        step_idx, label, "type", metadata,
                    )
                    time.sleep(0.05)
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata, delay_ms)

            elif act == "key":
                keys = action.get("keys", [])
                for _ in range(8):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, keys,
                        step_idx, label, "key", metadata,
                    )
                playwright_keys = [KEY_MAP.get(k, k.title()) for k in keys]
                page.keyboard.press("+".join(playwright_keys))
                try:
                    page.wait_for_load_state("networkidle", timeout=3000)
                except Exception:
                    pass
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata, delay_ms)

            elif act == "click_xy":
                target = [action["x"], action["y"]]
                frame_num, cursor = animate_cursor(
                    page, frames_dir, frame_num, cursor, target,
                    step_idx, label, metadata,
                )
                for i in range(SPOTLIGHT_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "spotlight", metadata,
                        spotlight_pos=cursor[:], spotlight_progress=(i + 1) / SPOTLIGHT_FRAMES,
                    )
                page.mouse.click(target[0], target[1])
                try:
                    page.wait_for_load_state("networkidle", timeout=5000)
                except Exception:
                    pass
                for i in range(RIPPLE_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "ripple", metadata,
                        ripple_center=cursor[:], ripple_progress=(i + 1) / RIPPLE_FRAMES,
                    )
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata, delay_ms)

            elif act == "scene":
                # Full-frame scene transition card
                for i in range(SCENE_FRAMES):
                    frame_num = take_screenshot(
                        page, frames_dir, frame_num, cursor, [],
                        step_idx, label, "scene", metadata,
                        scene_frame=i, scene_total=SCENE_FRAMES,
                    )

            elif act == "wait":
                frame_num = settle(page, frames_dir, frame_num, cursor, [],
                                   step_idx, label, act, metadata,
                                   delay_ms=action.get("delay_ms", 1000))

        browser.close()

    with open(frames_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    return metadata


def main():
    parser = argparse.ArgumentParser(description="Execute walkthrough and capture frames")
    parser.add_argument("--actions", required=True,
                        help="Path to JSON output from parse_script.py")
    parser.add_argument("--output", required=True, help="Output directory for frames")
    parser.add_argument("--width", type=int, default=VIEWPORT_WIDTH)
    parser.add_argument("--height", type=int, default=VIEWPORT_HEIGHT)
    args = parser.parse_args()

    with open(args.actions) as f:
        parsed = json.load(f)

    client = Anthropic()
    frames_dir = Path(args.output)
    metadata = execute_walkthrough(
        parsed["actions"], frames_dir, client, args.width, args.height,
    )
    print(f"Captured {len(metadata)} frames → {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
