# # Project Jarvis: Spec-Driven Build Plan

# 1\. Core Goals
* **Always-Listening:** Low-power wake word detection ("Jarvis").
* **Speaker Locked:** Only responds to your specific voiceprint.
* **Full Duplex:** You can talk over the agent to stop its current speech.
* **Local Brain:** Connected to a **NanoClaw** instance for tool use and logic.
* **Speed:** Under 500ms total "round-trip" time.

⠀
# 2\. The Tech Stack

| **Layer** | **Tool** | **Why?** |
|---|---|---|
| **Wake Word** | openWakeWord | Open source, fast, supports "Jarvis" out of the box. |
| **Speaker ID** | Pyannote.audio | Verifies the speaker is you before the LLM "thinks." |
| **Ears (STT)** | faster-whisper | (Turbo model). Fast on Apple Silicon. |
| **Brain** | **NanoClaw** | Local agentic framework for banking/coding tasks. |
| **Mouth (TTS)** | Kokoro-82M | Tiny, 80ms latency, sounds human. |
| **Barge-In** | Silero VAD | Detects when you start talking to kill the TTS output. |

# 3\. Hardware Mapping
* **Input:** Yeti Nano (USB). High gain, keeps noise floor low.
* **Output:** External Speakers. Keeps sound away from the mic to help with echo.
* **Processing:** M3 Max (128GB RAM). Plenty of room for large context windows in NanoClaw.

⠀
# 4\. Logical Flow (The "Relay Race")
1. **Passive Watch:** The script monitors the Yeti Nano stream using a small buffer.
2. **Trigger:** openWakeWord hears "Jarvis."
3. **Verify:** The system grabs a 0.5s audio chunk and checks against your pre-saved voiceprint.
4. **Listen:** If verified, it starts a full **Whisper** recording. It stops when **Silero VAD** sees 600ms of silence.
5. **Think:** The text goes to the **NanoClaw** API.
6. **Speak:** NanoClaw streams text back. Each sentence goes to **Kokoro**.
7. **Interrupt:** If you speak while Kokoro is playing, a background thread hits the "kill switch" on the audio driver.

⠀
# 5\. Implementation Steps
### Phase 1: The Foundations
* Set up a Python virtual environment.
* Install kokoro, faster-whisper, and openWakeWord.
* Record 10 seconds of your voice to create a voiceprint.npy file.

⠀Phase 2: The Gateway
* Build a script that links the Yeti Nano input to the wake word engine.
* Hook up the "Barge-in" logic. This is the hardest part. You need to use sounddevice in a non-blocking way so the mic stays "hot" while the speakers are playing.

⠀Phase 3: NanoClaw Link
* Set up a local NanoClaw container.
* Create a "Bridge" function that takes the Whisper text and sends it to the NanoClaw orchestrator.

⠀
### A Personal Observation on Local Inference
Local builds are great, but the "glue" is where things break. Even with 128GB of RAM, you'll find that Python's "Global Interpreter Lock" (GIL) can cause tiny micro-stutters in the audio if you try to do too much in one thread. You’ll likely need to use multiprocessing for the "Ears" and "Mouth" to keep them truly snappy. It’s a bit of a headache, but it’s the only way to get that instant Jarvis feel.

# 6\. Known Risks
* **Audio Feedback:** Even with external speakers, the Yeti Nano might pick up the AI’s voice. We will need to set a "VAD Mute" window during playback.
* **Latency Spikes:** If NanoClaw triggers a complex tool (like a web search), the voice gap will grow. We need to "stream" the initial response text as soon as the first tokens arrive.
