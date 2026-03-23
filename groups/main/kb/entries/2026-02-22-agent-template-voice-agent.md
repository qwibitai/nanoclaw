---
type: tip
title: "Agent Template — Voice Agent"
tags: [template, voice, agent, audio]
related: []
created: 2026-02-22
source: knowledge-warehouse
score: 0
last_reviewed: null
---

Purpose: Provide real-time spoken interactions for quick tasks and notes.

Inputs: Microphone audio stream, wake word or push-to-talk, optional context files.
Outputs: Transcript, synthesized reply audio, structured action items.
Components: VAD, STT, LLM, TTS, turn-taking, fallback to text.
Safety: Wake-word gating, local mute, PII redaction, explicit confirmation before actions.
Validation: Speak test phrases and verify latency, transcript accuracy, and response quality.
