#!/usr/bin/env python3
"""
Test wake word detection using official openWakeWord example
"""
import pyaudio
import numpy as np
from openwakeword.model import Model

FORMAT = pyaudio.paInt16
CHANNELS = 1
RATE = 16000
CHUNK = 1280  # 80ms at 16kHz

print("Loading openWakeWord model...")
owwModel = Model(wakeword_models=["hey_jarvis"], inference_framework='onnx')

audio = pyaudio.PyAudio()
mic_stream = audio.open(format=FORMAT, channels=CHANNELS, rate=RATE, input=True, frames_per_buffer=CHUNK)

print("\n" + "#"*60)
print("Say 'HEY JARVIS' to test...")
print("#"*60 + "\n")

try:
    while True:
        # Get audio
        audio_data = np.frombuffer(mic_stream.read(CHUNK), dtype=np.int16)

        # Feed to openWakeWord model
        prediction = owwModel.predict(audio_data)

        # Get score
        score = prediction.get("hey_jarvis", 0)

        # Show score if > 0.01
        if score > 0.01:
            bar = "#" * int(score * 50)
            print(f"Score: {score:.3f} {bar}")

        # Detect wake word at threshold 0.5
        if score >= 0.5:
            print(f"\n*** WAKE WORD DETECTED! Score: {score:.3f} ***\n")

except KeyboardInterrupt:
    print("\nStopped.")
finally:
    mic_stream.stop_stream()
    mic_stream.close()
    audio.terminate()
