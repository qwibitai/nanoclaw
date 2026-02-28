"""
Configuration for Jarvis voice assistant
"""

import os
from dataclasses import dataclass
from typing import Optional
from enum import Enum


class TTSEngine(Enum):
    KOKORO = "kokoro"
    MACOS = "macos"


@dataclass
class JarvisConfig:
    """Configuration for Jarvis voice assistant"""
    # Wake word settings
    wake_word: str = "jarvis"

    # NanoClaw API
    nanoclaw_api_url: str = "http://localhost:3100"

    # Audio settings
    sample_rate: int = 16000
    input_device: int = 0  # Default input device
    output_device: int = 1  # speakers

    # Voice activity detection (uses openWakeWord)
    vad_sensitivity: float = 0.5  # Lower = more sensitive
    vad_mute_window_ms: int = 500  # Window to pause to silence
    silence_threshold_ms: int = 1000  # Stop recording after this long
    min_silence_duration_ms: int = 300  # Min silence to stop

    # Speaker verification (uses pyannote)
    speaker_model_path: Optional[str] = None
    voiceprint_path: Optional[str] = None

    # STT settings
    whisper_model: str = "turbo"  # fast on Apple Silicon
    language: str = "en"

    # TTS settings
    tts_engine: str = "macos"
    kokoro_model_path: Optional[str] = None
    kokoro_voice: Optional[str] = None

    # Recording limits
    max_recording_time: int = 30  # seconds

    @classmethod
    def from_env(cls) -> "JarvisConfig":
        """Load configuration from environment variables"""
        config = cls()

        config.nanoclaw_api_url = os.getenv("NANOCLAW_API_URL", config.nanoclaw_api_url)
        config.wake_word = os.getenv("JARVIS_WAKE_WORD", config.wake_word)
        config.sample_rate = int(os.getenv("JARVIS_SAMPLE_RATE", str(config.sample_rate)))
        config.input_device = int(os.getenv("JARVIS_INPUT_DEVICE", str(config.input_device)))
        config.output_device = int(os.getenv("JARVIS_OUTPUT_DEVICE", str(config.output_device)))

        # Audio config
        config.vad_sensitivity = float(os.getenv("JARVIS_VAD_SENSITIVITY", str(config.vad_sensitivity)))
        config.vad_mute_window_ms = int(os.getenv("JARVIS_VAD_MUTE_WINDOW", str(config.vad_mute_window_ms)))
        config.min_silence_duration_ms = int(os.getenv("JARVIS_MIN_SILENCE_MS", str(config.min_silence_duration_ms)))
        config.silence_threshold_ms = int(os.getenv("JARVIS_SILENCE_THRESHOLD", str(config.silence_threshold_ms)))

        # Voice verification
        config.speaker_model_path = os.getenv("JARVIS_SPEAKER_MODEL")
        config.voiceprint_path = os.getenv("JARVIS_VOICEPRINT")

        # STT config
        config.whisper_model = os.getenv("JARVIS_WHISPER_MODEL", config.whisper_model)
        config.language = os.getenv("JARVIS_LANGUAGE", config.language)

        # TTS config
        tts_engine = os.getenv("JARVIS_TTS_ENGINE")
        if tts_engine:
            config.tts_engine = tts_engine

        return config
