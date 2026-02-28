#!/usr/bin/env python3
"""
Jarvis - Voice-activated AI assistant

Uses Whisper for both wake word detection AND speech-to-text
More accurate than keyword spotting models

Usage:
    python3 jarvis.py
"""

import os
import sys
import time
import queue
import threading
import logging
import subprocess
import tempfile
import wave
import numpy as np
import sounddevice as sd
import requests
from faster_whisper import WhisperModel
from typing import Optional

# Reduce Whisper logging
import logging as pylogging
pylogging.getLogger("faster_whisper").setLevel(pylogging.WARNING)

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


class Config:
    nanoclaw_url: str = "http://localhost:3100"
    sample_rate: int = 16000
    whisper_model: str = "tiny"
    wake_word: str = "jarvis"
    silence_threshold: float = 0.015
    silence_duration_ms: int = 500
    max_recording_time: int = 30
    wake_check_interval: float = 1.5  # Check for wake word every 1.5s
    feedback_hint_delay: float = 2.0
    feedback_thinking_delay: float = 4.0


class NanoClawClient:
    def __init__(self, config: Config):
        self.config = config
        self.session: Optional[str] = None

    def send_message(self, text: str) -> dict:
        url = f"{self.config.nanoclaw_url}/api/chat"
        try:
            response = requests.post(
                url,
                json={"text": text, "session": self.session, "stream": False},
                timeout=60
            )
            response.raise_for_status()
            data = response.json()
            self.session = data.get("session", self.session)
            return data
        except Exception as e:
            logger.error(f"API error: {e}")
            return {"error": str(e)}


class TTSEngine:
    def __init__(self):
        self._lock = threading.Lock()

    def speak(self, text: str) -> bool:
        with self._lock:
            try:
                subprocess.run(['say', '-v', 'Daniel', text], capture_output=True, timeout=60)
                return True
            except:
                return False

    def speak_async(self, text: str):
        threading.Thread(target=self.speak, args=(text,), daemon=True).start()


class SoundEffects:
    @staticmethod
    def play_activation():
        subprocess.run(['afplay', '/System/Library/Sounds/Glass.aiff'], capture_output=True, timeout=1)

    @staticmethod
    def play_deactivation():
        subprocess.run(['afplay', '/System/Library/Sounds/Purr.aiff'], capture_output=True, timeout=1)


class VoiceAssistant:
    STATE_IDLE = "idle"
    STATE_LISTENING = "listening"
    STATE_PROCESSING = "processing"
    STATE_SPEAKING = "speaking"

    def __init__(self, config: Config):
        self.config = config
        self.client = NanoClawClient(config)
        self.tts = TTSEngine()

        logger.info("Loading Whisper...")
        self.whisper = WhisperModel(config.whisper_model, device="cpu", compute_type="int8")

        self._state_lock = threading.Lock()
        self._state = self.STATE_IDLE
        self.audio_buffer = []
        self.wake_buffer = []  # Buffer for wake word detection
        self.silence_start: Optional[float] = None
        self.recording_start_time: Optional[float] = None
        self._audio_queue = queue.Queue()
        self._stop_event = threading.Event()
        self._feedback_timer = None
        self._last_wake_check = time.time()

        logger.info("Starting audio...")
        self.stream = sd.InputStream(
            samplerate=config.sample_rate,
            channels=1,
            dtype='float32',
            blocksize=1280,
            callback=self._audio_callback
        )
        self.stream.start()
        logger.info(f"Ready! Say '{config.wake_word}' to activate")

    def _audio_callback(self, indata, frames, time_info, status):
        try:
            self._audio_queue.put(indata.flatten().copy(), timeout=1.0)
        except queue.Full:
            pass

    def _get_state(self):
        with self._state_lock:
            return self._state

    def _set_state(self, new_state):
        with self._state_lock:
            if self._state != new_state:
                logger.info(f"→ {new_state}")
                self._state = new_state

    def start(self):
        self._stop_event.clear()
        self._set_state(self.STATE_IDLE)
        self.tts.speak_async("Ready")

        try:
            while not self._stop_event.is_set():
                try:
                    audio_chunk = self._audio_queue.get(timeout=0.1)
                    energy = np.sqrt(np.mean(audio_chunk ** 2))
                    state = self._get_state()

                    if state == self.STATE_IDLE:
                        # Accumulate audio for wake word detection
                        self.wake_buffer.append(audio_chunk)

                        # Check for wake word periodically
                        now = time.time()
                        if now - self._last_wake_check > self.config.wake_check_interval:
                            self._last_wake_check = now
                            self._check_wake_word()

                    elif state == self.STATE_LISTENING:
                        self.audio_buffer.append(audio_chunk)

                        if self.recording_start_time:
                            if time.time() - self.recording_start_time > self.config.max_recording_time:
                                self._process_recording()
                                continue

                        if energy < self.config.silence_threshold:
                            if self.silence_start is None:
                                self.silence_start = time.time()
                            elif time.time() - self.silence_start > self.config.silence_duration_ms / 1000:
                                self._process_recording()
                        else:
                            self.silence_start = None

                except queue.Empty:
                    pass

        except KeyboardInterrupt:
            pass
        finally:
            self.stop()

    def _check_wake_word(self):
        """Check if wake word is in the buffered audio"""
        if len(self.wake_buffer) < 10:  # Need at least some audio
            return

        try:
            audio_data = np.concatenate(self.wake_buffer[-100:])  # Last ~1.5s

            # Skip if too quiet
            if np.max(np.abs(audio_data)) < 0.02:
                self.wake_buffer = self.wake_buffer[-20:]  # Keep some buffer
                return

            # Save to temp file for Whisper
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                temp_wav = tmp.name

            try:
                with wave.open(temp_wav, 'w') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(self.config.sample_rate)
                    wf.writeframes((audio_data * 32767).astype(np.int16).tobytes())

                # Transcribe
                segments, _ = self.whisper.transcribe(
                    temp_wav,
                    language="en",
                    vad_filter=False,
                    without_timestamps=True
                )
                text = " ".join(s.text.strip() for s in segments).lower().strip()

                if text:
                    logger.info(f"Heard: '{text}'")

                # Check for wake word (fuzzy match)
                wake_word = self.config.wake_word.lower()
                if wake_word in text or self._fuzzy_match(text, wake_word):
                    logger.info(f"✓ Wake word detected!")
                    self._activate()
                    return

            finally:
                try:
                    os.remove(temp_wav)
                except:
                    pass

            # Keep rolling buffer
            self.wake_buffer = self.wake_buffer[-20:]

        except Exception as e:
            logger.debug(f"Wake check error: {e}")

    def _fuzzy_match(self, text: str, word: str) -> bool:
        """Check for similar-sounding words"""
        # Common Whisper misrecognitions for "jarvis"
        similar = [
            "jarvis", "javis", "jovis", "jovis", "joey", "joeys",
            "travis", "service", "charles", "jarred", "gervais",
            "java", "jive", "just", "yes"
        ]
        text_lower = text.lower()
        for sim in similar:
            if sim in text_lower:
                return True
        return False

    def _activate(self):
        self._set_state(self.STATE_LISTENING)
        self.audio_buffer = []
        self.wake_buffer = []
        self.silence_start = None
        self.recording_start_time = time.time()
        threading.Thread(target=SoundEffects.play_activation, daemon=True).start()
        self.tts.speak_async("Yes?")

    def _start_feedback(self):
        def hint():
            if self._get_state() == self.STATE_PROCESSING:
                self.tts.speak_async("Hmm")
        def think():
            if self._get_state() == self.STATE_PROCESSING:
                self.tts.speak_async("One moment")

        self._feedback_timer = threading.Timer(self.config.feedback_hint_delay, hint)
        self._feedback_timer.daemon = True
        self._feedback_timer.start()
        threading.Timer(self.config.feedback_thinking_delay, think).start()

    def _cancel_feedback(self):
        if self._feedback_timer:
            self._feedback_timer.cancel()
            self._feedback_timer = None

    def _process_recording(self):
        self._set_state(self.STATE_PROCESSING)
        self._start_feedback()

        try:
            if not self.audio_buffer:
                self._handle_error("no_audio")
                return

            audio_data = np.concatenate(self.audio_buffer)
            duration = len(audio_data) / self.config.sample_rate
            logger.info(f"Recorded {duration:.1f}s")

            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                temp_wav = tmp.name

            try:
                with wave.open(temp_wav, 'w') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(self.config.sample_rate)
                    wf.writeframes((audio_data * 32767).astype(np.int16).tobytes())

                logger.info("Transcribing...")
                segments, _ = self.whisper.transcribe(temp_wav, language="en", vad_filter=False)
                text = " ".join(s.text.strip() for s in segments).strip()

                if not text:
                    self._handle_error("no_speech")
                    return

                logger.info(f"User: '{text}'")

                logger.info("Thinking...")
                start = time.time()
                response = self.client.send_message(text)
                elapsed = time.time() - start
                logger.info(f"Response in {elapsed:.1f}s")

                self._cancel_feedback()

                if "response" in response:
                    self._speak(response['response'])
                else:
                    self._handle_error("api")

            finally:
                try:
                    os.remove(temp_wav)
                except:
                    pass

        except Exception as e:
            logger.error(f"Error: {e}")
            self._handle_error("error")
        finally:
            self.audio_buffer = []

    def _handle_error(self, error_type):
        self._cancel_feedback()
        self._speak("Say Jarvis to try again")
        SoundEffects.play_activation()

    def _speak(self, text: str):
        self._set_state(self.STATE_SPEAKING)
        logger.info(f"Jarvis: {text[:60]}...")
        self.tts.speak(text)
        self._set_state(self.STATE_IDLE)
        threading.Thread(target=SoundEffects.play_deactivation, daemon=True).start()

    def stop(self):
        self._stop_event.set()
        self._cancel_feedback()
        if self.stream:
            self.stream.close()


def main():
    config = Config()
    try:
        assistant = VoiceAssistant(config)
        assistant.start()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.error(f"Error: {e}")
        sys.exit(1)
    finally:
        if 'assistant' in locals():
            assistant.stop()


if __name__ == "__main__":
    main()
