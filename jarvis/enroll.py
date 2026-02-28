#!/usr/bin/env python3
"""
Voice Enrollment for Jarvis

Properly records your voice using voice activity detection.
Only records when you're actually speaking.
"""

import os
import time
import wave
import numpy as np
import sounddevice as sd
from resemblyzer import VoiceEncoder
import torch

ENROLLMENT_DIR = os.path.expanduser("~/.jarvis")
SAMPLE_RATE = 16000
NUM_SAMPLES = 3

def load_vad():
    """Load Silero VAD for detecting speech"""
    model, _ = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        trust_repo=True
    )
    return model

def wait_for_speech(vad_model, timeout=10):
    """Wait for user to start speaking, then record until they stop"""
    chunk_size = 512
    audio_chunks = []
    speech_started = False
    silence_after_speech = 0
    start_time = time.time()

    stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype='float32', blocksize=chunk_size)
    stream.start()

    try:
        while time.time() - start_time < timeout:
            chunk, _ = stream.read(chunk_size)
            chunk = chunk.flatten()

            # Check if speech
            audio_tensor = torch.from_numpy(chunk).unsqueeze(0)
            speech_prob = vad_model(audio_tensor, SAMPLE_RATE).item()

            if speech_prob > 0.5:
                audio_chunks.append(chunk)
                speech_started = True
                silence_after_speech = 0
            elif speech_started:
                # We were recording speech, now silence
                silence_after_speech += 1
                if silence_after_speech > 15:  # ~0.5s of silence = stop
                    break
                audio_chunks.append(chunk)
    finally:
        stream.stop()
        stream.close()

    if not audio_chunks:
        return None

    return np.concatenate(audio_chunks)

def main():
    print("\n" + "="*60)
    print("   JARVIS VOICE ENROLLMENT")
    print("="*60)
    print("""
This will record 3 voice samples.

IMPORTANT:
- Wait for 'RECORDING...' prompt
- Then say 'Jarvis' CLEARLY
- Recording stops automatically after you finish speaking
""")

    # Load models
    print("Loading voice detection model...")
    vad_model = load_vad()
    encoder = VoiceEncoder()
    print("Ready!\n")

    embeddings = []

    for i in range(NUM_SAMPLES):
        print(f"\n[{i+1}/{NUM_SAMPLES}] Get ready to say 'Jarvis'")
        print("  Listening... (will start recording when you speak)")

        # Wait a moment for user to prepare
        time.sleep(1)

        print("  RECORDING... Say 'Jarvis' now!")

        audio = wait_for_speech(vad_model, timeout=8)

        if audio is None or len(audio) < SAMPLE_RATE * 0.3:  # Less than 0.3s
            print("  ✗ Didn't detect speech, try again")
            continue

        duration = len(audio) / SAMPLE_RATE
        print(f"  ✓ Recorded {duration:.1f}s")

        # Extract embedding
        try:
            embedding = encoder.embed_utterance(audio)
            embeddings.append(embedding)
            print("  ✓ Voice sample captured")
        except Exception as e:
            print(f"  ✗ Error: {e}")

    if len(embeddings) < 2:
        print("\n✗ Enrollment failed - need at least 2 valid samples")
        print("Try again in a quieter environment")
        return False

    # Average embeddings
    avg_embedding = np.mean(embeddings, axis=0)

    # Save
    os.makedirs(ENROLLMENT_DIR, exist_ok=True)
    np.save(os.path.join(ENROLLMENT_DIR, "owner_embedding.npy"), avg_embedding)

    print("\n" + "="*60)
    print("   ✓ VOICE ENROLLED SUCCESSFULLY!")
    print("="*60)
    print(f"\n   Samples captured: {len(embeddings)}/{NUM_SAMPLES}")
    print("   Jarvis will now only respond to YOUR voice.")
    print("\n   Run 'python3 jarvis.py' to start.\n")

    return True

if __name__ == "__main__":
    main()
