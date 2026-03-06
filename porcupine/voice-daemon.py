#!/usr/bin/env python3
"""
NanoClaw Voice Daemon
Listens for "Hey Gimme" wake word via Porcupine.
First detection = start recording, second = stop recording + transcribe + inject into NanoClaw.
"""

import io
import os
import sqlite3
import struct
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

import pvporcupine
from pvrecorder import PvRecorder

# --- Config ---
PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
KEYWORD_PATH = str(Path(__file__).resolve().parent / "Hey-Gimme_en_mac_v4_0_0.ppn")
DB_PATH = str(PROJECT_ROOT / "store" / "messages.db")
CHAT_JID = "tg:8253215818"  # Telegram main chat
SOUND_START = "/System/Library/Sounds/Purr.aiff"
SOUND_STOP = "/System/Library/Sounds/Pop.aiff"
PLAYBACK_PID_FILE = os.path.join(tempfile.gettempdir(), "nanoclaw-playback.pid")


def load_env():
    """Load .env file into a dict."""
    env = {}
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def play_sound(path):
    """Play a sound file asynchronously."""
    subprocess.Popen(["afplay", path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def is_audio_playing():
    """Check if NanoClaw is currently playing audio via ffplay."""
    try:
        with open(PLAYBACK_PID_FILE) as f:
            pid = int(f.read().strip())
        os.kill(pid, 0)  # check if process exists
        return pid
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return None


def stop_audio_playback():
    """Kill the running ffplay process."""
    pid = is_audio_playing()
    if pid:
        try:
            os.kill(pid, 15)  # SIGTERM
            print(f"  Audio playback interrupted (pid {pid})")
        except ProcessLookupError:
            pass
        try:
            os.unlink(PLAYBACK_PID_FILE)
        except FileNotFoundError:
            pass
        return True
    return False


def transcribe(audio_bytes, openai_key):
    """Transcribe audio via OpenAI Whisper API."""
    from openai import OpenAI

    client = OpenAI(api_key=openai_key)
    audio_file = io.BytesIO(audio_bytes)
    audio_file.name = "voice.wav"
    transcript = client.audio.transcriptions.create(
        file=audio_file,
        model="whisper-1",
        response_format="text",
    )
    return transcript.strip()


def inject_message(text, chat_jid):
    """Insert a message into NanoClaw's SQLite DB."""
    db = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    msg_id = f"voice-{int(time.time() * 1000)}"
    db.execute(
        "INSERT OR IGNORE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (msg_id, chat_jid, "voice-daemon", "Pavel", f"[Voice: {text}]", now, 0, 0),
    )
    db.commit()
    db.close()
    return now


def frames_to_wav(frames, sample_rate):
    """Convert raw PCM frames to WAV bytes."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(sample_rate)
        for frame in frames:
            wf.writeframes(struct.pack(f"{len(frame)}h", *frame))
    return buf.getvalue()


def main():
    env = load_env()
    access_key = env.get("PICOVOICE_ACCESS_KEY")
    openai_key = env.get("OPENAI_API_KEY")

    if not access_key:
        print("ERROR: PICOVOICE_ACCESS_KEY not found in .env")
        sys.exit(1)
    if not openai_key:
        print("ERROR: OPENAI_API_KEY not found in .env")
        sys.exit(1)

    porcupine = pvporcupine.create(
        access_key=access_key,
        keyword_paths=[KEYWORD_PATH],
        sensitivities=[0.6],
    )

    recorder = PvRecorder(
        frame_length=porcupine.frame_length,
        device_index=-1,  # default microphone
    )

    sample_rate = porcupine.sample_rate
    recording = False
    recorded_frames = []

    print(f"Voice daemon started. Say 'Hey Gimme' to start/stop recording.")
    print(f"Chat: {CHAT_JID}")
    print(f"Press Ctrl+C to quit.\n")

    recorder.start()

    try:
        while True:
            frame = recorder.read()
            keyword_index = porcupine.process(frame)

            if recording:
                recorded_frames.append(frame)

            if keyword_index >= 0:
                # If audio is playing, interrupt it instead of starting recording
                if not recording and stop_audio_playback():
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Playback interrupted")
                    continue

                if not recording:
                    # Start recording
                    recording = True
                    recorded_frames = []
                    play_sound(SOUND_START)
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Recording started...")
                else:
                    # Stop recording
                    recording = False
                    play_sound(SOUND_STOP)
                    duration = len(recorded_frames) * porcupine.frame_length / sample_rate
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Recording stopped ({duration:.1f}s)")

                    if duration < 0.5:
                        print("  Too short, skipping.")
                        continue

                    # Transcribe
                    print("  Transcribing...")
                    wav_bytes = frames_to_wav(recorded_frames, sample_rate)
                    try:
                        text = transcribe(wav_bytes, openai_key)
                    except Exception as e:
                        print(f"  Transcription failed: {e}")
                        continue

                    if not text:
                        print("  Empty transcription, skipping.")
                        continue

                    print(f"  Transcribed: {text}")

                    # Inject into NanoClaw
                    inject_message(text, CHAT_JID)
                    print(f"  Injected into NanoClaw. Waiting for response...\n")

    except KeyboardInterrupt:
        print("\nStopping...")
    finally:
        recorder.stop()
        recorder.delete()
        porcupine.delete()


if __name__ == "__main__":
    main()
