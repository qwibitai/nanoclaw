#!/usr/bin/env python3
"""
Jarvis - Simple voice assistant using sound energy detection
(Alternative version when wake word detection doesn't work well)

Usage:
    python3 jarvis_simple.py    # Start with clapping to activate
"""

import os
import sys
import time
import queue
import threading
import logging
import numpy as np
import sounddevice as sd
import requests

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s'
)
logger = logging.getLogger(__name__)


class Config:
    """Configuration"""
    nanoclaw_url: str = "http://localhost:3100"
    sample_rate: int = 16000
    # Sound energy threshold for activation
    energy_threshold: float = 0.15
    # Silence detection
    silence_threshold: float = 0.02
    silence_duration_ms: int = 1000
    # Max recording time
    max_recording_time: int = 30


class NanoClawClient:
    """Client for NanoClaw HTTP API"""

    def __init__(self, config: Config):
        self.config = config
        self.session = None

    def send_message(self, text: str) -> dict:
        """Send message to NanoClaw API."""
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
            logger.error(f"NanoClaw API error: {e}")
            return {"error": str(e)}


class VoiceAssistant:
    """Voice assistant with sound energy activation"""

    def __init__(self, config: Config):
        self.config = config
        self.client = NanoClawClient(config)

        self.sample_rate = config.sample_rate
        self.is_recording = False
        self.is_speaking = False
        self.audio_buffer = []
        self.silence_start = None
        self._audio_queue = queue.Queue()
        self._stop_event = threading.Event()
        self.recording_start_time = None

        # Start audio stream
        logger.info("Starting audio stream...")
        self.stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype='int16',
            blocksize=1280,
            callback=self._audio_callback
        )
        self.stream.start()
        logger.info("Jarvis is ready!")
        logger.info("Make a LOUD sound (clap) to activate, then speak your command")
        logger.info("Or press Ctrl+C to stop")

    def _audio_callback(self, indata, frames, time_info, status):
        """Process incoming audio."""
        if status:
            logger.warning(f"Audio status: {status}")
        try:
            data = indata.flatten().astype(np.float32) / 32768.0
            self._audio_queue.put(data)
        except Exception as e:
            logger.error(f"Audio error: {e}")

    def start(self):
        """Start the assistant."""
        self._stop_event.clear()
        logger.info("Listening... (clap loudly to activate)")

        import threading
        threading.Thread(target=self._speak_welcome, daemon=True).start()

        try:
            while not self._stop_event.is_set():
                try:
                    audio_chunk = self._audio_queue.get(timeout=0.1)

                    # Calculate audio energy
                    energy = np.sqrt(np.mean(audio_chunk ** 2))

                    # Activation by loud sound (clap)
                    if not self.is_recording and not self.is_speaking:
                        if energy > self.config.energy_threshold:
                            logger.info(f"Sound detected! Energy: {energy:.3f}")
                            self._activate()

                    # Recording logic
                    elif self.is_recording:
                        self.audio_buffer.append(audio_chunk)

                        # Check for max recording time
                        if self.recording_start_time:
                            elapsed = time.time() - self.recording_start_time
                            if elapsed > self.config.max_recording_time:
                                logger.info("Max recording time reached")
                                self._process_recording()
                                continue

                        # Check for silence
                        if energy < self.config.silence_threshold:
                            if self.silence_start is None:
                                self.silence_start = time.time()
                            elif time.time() - self.silence_start > self.config.silence_duration_ms / 1000:
                                logger.info("Silence detected, processing...")
                                self._process_recording()
                        else:
                            self.silence_start = None

                    # Speaking detection (barge-in)
                    elif self.is_speaking:
                        if energy > self.config.energy_threshold:
                            logger.info("Barge-in detected!")
                            self._stop_speaking()

                except queue.Empty:
                    time.sleep(0)

        except KeyboardInterrupt:
            logger.info("Stopping...")
            self.stop()

    def _speak_welcome(self):
        """Speak welcome message."""
        time.sleep(1)
        os.system("say -v 'Daniel' 'Jarvis ready. Clap to activate.'")

    def _activate(self):
        """Activate after loud sound detected."""
        logger.info("Listening for command...")
        os.system("say -v 'Daniel' 'Yes?'")
        self.is_recording = True
        self.audio_buffer = []
        self.silence_start = None
        self.recording_start_time = time.time()

    def _process_recording(self):
        """Process recorded audio."""
        self.is_recording = False
        logger.info("Processing recording...")

        if len(self.audio_buffer) == 0:
            logger.warning("No audio recorded")
            return

        audio_data = np.concatenate(self.audio_buffer)
        duration = len(audio_data) / self.sample_rate
        logger.info(f"Recorded {duration:.2f} seconds")

        # Placeholder - would need Whisper for actual STT
        # For now, use a default command
        simulated_text = "What time is it?"
        logger.info(f"Simulated transcription: '{simulated_text}'")
        logger.info("(Note: Install faster-whisper for actual speech-to-text)")

        # Send to NanoClaw
        response = self.client.send_message(simulated_text)
        if "response" in response:
            logger.info(f"Response: {response['response'][:100]}...")
            self._speak(response['response'])
        elif "error" in response:
            logger.error(f"NanoClaw error: {response['error']}")
            self._speak("Sorry, I couldn't reach the server.")
        else:
            logger.error("No response from NanoClaw")

        # Reset for next activation
        self.audio_buffer = []

    def _speak(self, text: str):
        """Speak response using macOS TTS."""
        self.is_speaking = True
        logger.info(f"Speaking: {text[:100]}...")

        # Escape quotes for shell command
        escaped_text = text.replace("'", "'\"'\"'")
        os.system(f"say -v 'Daniel' '{escaped_text}'")

        # Approximate duration based on text length
        time.sleep(len(text) * 0.05)
        self._stop_speaking()

    def _stop_speaking(self):
        """Stop speaking."""
        self.is_speaking = False

    def stop(self):
        """Stop the assistant."""
        self._stop_event.set()
        if self.stream:
            self.stream.close()
        logger.info("Jarvis stopped")


def main():
    """Main entry point."""
    config = Config()
    assistant = VoiceAssistant(config)
    try:
        assistant.start()
    except KeyboardInterrupt:
        pass
    finally:
        assistant.stop()


if __name__ == "__main__":
    main()
