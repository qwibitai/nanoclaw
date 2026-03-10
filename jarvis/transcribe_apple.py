#!/usr/bin/env python3
"""
Apple Speech Framework Transcriber for Jarvis

Uses macOS native SFSpeechRecognizer via pyobjc for offline transcription.
Falls back to Vosk if Apple Speech is unavailable.
"""

import logging
import tempfile
import time
import wave
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)


class AppleSpeechTranscriber:
    """
    Transcriber using Apple's built-in Speech framework.

    Uses SFSpeechURLRecognitionRequest to transcribe audio files.
    Works offline, uses Apple's Neural Engine on Apple Silicon.
    Requires macOS 10.15+ and pyobjc-framework-Speech.
    """

    def __init__(self, locale: str = "en-US"):
        """
        Initialize the Apple Speech transcriber.

        Args:
            locale: Locale identifier (e.g., 'en-US', 'en-GB')
        """
        self.locale = locale
        self._recognizer = None
        self._init_recognizer()

    def _init_recognizer(self):
        """Initialize the speech recognizer."""
        try:
            from Foundation import NSLocale
            from Speech import SFSpeechRecognizer

            ns_locale = NSLocale.localeWithLocaleIdentifier_(self.locale)
            self._recognizer = SFSpeechRecognizer.alloc().initWithLocale_(ns_locale)

            if not self._recognizer:
                raise RuntimeError("Failed to create SFSpeechRecognizer")

            if not self._recognizer.isAvailable():
                raise RuntimeError(
                    "Speech recognition not available. "
                    "Check System Settings > Privacy & Security > Speech Recognition"
                )

            logger.info(f"Apple Speech recognizer initialized for locale: {self.locale}")

        except ImportError as e:
            raise ImportError(
                f"PyObjC Speech framework not available: {e}. "
                "Install with: pip install pyobjc-framework-Speech"
            )

    def _write_wav(self, audio: np.ndarray, filepath: str) -> None:
        """
        Write audio data to a WAV file.

        Args:
            audio: Audio data as int16 numpy array at 16kHz
            filepath: Path to write the WAV file
        """
        # Ensure audio is int16
        if audio.dtype != np.int16:
            audio = (audio * 32768).astype(np.int16) if audio.dtype == np.float32 else audio.astype(np.int16)

        with wave.open(filepath, 'wb') as wav_file:
            wav_file.setnchannels(1)  # Mono
            wav_file.setsampwidth(2)  # 2 bytes (16-bit)
            wav_file.setframerate(16000)  # 16kHz
            wav_file.writeframes(audio.tobytes())

    def transcribe(self, audio: np.ndarray, timeout: float = 30.0) -> str:
        """
        Transcribe audio using Apple's Speech framework.

        Args:
            audio: Audio data as int16 numpy array at 16kHz
            timeout: Maximum time to wait for transcription (seconds)

        Returns:
            Transcribed text string
        """
        if self._recognizer is None:
            raise RuntimeError("Speech recognizer not initialized")

        # Write audio to temporary file
        with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp_file:
            tmp_path = tmp_file.name

        try:
            self._write_wav(audio, tmp_path)

            from Foundation import NSURL
            from Speech import SFSpeechURLRecognitionRequest

            # Create recognition request from file URL
            url = NSURL.fileURLWithPath_(tmp_path)
            request = SFSpeechURLRecognitionRequest.alloc().initWithURL_(url)

            if not request:
                raise RuntimeError("Failed to create recognition request")

            # Enable on-device recognition if available (iOS 13+, macOS 10.15+)
            if hasattr(request, 'setRequiresOnDeviceRecognition_'):
                request.setRequiresOnDeviceRecognition_(True)

            # Result container
            result_container = {'result': None, 'error': None}

            def recognition_handler(result, error):
                """Callback for recognition result."""
                if error:
                    error_desc = error.localizedDescription() if hasattr(error, 'localizedDescription') else str(error)
                    result_container['error'] = error_desc
                elif result:
                    result_container['result'] = result

            # Start recognition task (blocking with timeout)
            task = self._recognizer.recognitionTaskWithRequest_resultHandler_(
                request, recognition_handler
            )

            # Wait for result with timeout
            start_time = time.time()
            while result_container['result'] is None and result_container['error'] is None:
                if time.time() - start_time > timeout:
                    task.cancel()
                    raise TimeoutError(f"Transcription timed out after {timeout} seconds")
                time.sleep(0.1)

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


def transcribe_apple(audio: np.ndarray, locale: str = "en-US", timeout: float = 30.0) -> str:
    """
    Convenience function to transcribe audio using Apple's Speech framework.

    Args:
        audio: Audio data as int16 numpy array at 16kHz
        locale: Locale identifier (e.g., 'en-US', 'en-GB')
        timeout: Maximum time to wait for transcription (seconds)

    Returns:
        Transcribed text string, or empty string on failure
    """
    try:
        transcriber = AppleSpeechTranscriber(locale=locale)
        return transcriber.transcribe(audio, timeout=timeout)
    except Exception as e:
        logger.error(f"Apple Speech transcription failed: {e}")
        return ""


# Direct test
if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    # Test with simple sine wave (just to verify imports work)
    duration = 1.0  # seconds
    sample_rate = 16000
    frequency = 440.0  # A4

    t = np.linspace(0, duration, int(sample_rate * duration), endpoint=False)
    audio = (np.sin(2 * np.pi * frequency * t) * 0.5 * 32768).astype(np.int16)

    print("Testing Apple Speech transcriber...")
    print("Note: This will produce empty/meaningless results for a sine wave test.")
    print("Real speech input is required for actual transcription.")

    result = transcribe_apple(audio)
    print(f"Result: '{result}'")
