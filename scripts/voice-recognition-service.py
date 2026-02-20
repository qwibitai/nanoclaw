#!/usr/bin/env python3
"""
Voice Recognition Service — stdin/stdout JSON daemon.

Loads PyAnnote embedding model once at startup, then reads JSON commands
from stdin (one per line) and writes JSON responses to stdout.

Commands:
  {"cmd": "extract", "audio_path": "/path/to/file.ogg"}
    → {"embedding": [0.1, 0.2, ...]}

  {"cmd": "health"}
    → {"status": "ok", "model": "pyannote/embedding"}
"""

import sys
import json
import os

import numpy as np

try:
    from pyannote.audio import Inference, Model
    import torch
except ImportError:
    # Write error and exit — TypeScript side will see the process die
    sys.stderr.write("pyannote.audio or torch not installed\n")
    sys.exit(1)


def load_model():
    """Load PyAnnote embedding model. Requires HF_TOKEN env var."""
    hf_token = os.environ.get("HF_TOKEN")
    if not hf_token:
        sys.stderr.write("HF_TOKEN environment variable not set\n")
        sys.exit(1)

    # Load model with HF token, then wrap in Inference
    pretrained = Model.from_pretrained(
        "pyannote/embedding",
        use_auth_token=hf_token,
    )
    model = Inference(pretrained, window="whole")
    return model


def extract_embedding(model, audio_path: str) -> list[float]:
    """Extract normalized speaker embedding from audio file."""
    embedding = model(audio_path)
    embedding_np = np.array(embedding)
    normalized = embedding_np / np.linalg.norm(embedding_np)
    return normalized.tolist()


def handle_command(model, cmd: dict) -> dict:
    """Process a single command and return response dict."""
    command = cmd.get("cmd")

    if command == "health":
        return {"status": "ok", "model": "pyannote/embedding"}

    if command == "extract":
        audio_path = cmd.get("audio_path")
        if not audio_path:
            return {"error": "missing audio_path"}
        if not os.path.isfile(audio_path):
            return {"error": f"file not found: {audio_path}"}
        embedding = extract_embedding(model, audio_path)
        return {"embedding": embedding}

    return {"error": f"unknown command: {command}"}


def main():
    # Load model once at startup
    sys.stderr.write("Loading PyAnnote embedding model...\n")
    model = load_model()
    sys.stderr.write("Model loaded. Ready for commands.\n")

    # Signal readiness on stdout
    sys.stdout.write(json.dumps({"status": "ready"}) + "\n")
    sys.stdout.flush()

    # Read commands from stdin, one JSON object per line
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            response = {"error": f"invalid JSON: {e}"}
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
            continue

        try:
            response = handle_command(model, cmd)
        except Exception as e:
            response = {"error": str(e)}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
