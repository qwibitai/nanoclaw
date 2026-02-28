#!/usr/bin/env python3
"""
Jarvis - Voice-activated AI assistant
Simple, working version using Whisper for wake word detection
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
import fcntl
import numpy as np
import sounddevice as sd
import requests
from faster_whisper import WhisperModel
from typing import Optional

# Singleton lock file
_LOCK_FILE = None

# Reduce logging noise
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
    whisper_model: str = "small"  # Upgrade to small for better accuracy (was base)
    silence_threshold: float = 0.015
    silence_duration_ms: int = 500  # Faster silence detection (was 800ms)
    max_recording_time: int = 10    # Shorter max recording (was 30s)
    wake_check_interval: float = 1.0
    # Speaker verification
    speaker_verification: bool = False  # Disable for now
    speaker_threshold: float = 0.50
    enrollment_dir: str = os.path.expanduser("~/.jarvis")
    # Barge-in
    barge_in_enabled: bool = True
    barge_in_threshold: float = 0.98
    barge_in_energy_threshold: float = 0.1


class NanoClawClient:
    def __init__(self, config: Config):
        self.config = config
        self.session: Optional[str] = None

    def send_message(self, text: str, reset_session: bool = False) -> dict:
        url = f"{self.config.nanoclaw_url}/api/chat"
        if reset_session:
            self.session = None
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

    def reset(self):
        self.session = None


class BargeInDetector:
    def __init__(self, config: Config):
        self.config = config
        self.vad_model = None
        self._loaded = False
        self._speech_count = 0
        self._required_chunks = 5

    def load(self):
        try:
            import torch
            logger.info("Loading VAD...")
            self.vad_model, _ = torch.hub.load(
                repo_or_dir='snakers4/silero-vad',
                model='silero_vad',
                trust_repo=True
            )
            self._loaded = True
            return True
        except Exception as e:
            logger.warning(f"VAD unavailable: {e}")
            return False

    def reset(self):
        self._speech_count = 0

    def is_speech(self, audio_chunk: np.ndarray) -> bool:
        if not self._loaded:
            return False
        try:
            import torch
            energy = np.sqrt(np.mean(audio_chunk ** 2))
            if energy < self.config.barge_in_energy_threshold:
                self._speech_count = 0
                return False

            audio_tensor = torch.from_numpy(audio_chunk).float().unsqueeze(0)
            speech_prob = self.vad_model(audio_tensor, self.config.sample_rate).item()

            if speech_prob > self.config.barge_in_threshold:
                self._speech_count += 1
                if self._speech_count >= self._required_chunks:
                    self._speech_count = 0
                    return True
            else:
                self._speech_count = 0
            return False
        except:
            return False


class TTSEngine:
    def __init__(self, config: Config, barge_in: BargeInDetector):
        self.config = config
        self.barge_in = barge_in
        self._lock = threading.Lock()
        self._tts_process = None
        self._stop_flag = False

    def speak(self, text: str) -> bool:
        with self._lock:
            self._stop_flag = False
            if len(text) > 300:
                text = text[:300].rsplit('.', 1)[0] + '.'
            self._tts_process = subprocess.Popen(
                ['say', '-v', 'Daniel', text],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )

        if self.config.barge_in_enabled and self.barge_in._loaded:
            threading.Thread(target=self._monitor_barge_in, daemon=True).start()

        try:
            self._tts_process.wait()
        except:
            pass
        return not self._stop_flag

    def _monitor_barge_in(self):
        if self._tts_process is None:
            return
        chunk_size = 768

        def callback(indata, frames, time, status):
            if self._stop_flag or self._tts_process.poll() is not None:
                return
            audio = indata.flatten().astype(np.float32) / 32768.0
            if self.barge_in.is_speech(audio):
                logger.info("Interrupted!")
                self._stop_flag = True
                try:
                    self._tts_process.kill()
                except:
                    pass

        try:
            with sd.InputStream(samplerate=self.config.sample_rate, channels=1,
                               dtype='int16', blocksize=chunk_size, callback=callback):
                while self._tts_process.poll() is None and not self._stop_flag:
                    sd.sleep(100)
        except:
            pass

    def stop(self):
        self._stop_flag = True
        if self._tts_process:
            try:
                self._tts_process.kill()
            except:
                pass

    def speak_async(self, text: str):
        threading.Thread(target=self.speak, args=(text,), daemon=True).start()


class VoiceAssistant:
    STATE_IDLE = "idle"
    STATE_LISTENING = "listening"
    STATE_PROCESSING = "processing"
    STATE_SPEAKING = "speaking"

    def __init__(self, config: Config):
        self.config = config
        self.client = NanoClawClient(config)

        self.barge_in = BargeInDetector(config)
        self.barge_in.load()
        self.tts = TTSEngine(config, self.barge_in)

        logger.info(f"Loading Whisper ({config.whisper_model} model)...")
        self.whisper = WhisperModel(config.whisper_model, device="cpu", compute_type="int8")

        self._state_lock = threading.Lock()
        self._state = self.STATE_IDLE
        self.audio_buffer = []
        self.wake_buffer = []
        self.silence_start: Optional[float] = None
        self.recording_start_time: Optional[float] = None
        self._audio_queue = queue.Queue()
        self._stop_event = threading.Event()
        self._last_wake_check = time.time()
        self._last_activation = 0

        logger.info("Starting audio...")
        self.stream = sd.InputStream(
            samplerate=config.sample_rate,
            channels=1,
            dtype='float32',
            blocksize=1280,
            callback=self._audio_callback
        )
        self.stream.start()

        logger.info("Ready! Say 'JARVIS' to activate.")

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
                logger.info(f"-> {new_state}")
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
                        self.wake_buffer.append(audio_chunk)
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
        if len(self.wake_buffer) < 15:
            return

        try:
            audio_data = np.concatenate(self.wake_buffer[-150:])

            if np.max(np.abs(audio_data)) < 0.03:
                self.wake_buffer = self.wake_buffer[-30:]
                return

            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
                temp_wav = tmp.name

            try:
                with wave.open(temp_wav, 'w') as wf:
                    wf.setnchannels(1)
                    wf.setsampwidth(2)
                    wf.setframerate(self.config.sample_rate)
                    wf.writeframes((audio_data * 32767).astype(np.int16).tobytes())

                segments, _ = self.whisper.transcribe(
                    temp_wav, language="en", vad_filter=True, without_timestamps=True
                )
                text = " ".join(s.text.strip() for s in segments).lower().strip()

                if text:
                    logger.info(f"Heard: '{text}'")

                # Check for jarvis with very loose matching
                if self._is_wake_word(text):
                    logger.info("WAKE WORD DETECTED!")
                    # Extract command from the same audio (user said "jarvis <command>")
                    command = self._extract_command(text)
                    if command:
                        # Process command directly without recording
                        self._process_text_command(command)
                    else:
                        # No command in same breath, listen for more
                        self._activate()
                    return

            finally:
                try:
                    os.remove(temp_wav)
                except:
                    pass

            self.wake_buffer = self.wake_buffer[-30:]

        except Exception as e:
            logger.debug(f"Wake check error: {e}")

    def _is_wake_word(self, text: str) -> bool:
        """Wake word detection - match 'jarvis' and common mishearings"""
        if not text:
            return False

        text = text.lower().strip()
        text_words = text.split()

        # Match "jarvis" and common Whisper mishearings
        wake_words = ["jarvis", "javis", "jovis", "jarv", "jarvis,", "javi", "javish", "javies"]

        for word in text_words:
            # Exact match
            if word in wake_words:
                return True
            # Partial match (whisper might add punctuation)
            if any(wake in word for wake in ["jarvis", "javis", "javish"]):
                return True

        return False

    def _activate(self):
        now = time.time()
        if now - self._last_activation < 2.0:
            return
        self._last_activation = now

        self._set_state(self.STATE_LISTENING)
        # Start fresh - user speaks AFTER wake word
        self.audio_buffer = []
        self.wake_buffer = []
        self.silence_start = None
        self.recording_start_time = time.time()
        # No TTS - it gets picked up by mic and transcribed
        logger.info("Listening...")

    def _extract_command(self, text: str) -> str:
        """Extract command after wake word from transcribed text."""
        text = text.lower().strip()

        # Only extract if text STARTS with wake word (user addressing jarvis directly)
        for wake in ["jarvis,", "jarvis", "javis,", "javis", "jovis,", "jovis", "jarv,", "jarv", "javi,", "javi", "javish,", "javish"]:
            if text.startswith(wake + " ") or text.startswith(wake + ","):
                command = text[len(wake):].strip().lstrip(",")
                if command and len(command) > 3:
                    # Filter out false positives (common words that aren't commands)
                    false_positives = ["followed", "try", "say", "now"]
                    if command.split()[0] not in false_positives:
                        logger.info(f"Command from wake audio: '{command}'")
                        return command
        return ""

    def _process_text_command(self, text: str):
        """Process a command directly without recording."""
        self._set_state(self.STATE_PROCESSING)

        try:
            logger.info(f"User: '{text}'")
            logger.info("Thinking...")
            start = time.time()
            response = self.client.send_message(text)
            elapsed = time.time() - start
            logger.info(f"Response in {elapsed:.1f}s")

            if "response" in response:
                self._speak(response['response'])
            else:
                self._handle_error()

        except Exception as e:
            logger.error(f"Error: {e}")
            self._handle_error()

    def _process_recording(self):
        self._set_state(self.STATE_PROCESSING)

        try:
            if not self.audio_buffer:
                self._handle_error()
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
                segments, _ = self.whisper.transcribe(temp_wav, language="en", vad_filter=True)
                text = " ".join(s.text.strip() for s in segments).strip()

                if not text:
                    self._handle_error()
                    return

                logger.info(f"User: '{text}'")

                logger.info("Thinking...")
                start = time.time()
                response = self.client.send_message(text)
                elapsed = time.time() - start
                logger.info(f"Response in {elapsed:.1f}s")

                if "response" in response:
                    self._speak(response['response'])
                else:
                    self._handle_error()

            finally:
                try:
                    os.remove(temp_wav)
                except:
                    pass

        except Exception as e:
            logger.error(f"Error: {e}")
            self._handle_error()
        finally:
            self.audio_buffer = []

    def _handle_error(self):
        self._speak("Try again")

    def _speak(self, text: str):
        self._set_state(self.STATE_SPEAKING)
        # Truncate at sentence boundary
        if len(text) > 200:
            # Find last sentence ending
            for end in ['. ', '! ', '? ']:
                idx = text.rfind(end, 0, 200)
                if idx > 0:
                    text = text[:idx+1]
                    break
            else:
                text = text[:200].rsplit(' ', 1)[0] + '.'
        logger.info(f"Jarvis: {text[:60]}...")
        self.tts.speak(text)
        # Cooldown - don't trigger on our own TTS
        time.sleep(1.0)
        self._last_activation = time.time()
        self._set_state(self.STATE_IDLE)
        self.client.reset()

    def stop(self):
        self._stop_event.set()
        self.tts.stop()
        if self.stream:
            self.stream.close()


def acquire_singleton_lock():
    """Ensure only one instance of Jarvis runs at a time."""
    global _LOCK_FILE
    lock_path = os.path.join(tempfile.gettempdir(), 'jarvis.lock')
    try:
        _LOCK_FILE = open(lock_path, 'w')
        fcntl.flock(_LOCK_FILE.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _LOCK_FILE.write(f"{os.getpid()}\n")
        _LOCK_FILE.flush()
        return True
    except (IOError, OSError):
        logger.error("Jarvis is already running! (check /tmp/jarvis.lock)")
        return False


def release_singleton_lock():
    """Release the singleton lock on exit."""
    global _LOCK_FILE
    if _LOCK_FILE:
        try:
            fcntl.flock(_LOCK_FILE.fileno(), fcntl.LOCK_UN)
            _LOCK_FILE.close()
            os.remove(_LOCK_FILE.name)
        except:
            pass
        _LOCK_FILE = None


def main():
    if not acquire_singleton_lock():
        sys.exit(1)

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
        release_singleton_lock()


if __name__ == "__main__":
    main()
