#!/usr/bin/env python3
"""
Jarvis - Voice-activated AI assistant

Architecture:
- Wake word detection: openWakeWord ("hey jarvis")
- Transcription: Apple Speech framework (primary) with Vosk fallback
- TTS: macOS 'say' command
- Backend: NanoClaw API

State Machine:
  IDLE ---------> PING ---------> RECORDING ---------> PROCESSING
     ^              |                  |                    |
     |              v                  v                    v
     |         (barge-in)         (barge-in)           SPEAKING
     |              |                  |                    |
     +--------------<------------------<--------------------+

Audio Flow:
  Microphone -> sounddevice -> queues -> wake word listener thread
                                    -> main thread (recording/transcription)
"""

import argparse
import os
import sys
import time
import json
import logging
import subprocess
import fcntl
import requests
import queue
import threading
import signal
import atexit
from enum import Enum, auto
from typing import Optional
from dataclasses import dataclass, field

import numpy as np
import sounddevice as sd
import vosk
from openwakeword.model import Model


# =============================================================================
# Logging Configuration
# =============================================================================

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)


# =============================================================================
# State Machine
# =============================================================================

class State(Enum):
    """Assistant states for the state machine."""
    IDLE = auto()        # Waiting for wake word
    PING = auto()        # Playing ping sound
    RECORDING = auto()   # Recording user command
    PROCESSING = auto()  # Transcribing and sending to API
    SPEAKING = auto()    # Speaking response


# =============================================================================
# Validation Functions
# =============================================================================

def validate_mic(device_id: Optional[int]) -> tuple[bool, str, Optional[int]]:
    """Validate microphone device exists and can record.

    Returns:
        (is_valid, message, device_id_to_use)
    """
    try:
        devices = sd.query_devices()
        if device_id is not None:
            if device_id >= len(devices):
                return False, f"Device #{device_id} does not exist (max: {len(devices)-1})", None
            device_info = devices[device_id]
            if device_info['max_input_channels'] == 0:
                return False, f"Device #{device_id} ({device_info['name']}) has no input channels", None
            return True, f"Using device #{device_id}: {device_info['name']}", device_id
    except Exception as e:
        return False, f"Error querying devices: {e}", None

    # Try to find a suitable microphone by name
    for i, dev in enumerate(devices):
        name_lower = dev['name'].lower()
        if 'yeti' in name_lower and dev['max_input_channels'] > 0:
            return True, f"Auto-detected Yeti microphone: device #{i} ({dev['name']})", i

    # Fall back to default input device
    try:
        default_input = sd.default.device[0]
        if default_input >= 0:
            device_info = devices[default_input]
            if device_info['max_input_channels'] > 0:
                return True, f"Using default input device: #{default_input} ({device_info['name']})", default_input
    except Exception:
        pass

    return False, "No valid input microphone found", None


def validate_vosk_model(model_path: str) -> tuple[bool, str]:
    """Validate Vosk model directory exists and contains required files."""
    if not os.path.isdir(model_path):
        return False, f"Model directory does not exist: {model_path}"

    required_files = ['am/final.mdl', 'graph/HCLG.fst', 'conf/mfcc.conf']
    missing = []
    for f in required_files:
        full_path = os.path.join(model_path, f)
        if not os.path.isfile(full_path):
            missing.append(f)

    if missing:
        return False, f"Model missing required files: {', '.join(missing)}"

    return True, f"Model OK: {model_path}"


def validate_nanoclaw_api(url: str, timeout: float = 5.0) -> tuple[bool, str]:
    """Validate NanoClaw API is reachable."""
    health_url = f"{url.rstrip('/')}/api/health"

    try:
        response = requests.get(health_url, timeout=timeout)
        if response.status_code == 200:
            return True, f"API reachable: {url}"
        elif response.status_code == 404:
            # Health endpoint might not exist, try chat endpoint
            return True, f"API reachable (no health endpoint): {url}"
        else:
            return False, f"API returned status {response.status_code}"
    except requests.exceptions.Timeout:
        return False, f"API timeout after {timeout}s (is NanoClaw running?)"
    except requests.exceptions.ConnectionError:
        return False, f"Cannot connect to {url} (is NanoClaw running?)"
    except Exception as e:
        return False, f"API check failed: {e}"


def validate_all(config) -> tuple[bool, list[str]]:
    """Run all validation checks and return results."""
    results = []
    all_ok = True

    # Check microphone
    mic_ok, mic_msg, actual_device = validate_mic(config.mic_device)
    results.append(f"Microphone: {'OK' if mic_ok else 'FAIL'} - {mic_msg}")
    if not mic_ok:
        all_ok = False
    else:
        config.mic_device = actual_device

    # Check Vosk model
    vosk_ok, vosk_msg = validate_vosk_model(config.vosk_model_path)
    results.append(f"Vosk Model: {'OK' if vosk_ok else 'FAIL'} - {vosk_msg}")
    if not vosk_ok:
        all_ok = False

    # Check Apple Speech authorization
    try:
        from Speech import SFSpeechRecognizer
        auth_status = SFSpeechRecognizer.authorizationStatus()
        # Authorization status values: 0=NotDetermined, 1=Denied, 2=Restricted, 3=Authorized
        status_names = {0: 'Not Determined', 1: 'Denied', 2: 'Restricted', 3: 'Authorized'}
        if auth_status == 3:  # Authorized
            results.append("Apple Speech: OK - Authorized")
        elif auth_status == 0:  # Not Determined
            results.append("Apple Speech: OK - Will request on first use")
        else:
            results.append(f"Apple Speech: WARN - {status_names.get(auth_status, 'Unknown')} (Vosk fallback available)")
    except ImportError:
        results.append("Apple Speech: FAIL - PyObjC not installed (Vosk fallback available)")

    # Check NanoClaw API
    api_ok, api_msg = validate_nanoclaw_api(config.nanoclaw_url)
    results.append(f"NanoClaw API: {'OK' if api_ok else 'FAIL'} - {api_msg}")
    if not api_ok:
        all_ok = False

    return all_ok, results


# =============================================================================
# Configuration
# =============================================================================

@dataclass
class Config:
    """Configuration for Jarvis voice assistant.

    Microphone is auto-detected. To override:
        python3 -c "import sounddevice as sd; print(sd.query_devices())"
    """
    # API endpoint
    nanoclaw_url: str = "http://localhost:3100"

    # Audio settings
    sample_rate: int = 16000
    mic_device: Optional[int] = None  # None = auto-detect, or specify device number
    recording_duration: int = 5  # seconds
    noise_gate_threshold: int = 300  # Audio below this level is considered silence (lowered for quieter mic)

    # Transcription
    whisper_model: str = "mlx-community/whisper-large-v3-turbo"
    vosk_model_path: str = "vosk-models/vosk-model-en-us-0.22"

    # Wake word detection (openWakeWord)
    oww_threshold: float = 0.15  # Lowered from 0.3 for better activation
    oww_threshold_speaking: float = 0.55  # Higher threshold during SPEAKING to prevent TTS false triggers
    oww_vad_threshold: float = 0.5  # VAD enabled to reduce false positives

    # State watchdog
    state_timeout: float = 60.0  # Max seconds in non-IDLE state before recovery

    # Notifications
    enable_notifications: bool = True


# =============================================================================
# NanoClaw API Client
# =============================================================================

class NanoClawClient:
    """HTTP client for communicating with the NanoClaw API."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.session: Optional[str] = None

    def send_message(self, text: str) -> dict:
        """Send a message to NanoClaw and return the response."""
        url = f"{self.config.nanoclaw_url}/api/chat"
        if not text or len(text.strip()) < 2:
            return {"error": "Text too short"}
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
        except requests.RequestException as e:
            logger.error(f"API error: {e}")
            return {"error": str(e)}

    def validate_transcription(self, text: str) -> dict:
        """Send transcription to NanoClaw for validation/cleanup.

        Returns:
            {"valid": True, "text": cleaned_text} or
            {"valid": False, "reason": explanation}
        """
        if not text or len(text.strip()) < 3:
            return {"valid": False, "reason": "Too short"}

        # Strip wake word variations BEFORE validation
        # This prevents NanoClaw from responding to "hey jarvis" conversationally
        text_lower = text.lower().strip()
        wake_words = ["hey jarvis", "jarvis", "ok jarvis", "hi jarvis"]
        cleaned = text_lower

        for wake_word in wake_words:
            if cleaned.startswith(wake_word):
                cleaned = cleaned[len(wake_word):].strip()
                logger.info(f"Stripped wake word: '{wake_word}' -> '{cleaned}'")
                break

        # If after stripping wake word, text is too short, it's invalid
        if len(cleaned) < 3:
            return {"valid": False, "reason": "Only wake word detected"}

        # Simple local validation to catch common hallucinations
        # This is faster and more reliable than AI validation for obvious cases
        hallucinations = [
            "the", "a", "an", ".", ",", "?", "!", "yes", "no", "okay", "ok",
            "uh", "um", "huh", "ah", "oh", "mm", "hmm", "wow", "hey"
        ]
        if cleaned in hallucinations or cleaned.replace(".", "").replace(",", "").strip() in ["", "the", "a", "an"]:
            return {"valid": False, "reason": "Common hallucination"}

        # Check if text is just punctuation or very short
        if len(cleaned) < 3 or cleaned.replace(".", "").replace(",", "").replace("!", "").replace("?", "").strip() == "":
            return {"valid": False, "reason": "Too short after cleanup"}

        # If text looks reasonable, use it directly (skip AI validation to avoid conversational responses)
        # AI validation was causing "hey jarvis" -> "Yes, I am Jarvis." responses
        return {"valid": True, "text": cleaned}

    def reset(self) -> None:
        """Reset the session state."""
        self.session = None


# =============================================================================
# Voice Assistant
# =============================================================================

class VoiceAssistant:
    def __init__(self, config: Config):
        self.config = config
        self.client = NanoClawClient(config)
        self.running = True

        self.state = State.IDLE
        self.state_lock = threading.Lock()
        self.state_since = time.time()  # Track when state changed

        # SEPARATE QUEUES to fix race condition
        # Wake word listener needs continuous audio stream
        # BUG FIX: Added maxsize to prevent unbounded queue growth
        self.wake_audio_queue = queue.Queue(maxsize=100)
        # Recording needs its own queue to not steal from wake word
        # BUG FIX: Added maxsize to prevent unbounded queue growth
        self.record_audio_queue = queue.Queue(maxsize=100)

        # BUG FIX: Track dropped audio frames for monitoring
        self._dropped_wake_frames = 0
        self._dropped_record_frames = 0
        self._dropped_frames_lock = threading.Lock()

        # BUG FIX: Caffeinate process reference for cleanup
        self._caffeinate = None

        # BUG FIX: Register signal handlers to ensure cleanup on crash/terminate
        self._setup_signal_handlers()

        self.stop_speaking = threading.Event()
        self.speak_proc = None

        self.wake_event = threading.Event()

        # Load Vosk model (kept for potential other uses)
        logger.info("Loading Vosk model...")
        self.model = vosk.Model(config.vosk_model_path)
        self.recognizer = vosk.KaldiRecognizer(self.model, config.sample_rate)
        self.recognizer_lock = threading.Lock()

        # Initialize openWakeWord model for wake word detection
        logger.info("Initializing openWakeWord...")
        try:
            self.oww_model = Model(
                wakeword_models=["hey_jarvis"],
                vad_threshold=config.oww_vad_threshold,
                enable_speex_noise_suppression=False  # Linux only
            )
            logger.info(f"openWakeWord loaded with 'hey_jarvis' model (threshold: {config.oww_threshold})")
        except Exception as e:
            logger.error(f"Failed to load openWakeWord: {e}")
            logger.info("The 'hey_jarvis' model will be downloaded on first run.")
            raise

        # Buffer for accumulating audio chunks for openWakeWord
        # openWakeWord needs at least 1280 samples (80ms at 16kHz)
        self.oww_buffer = []
        self.oww_frame_size = 1280  # 80ms at 16kHz
        self.oww_cooldown_until = 0  # Cooldown to prevent multiple triggers
        self.speaking_ended_at = 0  # Track when speaking ended for cooldown

        # Target wake word for logging
        self.target_wake_word = "hey jarvis"

        # Track consecutive errors in wake word listener for shutdown decision
        self._wake_consecutive_errors = 0
        self._wake_max_consecutive_errors = 10  # Shutdown after this many consecutive errors

        logger.info(f"Ready! Say '{self.target_wake_word.upper()}' to activate.")

    def _setup_signal_handlers(self):
        """
        BUG FIX: Setup signal handlers to ensure cleanup on crash/terminate.

        This prevents zombie caffeinate processes when Jarvis crashes or
        is terminated by SIGTERM/SIGINT.
        """
        def signal_handler(signum, frame):
            logger.info(f"Received signal {signum}, cleaning up...")
            self._cleanup_caffeinate()
            sys.exit(0)

        # Register for common termination signals
        signal.signal(signal.SIGTERM, signal_handler)
        signal.signal(signal.SIGINT, signal_handler)
        # SIGBREAK is Windows-specific, handle gracefully if not available
        try:
            signal.signal(signal.SIGBREAK, signal_handler)
        except AttributeError:
            pass  # Not available on this platform

        # Also use atexit as a fallback for any exit scenario
        atexit.register(self._cleanup_caffeinate)

    def _cleanup_caffeinate(self):
        """
        BUG FIX: Clean up caffeinate process to prevent zombies.

        Safe to call multiple times - checks if process exists and is running.
        """
        if hasattr(self, '_caffeinate') and self._caffeinate is not None:
            try:
                if self._caffeinate.poll() is None:  # Process is still running
                    self._caffeinate.terminate()
                    try:
                        self._caffeinate.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        self._caffeinate.kill()
                    logger.info("System sleep prevention disabled (caffeinate terminated)")
            except Exception as e:
                logger.warning(f"Error cleaning up caffeinate process: {e}")
            finally:
                self._caffeinate = None

    def _set_state(self, new_state: State):
        with self.state_lock:
            old_state = self.state
            self.state = new_state
            self.state_since = time.time()  # Reset watchdog timer
        logger.info(f"State: {old_state.name} -> {new_state.name}")

    def _get_state(self) -> State:
        with self.state_lock:
            return self.state

    def _check_watchdog(self) -> bool:
        """Check if state watchdog has triggered.

        Returns:
            True if watchdog triggered (state was stuck too long)
        """
        current_state = self._get_state()
        if current_state == State.IDLE:
            return False  # No timeout in IDLE

        time_in_state = time.time() - self.state_since
        if time_in_state > self.config.state_timeout:
            logger.warning(f"WATCHDOG: Stuck in {current_state.name} for {time_in_state:.1f}s, recovering to IDLE")
            self._set_state(State.IDLE)
            self._clear_audio_queue()
            self.stop_speaking.set()
            self.wake_event.clear()
            return True
        return False

    def _audio_callback(self, indata, frames, time_info, status):
        """Audio callback - puts raw audio bytes into BOTH queues for processing"""
        audio_bytes = bytes(indata)
        # Put into both queues - wake word detection and recording each have their own
        # BUG FIX: Log when queue is full instead of silently dropping frames
        try:
            self.wake_audio_queue.put_nowait(audio_bytes)
        except queue.Full:
            with self._dropped_frames_lock:
                self._dropped_wake_frames += 1
                # Log every 10 dropped frames to avoid spam
                if self._dropped_wake_frames % 10 == 0:
                    logger.warning(f"Wake audio queue full, dropped {self._dropped_wake_frames} frames total")

        try:
            self.record_audio_queue.put_nowait(audio_bytes)
        except queue.Full:
            with self._dropped_frames_lock:
                self._dropped_record_frames += 1
                if self._dropped_record_frames % 10 == 0:
                    logger.warning(f"Record audio queue full, dropped {self._dropped_record_frames} frames total")

        # Debug: log every 100th callback
        if not hasattr(self, '_callback_count'):
            self._callback_count = 0
        self._callback_count += 1
        if self._callback_count % 100 == 0:
            audio_array = np.frombuffer(indata, dtype=np.int16)
            audio_level = np.max(np.abs(audio_array)) if len(audio_array) > 0 else 0
            logger.info(f"Audio callback #{self._callback_count}: level={audio_level}, queue_size={self.wake_audio_queue.qsize()}")

    def _clear_audio_queue(self):
        """Clear the recording queue (not the wake word queue)"""
        while not self.record_audio_queue.empty():
            try:
                self.record_audio_queue.get_nowait()
            except queue.Empty:
                break

    def _speak(self, text: str):
        if len(text) > 100:
            for end in ['. ', '! ', '? ']:
                idx = text.rfind(end, 0, 100)
                if idx > 0:
                    text = text[:idx+1]
                    break
            else:
                text = text[:100].rsplit(' ', 1)[0] + '.'

        logger.info(f"Jarvis: {text}")
        self.stop_speaking.clear()

        self.speak_proc = subprocess.Popen(
            ['say', '-v', 'Daniel', '-r', '180', text],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

        while self.speak_proc.poll() is None:
            if self.stop_speaking.is_set():
                logger.info(">>> INTERRUPTED!")
                self.speak_proc.terminate()
                try:
                    self.speak_proc.wait(timeout=0.5)
                except subprocess.TimeoutExpired:
                    self.speak_proc.kill()
                break
            time.sleep(0.05)

        self.speak_proc = None
        self.speaking_ended_at = time.time()  # Record when speaking ended for cooldown

    def _stop_speech(self):
        self.stop_speaking.set()
        self.speaking_ended_at = time.time()  # Record when speaking ended for cooldown
        time.sleep(0.1)

    def _notify(self, title: str, message: str):
        """Show macOS notification"""
        if not self.config.enable_notifications:
            return
        # Escape quotes for AppleScript to prevent command injection
        safe_title = title.replace('\\', '\\\\').replace('"', '\\"')
        safe_message = message.replace('\\', '\\\\').replace('"', '\\"')
        cmd = ['osascript', '-e', f'display notification "{safe_message}" with title "{safe_title}"']
        subprocess.run(cmd, stderr=subprocess.DEVNULL)

    def _check_wake_word_oww(self, audio_int16: np.ndarray, threshold: Optional[float] = None) -> bool:
        """
        Check for wake word using openWakeWord prediction.

        Args:
            audio_int16: Audio data as int16 numpy array at 16kHz
            threshold: Optional override threshold (uses config default if not provided)

        Returns:
            True if wake word detected above threshold
        """
        if threshold is None:
            threshold = self.config.oww_threshold

        try:
            prediction = self.oww_model.predict(audio_int16)
            score = prediction.get('hey_jarvis', 0.0)

            # Log scores above 0.05 for debugging (info level for visibility)
            if score >= 0.05:
                logger.info(f"Wake score: {score:.3f} (threshold: {threshold})")

            if score >= threshold:
                logger.info(f"WAKE: 'hey_jarvis' detected (score: {score:.2f}, threshold: {threshold})")
                return True

        except Exception as e:
            logger.debug(f"Wake word prediction error: {e}")

        return False

    def _wake_word_listener(self):
        """Wake word detection thread using openWakeWord"""
        logger.info("Wake word listener started (openWakeWord)")
        frame_count = 0

        while self.running:
            try:
                # BUG FIX: Check state BEFORE blocking get() to prevent race condition
                # during state transitions
                current_state = self._get_state()

                # Only listen in IDLE or SPEAKING states
                if current_state not in (State.IDLE, State.SPEAKING):
                    # Clear buffer when not listening
                    self.oww_buffer = []
                    time.sleep(0.05)
                    continue

                # Check cooldown
                if time.time() < self.oww_cooldown_until:
                    time.sleep(0.05)
                    continue

                # Post-speaking cooldown: wait 1.5s after speaking ends before accepting wake words
                # This prevents TTS audio tail from triggering false positives
                if current_state != State.SPEAKING and time.time() - self.speaking_ended_at < 1.5:
                    # Clear stale audio from queue during cooldown
                    while not self.wake_audio_queue.empty():
                        try:
                            self.wake_audio_queue.get_nowait()
                        except queue.Empty:
                            break
                    time.sleep(0.05)
                    continue

                # Get audio chunk from DEDICATED wake queue
                try:
                    data = self.wake_audio_queue.get(timeout=0.5)
                except queue.Empty:
                    logger.debug("Wake queue empty")
                    continue

                # BUG FIX: Re-check state AFTER blocking get() to prevent race condition
                # This catches state changes that occurred during the blocking get()
                post_get_state = self._get_state()
                if post_get_state not in (State.IDLE, State.SPEAKING):
                    # State changed during get(), discard this audio
                    continue

                # Use the post-get state for the rest of the processing
                current_state = post_get_state

                # Convert bytes to numpy array (int16)
                audio_chunk = np.frombuffer(data, dtype=np.int16)
                frame_count += 1

                # Log every 50 frames for debugging
                if frame_count % 50 == 0:
                    logger.info(f"Wake listener: frame {frame_count}, energy={np.max(np.abs(audio_chunk))}")

                # Accumulate in buffer
                self.oww_buffer.extend(audio_chunk)

                # Process when we have enough data
                while len(self.oww_buffer) >= self.oww_frame_size:
                    # Extract frame
                    frame = np.array(self.oww_buffer[:self.oww_frame_size], dtype=np.int16)
                    self.oww_buffer = self.oww_buffer[self.oww_frame_size:]

                    # Skip if too quiet
                    energy = np.max(np.abs(frame))
                    if energy < 50:
                        continue

                    # Check for wake word with appropriate threshold
                    # Use higher threshold during SPEAKING to prevent TTS false triggers
                    threshold = self.config.oww_threshold
                    if current_state == State.SPEAKING:
                        threshold = self.config.oww_threshold_speaking

                    if self._check_wake_word_oww(frame, threshold):
                        self.oww_cooldown_until = time.time() + 2.0

                        if current_state == State.SPEAKING:
                            self._stop_speech()
                        else:
                            self.wake_event.set()

                        self.oww_buffer = []
                        break

            except MemoryError:
                # Critical error - memory exhaustion, trigger shutdown
                logger.critical("CRITICAL: Memory exhaustion in wake word listener, triggering shutdown")
                self.running = False
                break
            except Exception as e:
                # Log full stack trace for debugging
                self._wake_consecutive_errors += 1
                logger.exception(f"Wake word listener error ({self._wake_consecutive_errors} consecutive): {e}")

                # Check if too many consecutive errors
                if self._wake_consecutive_errors >= self._wake_max_consecutive_errors:
                    logger.critical(f"CRITICAL: Too many consecutive errors ({self._wake_consecutive_errors}), triggering shutdown")
                    self.running = False
                    break

                time.sleep(0.1)
            else:
                # Reset consecutive error counter on successful iteration
                self._wake_consecutive_errors = 0

    def _record_command(self) -> np.ndarray:
        duration = self.config.recording_duration
        fs = self.config.sample_rate
        chunks_needed = int(duration * fs / 8000) + 1

        # CLEAR the queue - we want fresh audio AFTER ping, not stale pre-ping audio
        self._clear_audio_queue()
        # Clear the queue immediately after ping for fresh audio
        self._notify("Jarvis", "Listening...")
        self._set_state(State.RECORDING)
        logger.info("Recording...")

        chunks = []
        start_time = time.time()

        while len(chunks) < chunks_needed and (time.time() - start_time) < duration + 0.5:
            try:
                data = self.record_audio_queue.get(timeout=0.5)
                chunks.append(data)
            except queue.Empty:
                continue

        if not chunks:
            return np.zeros(int(duration * fs), dtype=np.int16)

        audio_bytes = b''.join(chunks)
        audio = np.frombuffer(audio_bytes, dtype=np.int16)

        target_len = int(duration * fs)
        if len(audio) > target_len:
            audio = audio[:target_len]
        elif len(audio) < target_len:
            audio = np.pad(audio, (0, target_len - len(audio)))

        # AUDIO NORMALIZATION: Prevent clipping which causes transcription failure
        # If audio is clipping (max amplitude near 32767), normalize to safe level
        max_amp = np.max(np.abs(audio))
        if max_amp > 28000:  # Near clipping threshold
            # Normalize to 80% of max to prevent distortion
            target_max = 26000  # 80% of 32767
            scale = target_max / max_amp
            audio = (audio * scale).astype(np.int16)
            logger.info(f"Normalized audio: {max_amp} -> {np.max(np.abs(audio))}")

        # NOISE GATE: Reduce background noise by gating quiet sections
        # Apply simple noise gate to reduce background noise
        noise_threshold = self.config.noise_gate_threshold
        audio_float = audio.astype(np.float32)

        # Calculate envelope (smoothed amplitude)
        envelope = np.abs(audio_float)
        # Simple smoothing with a small window
        window_size = 160  # 10ms at 16kHz
        if len(envelope) > window_size:
            # Use maximum in sliding window for envelope
            envelope_smoothed = np.convolve(envelope, np.ones(window_size)/window_size, mode='same')
            # Gate: reduce gain where below threshold (less aggressive - 40% instead of 10%)
            gate_factor = np.where(envelope_smoothed > noise_threshold, 1.0, 0.4)
            audio_float = audio_float * gate_factor
            audio = audio_float.astype(np.int16)
            quiet_pct = np.sum(gate_factor < 0.5) / len(gate_factor) * 100
            if quiet_pct < 100:  # Only log if not 100% quiet
                logger.info(f"Noise gate applied: {quiet_pct:.1f}% quiet sections reduced")

        return audio

    def _transcribe(self, audio: np.ndarray) -> str:
        """Transcribe using Apple Speech framework (primary) with Vosk fallback"""
        # Log audio stats for debugging
        max_amp = np.max(np.abs(audio))
        rms = np.sqrt(np.mean(audio.astype(np.float32) ** 2))
        logger.info(f"Transcribing audio: max_amp={max_amp}, rms={rms:.1f}, duration={len(audio)/16000:.1f}s")

        try:
            result = self._transcribe_apple(audio)
            if result:
                logger.info(f"Apple Speech result: '{result}'")
                return result
            logger.warning("Apple Speech returned empty, falling back to Vosk")
            return self._transcribe_vosk(audio)
        except ImportError:
            logger.warning("Apple Speech framework not available, falling back to Vosk")
            return self._transcribe_vosk(audio)
        except Exception as e:
            logger.error(f"Apple Speech transcription error: {e}, falling back to Vosk")
            return self._transcribe_vosk(audio)

    def _transcribe_apple(self, audio: np.ndarray) -> str:
        """
        Transcribe using Apple's built-in Speech framework.

        Uses SFSpeechURLRecognitionRequest for offline transcription.
        Works on macOS 10.15+ without internet, uses Apple's Neural Engine.

        Args:
            audio: Audio data as int16 numpy array at 16kHz

        Returns:
            Transcribed text string
        """
        import tempfile
        import wave

        try:
            from Foundation import NSURL, NSLocale
            from Speech import SFSpeechRecognizer, SFSpeechURLRecognitionRequest
        except ImportError as e:
            raise ImportError(
                f"PyObjC Speech framework not available: {e}. "
                "Install with: pip install pyobjc-framework-Speech"
            )

        # Create recognizer for locale
        ns_locale = NSLocale.localeWithLocaleIdentifier_("en-US")
        recognizer = SFSpeechRecognizer.alloc().initWithLocale_(ns_locale)

        if not recognizer or not recognizer.isAvailable():
            raise RuntimeError(
                "Speech recognition not available. "
                "Check System Settings > Privacy & Security > Speech Recognition"
            )

        # Check and request authorization if needed
        # Authorization status values: 0=NotDetermined, 1=Denied, 2=Restricted, 3=Authorized
        auth_status = SFSpeechRecognizer.authorizationStatus()
        if auth_status == 0:  # Not Determined
            logger.info("Requesting speech recognition authorization...")
            SFSpeechRecognizer.requestAuthorization_(None)
            # Wait a moment for the authorization dialog
            time.sleep(0.5)
            auth_status = SFSpeechRecognizer.authorizationStatus()

        if auth_status != 3:  # Not Authorized
            status_names = {0: 'Not Determined', 1: 'Denied', 2: 'Restricted', 3: 'Authorized'}
            raise RuntimeError(
                f"Speech recognition not authorized (status: {status_names.get(auth_status, 'Unknown')}). "
                "Grant permission in System Settings > Privacy & Security > Speech Recognition"
            )

        # Write audio to temporary WAV file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
            tmp_path = tmp_file.name

        try:
            # Ensure audio is int16 mono
            if audio.dtype != np.int16:
                if audio.dtype == np.float32 or audio.dtype == np.float64:
                    audio = (audio * 32768).astype(np.int16)
                else:
                    audio = audio.astype(np.int16)

            # Write WAV file
            with wave.open(tmp_path, 'wb') as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(2)  # 16-bit
                wav_file.setframerate(16000)  # 16kHz
                wav_file.writeframes(audio.tobytes())

            # Create recognition request from file URL
            url = NSURL.fileURLWithPath_(tmp_path)
            request = SFSpeechURLRecognitionRequest.alloc().initWithURL_(url)

            if not request:
                raise RuntimeError("Failed to create recognition request")

            # Enable on-device recognition if available (macOS 10.15+)
            if hasattr(request, 'setRequiresOnDeviceRecognition_'):
                request.setRequiresOnDeviceRecognition_(True)

            # Result container for callback
            result_container = {'result': None, 'error': None}

            def recognition_handler(result, error):
                if error:
                    err_desc = error.localizedDescription() if hasattr(error, 'localizedDescription') else str(error)
                    logger.error(f"Apple Speech error: {err_desc}")
                    result_container['error'] = err_desc
                elif result:
                    logger.debug(f"Apple Speech got result: {result}")
                    result_container['result'] = result

            # Start recognition task
            task = recognizer.recognitionTaskWithRequest_resultHandler_(
                request, recognition_handler
            )

            # Wait for result (with timeout) - must run NSRunLoop for callbacks
            from Cocoa import NSRunLoop, NSDate
            start_time = time.time()
            timeout = 30.0

            while result_container['result'] is None and result_container['error'] is None:
                if time.time() - start_time > timeout:
                    task.cancel()
                    raise TimeoutError(f"Transcription timed out after {timeout} seconds")
                # Run the NSRunLoop to process callbacks
                NSRunLoop.currentRunLoop().runUntilDate_(NSDate.dateWithTimeIntervalSinceNow_(0.1))

            # Check for errors
            if result_container['error']:
                raise RuntimeError(f"Recognition error: {result_container['error']}")

            # Extract text from result
            speech_result = result_container['result']
            if speech_result:
                transcription = speech_result.bestTranscription().formattedString()
                return transcription.strip()

            return ""

        finally:
            # Clean up temp file
            import os
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _transcribe_vosk(self, audio: np.ndarray) -> str:
        """Fallback transcription using Vosk"""
        try:
            # BUG FIX: Create a new local recognizer instead of reassigning self.recognizer
            # This prevents race conditions when recognizer is used outside the lock
            local_recognizer = vosk.KaldiRecognizer(self.model, self.config.sample_rate)
            audio_bytes = audio.astype(np.int16).tobytes()
            result_text = ""

            chunk_size = 8000
            for i in range(0, len(audio_bytes), chunk_size * 2):
                chunk = audio_bytes[i:i + chunk_size * 2]
                if local_recognizer.AcceptWaveform(chunk):
                    result = json.loads(local_recognizer.Result())
                    if result.get('text'):
                        result_text += " " + result['text']

            final_result = json.loads(local_recognizer.FinalResult())
            if final_result.get('text'):
                result_text += " " + final_result['text']

            return result_text.strip()

        except Exception as e:
            logger.error(f"Vosk transcription error: {e}")
            return ""

    def _process_command(self, text: str):
        logger.info(f"Processing: '{text}'")

        # Validate transcription first
        validation = self.client.validate_transcription(text)
        if not validation.get("valid", False):
            logger.info(f"Invalid transcription: {validation.get('reason', 'unknown')}")
            self._speak("I didn't catch that. Please try again.")
            return

        # Use validated text if cleaned
        validated_text = validation.get("text", text)
        if validated_text != text:
            logger.info(f"Validated: '{text}' -> '{validated_text}'")

        response = self.client.send_message(validated_text)

        if "response" in response:
            self._speak(response["response"])
        elif "error" in response:
            self._speak("Error occurred")
        else:
            self._speak("Try again")

    def _reset_for_idle(self):
        self._set_state(State.IDLE)
        self._clear_audio_queue()
        self.client.reset()

    def start(self):
        # Prevent macOS from sleeping while Jarvis is running
        self._caffeinate = subprocess.Popen(
            ['caffeinate', '-w', str(os.getpid())],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        logger.info("System sleep prevention enabled (caffeinate)")

        wake_thread = threading.Thread(target=self._wake_word_listener, daemon=True)
        wake_thread.start()

        try:
            self.stream = sd.RawInputStream(
                samplerate=self.config.sample_rate,
                blocksize=8000,
                dtype='int16',
                channels=1,
                callback=self._audio_callback,
                device=self.config.mic_device
            )
            self.stream.start()
            logger.info(f"Audio stream started on device {self.config.mic_device}")
        except Exception as e:
            logger.error(f"Failed to start audio stream: {e}")
            raise

        logger.info(f"Listening... Say '{self.target_wake_word.upper()}' to activate.")

        while self.running:
            self._set_state(State.IDLE)

            # Wait for wake word with watchdog checking
            while self.running and not self.wake_event.is_set():
                self.wake_event.wait(timeout=1.0)
                self._check_watchdog()  # Check every second

            self.wake_event.clear()

            if not self.running:
                break

            self._notify("Jarvis", "Wake word detected")
            self._set_state(State.PING)
            os.system('afplay /System/Library/Sounds/Ping.aiff 2>/dev/null')
            time.sleep(0.3)

            self._notify("Jarvis", "Listening...")
            self._set_state(State.RECORDING)
            logger.info("Recording...")

            try:
                audio = self._record_command()

                max_amp = np.max(np.abs(audio))
                rms = np.sqrt(np.mean(audio.astype(np.float32) ** 2))
                logger.info(f"Audio level: {max_amp}, RMS: {rms:.1f}")

                # Dual threshold check: amplitude AND RMS to detect silence
                # Lowered thresholds for quieter mic gain settings
                if max_amp < 500 or rms < 300:
                    logger.info(f"Too quiet (max_amp={max_amp}, rms={rms:.1f})")
                    self._notify("Jarvis", "Too quiet - try again")
                    self._reset_for_idle()
                    continue

                self._set_state(State.PROCESSING)
                logger.info("Transcribing...")

                text = self._transcribe(audio)

                if not text:
                    self._notify("Jarvis", "Transcription failed")
                else:
                    self._notify("Jarvis", f'You said: "{text}"')

                logger.info(f"You said: '{text}'")

                text_cleaned = text.lower().strip()

                # Simple validation - Vosk doesn't hallucinate like Whisper
                empty = text_cleaned in ['', '.']

                if text and len(text) > 1 and not empty:
                    self._set_state(State.SPEAKING)
                    self._process_command(text)
                else:
                    logger.info(f"Filtered: '{text}'")

            except Exception as e:
                logger.error(f"Error: {e}")
                # Recover on error
                self._check_watchdog()

            self._reset_for_idle()
            logger.info("Listening...")

    def stop(self):
        self.running = False
        self._stop_speech()

        # Clean up audio stream to prevent resource leak
        if hasattr(self, 'stream') and self.stream is not None:
            try:
                self.stream.stop()
            except Exception as e:
                logger.debug(f"Error stopping audio stream: {e}")
            try:
                self.stream.close()
            except Exception as e:
                logger.debug(f"Error closing audio stream: {e}")

        # BUG FIX: Use centralized cleanup function to prevent zombie process
        self._cleanup_caffeinate()


def main():
    parser = argparse.ArgumentParser(description="Jarvis - Voice-activated AI assistant")
    parser.add_argument('--check', action='store_true',
                        help='Run validation checks and exit')
    parser.add_argument('--device', type=int, default=None,
                        help='Specify microphone device number (default: auto-detect)')
    parser.add_argument('--no-notify', action='store_true',
                        help='Disable macOS notifications')
    args = parser.parse_args()

    config = Config()
    if args.device is not None:
        config.mic_device = args.device
    if args.no_notify:
        config.enable_notifications = False

    # Run validation checks
    all_ok, results = validate_all(config)

    if args.check:
        # Validation mode - print results and exit
        print("\n=== Jarvis Validation ===\n")
        for result in results:
            print(f"  {result}")
        print()
        if all_ok:
            print("All checks PASSED. Jarvis is ready to run.")
            sys.exit(0)
        else:
            print("Some checks FAILED. Fix the issues above before running Jarvis.")
            sys.exit(1)

    # Normal mode - validate first, then start
    print("\n=== Jarvis Startup Validation ===\n")
    for result in results:
        print(f"  {result}")
    print()

    if not all_ok:
        print("Startup validation FAILED. Fix the issues above.")
        print("Run 'python3 jarvis.py --check' for details.")
        sys.exit(1)

    print("All checks passed. Starting Jarvis...\n")

    lock_file = open('/tmp/jarvis.lock', 'w')
    try:
        fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        print("Another jarvis instance is already running")
        lock_file.close()
        sys.exit(1)

    try:
        assistant = VoiceAssistant(config)
        assistant.start()
    except KeyboardInterrupt:
        pass
    except Exception as e:
        logger.error(f"Error: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)
    finally:
        if 'assistant' in locals():
            assistant.stop()
        # Release lock and close file descriptor
        fcntl.flock(lock_file, fcntl.LOCK_UN)
        lock_file.close()


if __name__ == "__main__":
    main()
