# Wake Word Detection Research for Project Jarvis

## Current Problem

The current implementation uses `faster-whisper` with a "tiny" model for wake word detection. This approach has fundamental issues:

- **Poor accuracy**: Whisper is a speech-to-text model, not a wake word detector. It transcribes "jarvis" as:
  - "jeremy?", "travis?", "ready?", "great", "just", etc.
- **High latency**: Running full speech recognition every 1.5 seconds is inefficient
- **Resource intensive**: Whisper CPU inference is relatively heavy
- **Unreliable**: Fuzzy matching with similar words list is a band-aid solution

## Recommendation: Use openWakeWord

### Why openWakeWord?

| Feature | openWakeWord | Whisper (Current) |
|---------|--------------|-------------------|
| **Purpose** | Dedicated wake word detection | General speech-to-text |
| **Latency** | ~80ms per frame | ~500ms-2s per inference |
| **CPU Usage** | Very low (single core) | High |
| **Accuracy** | Comparable to Picovoice Porcupine | Poor for wake words |
| **Offline** | Yes | Yes |
| **License** | Apache 2.0 | MIT |
| **Cost** | Free | Free |
| **"jarvis" model** | Pre-trained "hey_jarvis" included | No native support |

**Key advantages:**
- **Pre-trained "hey_jarvis" model** included - no training required
- **VAD (Voice Activity Detection)** built-in with Silero VAD
- **Frame-based prediction**: Processes audio in 80ms chunks for real-time detection
- **Threshold tuning**: Adjust sensitivity (0.0-1.0) for your environment
- **Custom model training**: Can train on synthetic data if needed
- **Noise suppression**: Optional Speex DSP on Linux

### Performance Targets

Based on openWakeWord documentation:
- **False reject rate**: <5% (misses 1 in 20 activations)
- **False accept rate**: <0.5/hour (~1 false activation per 2 hours)

## Installation

```bash
pip install openwakeword
```

On macOS, this installs:
- `onnxruntime` for model inference
- `numpy` for audio processing
- `torch` (already used by Silero VAD in jarvis.py)

## Integration Code

### Approach 1: Minimal Change (Recommended)

Replace the `_check_wake_word()` method and use openWakeWord for detection:

```python
# Add to imports at top of jarvis.py
from openwakeword.model import Model
import openwakeword

# In VoiceAssistant.__init__(), replace Whisper loading with:
# Download pre-trained models (one-time, includes "hey_jarvis")
openwakeword.utils.download_models()

# Initialize the model
self.oww_model = Model(
    wakeword_models=["hey_jarvis"],  # Pre-trained model
    vad_threshold=0.5,  # Only predict if VAD detects speech (0-1)
    enable_speex_noise_suppression=False  # Linux only
)
self.oww_threshold = 0.5  # Threshold for "hey_jarvis" detection (0-1)

# Replace _check_wake_word() method entirely:
def _check_wake_word(self):
    """Check for wake word using openWakeWord (frame-based, low latency)"""
    if len(self.wake_buffer) < 10:
        return

    try:
        # Concatenate recent audio frames
        # openWakeWord expects int16 PCM data at 16kHz
        audio_data = np.concatenate(self.wake_buffer[-100:])

        # Skip if too quiet
        if np.max(np.abs(audio_data)) < 0.02:
            self.wake_buffer = self.wake_buffer[-20:]
            return

        # Convert float32 [-1, 1] to int16 PCM
        audio_int16 = (audio_data * 32767).astype(np.int16)

        # Get prediction from openWakeWord
        # Returns dict like {'hey_jarvis': 0.82}
        prediction = self.oww_model.predict(audio_int16)

        # Check if wake word detected
        score = prediction.get('hey_jarvis', 0.0)
        if score >= self.oww_threshold:
            logger.info(f"✓ Wake word detected! (score: {score:.2f})")

            # Verify speaker (existing code)
            if self.config.speaker_verification and self.speaker_verifier.is_enrolled():
                if not self.speaker_verifier.verify(audio_data):
                    logger.info("Ignored - not owner's voice")
                    self.wake_buffer = self.wake_buffer[-20:]
                    return

            self._activate()
            return

        # Keep small buffer
        self.wake_buffer = self.wake_buffer[-20:]

    except Exception as e:
        logger.debug(f"Wake check error: {e}")
```

### Approach 2: Streaming Detection (Lower Latency)

For even lower latency, process audio continuously in the callback:

```python
# Add to VoiceAssistant.__init__
self.oww_frame_buffer = []
self.oww_frame_size = int(0.08 * self.config.sample_rate)  # 80ms frames (optimal for openWakeWord)
self.oww_activation_cooldown = 0

# In _audio_callback, accumulate frames for OWW:
def _audio_callback(self, indata, frames, time_info, status):
    try:
        self._audio_queue.put(indata.flatten().copy(), timeout=1.0)

        # Also accumulate for openWakeWord streaming detection
        self.oww_frame_buffer.extend(indata.flatten().tolist())

        # Process complete 80ms frames
        while len(self.oww_frame_buffer) >= self.oww_frame_size:
            frame = np.array(self.oww_frame_buffer[:self.oww_frame_size])
            self.oww_frame_buffer = self.oww_frame_size[self.oww_frame_size:]

            # Skip in non-idle state or during cooldown
            if self._get_state() != self.STATE_IDLE:
                continue
            if time.time() - self.oww_activation_cooldown < 3.0:
                continue

            # Predict on this frame
            frame_int16 = (frame * 32767).astype(np.int16)
            prediction = self.oww_model.predict(frame_int16)

            if prediction.get('hey_jarvis', 0.0) >= self.oww_threshold:
                logger.info(f"✓ Wake word detected! (score: {prediction['hey_jarvis']:.2f})")
                self.oww_activation_cooldown = time.time()

                # Collect more audio for speaker verification
                verification_audio = np.concatenate(self.wake_buffer[-50:] + [frame])
                if self.config.speaker_verification and self.speaker_verifier.is_enrolled():
                    if not self.speaker_verifier.verify(verification_audio):
                        logger.info("Ignored - not owner's voice")
                        continue

                self._activate()
                break

    except queue.Full:
        pass
```

## Configuration Options

Add to Config class:

```python
class Config:
    # ... existing config ...
    # openWakeWord settings
    oww_model: str = "hey_jarvis"  # Pre-trained model name
    oww_threshold: float = 0.5     # Detection threshold (0-1)
                                    # 0.3-0.4: quiet environment
                                    # 0.4-0.5: normal environment (default)
                                    # 0.5-0.6: noisy environment
    oww_vad_threshold: float = 0.5  # VAD threshold (0-1), None to disable
```

## Why This Is Better Than Whisper

1. **Purpose-built**: openWakeWord is specifically designed for wake word detection
2. **Pre-trained model**: "hey_jarvis" model included, trained on synthetic speech
3. **Low latency**: 80ms frame processing vs 1.5+ seconds for Whisper
4. **CPU efficient**: Can run 15-20 models simultaneously on a Raspberry Pi 3
5. **Tunable threshold**: Adjust sensitivity based on environment
6. **Better accuracy**: Competes with commercial Picovoice Porcupine
7. **VAD built-in**: Reduces false positives from non-speech noise

## Alternative Options Considered

### Porcupine (Picovoice)
- **Pros**: Excellent accuracy, very low false positive rate
- **Cons**: Requires access key (free tier limited), license validation
- **Verdict**: Good option if willing to sign up for free tier

### Snowboy
- **Pros**: Completely offline, custom training
- **Cons**: Deprecated (2020), may not work on modern systems
- **Verdict**: Not recommended

### Improved Whisper
- **Pros**: No new dependencies
- **Cons**: Still using wrong tool for the job, higher latency
- **Verdict**: Not worth the effort

## Testing Recommendations

1. **Start with threshold 0.5** in a normal environment
2. **Test false positives**: Run for 1-2 hours with no wake words, count activations
3. **Test false negatives**: Say "hey jarvis" 20 times, count misses
4. **Adjust threshold**:
   - Too many false positives? Increase to 0.6
   - Too many misses? Decrease to 0.4
5. **Consider VAD**: If background noise causes issues, increase `vad_threshold`

## Migration Steps

1. Install openwakeword: `pip install openwakeword`
2. Download models (one-time): Python will auto-download on first run
3. Replace `_check_wake_word()` method with Approach 1 code
4. Remove `faster_whisper` from imports (keep for transcription, not wake word)
5. Test and tune threshold

## References

- [openWakeWord GitHub](https://github.com/dscripka/openWakeWord)
- [openWakeWord HuggingFace Demo](https://huggingface.co/spaces/davidscripka/openWakeWord)
- [Picovoice Porcupine](https://picovoice.ai/platform/porcupine/)
- [Sherpa-ONNX](https://github.com/csukuangfj/sherpa-onnx) (alternative)
