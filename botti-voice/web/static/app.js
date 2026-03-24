class BottiVoice {
    constructor() {
        this.ws = null;
        this.captureContext = null;
        this.playbackContext = null;
        this.mediaStream = null;
        this.workletNode = null;
        this.isMuted = false;
        this.isConnected = false;
        this.nextPlayTime = 0;
        this.isPlaying = false;
        this.reconnectTimer = null;
    }

    async connect() {
        if (this.isConnected) {
            this.disconnect();
            return;
        }

        updateStatus('Connecting...', 'connecting');

        try {
            // Get mic with browser echo cancellation + noise suppression
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    channelCount: 1,
                }
            });

            // Capture context at 16kHz (Gemini input rate)
            this.captureContext = new AudioContext({ sampleRate: 16000 });
            const source = this.captureContext.createMediaStreamSource(this.mediaStream);

            // Use ScriptProcessorNode for PCM access
            // (AudioWorklet is cleaner but ScriptProcessor works everywhere)
            this.processor = this.captureContext.createScriptProcessor(1024, 1, 1);
            // Full-duplex: always send mic audio (browser AEC handles echo)
            // This lets Gemini server-side VAD detect barge-in during playback
            this.processor.onaudioprocess = (event) => {
                if (this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
                const float32 = event.inputBuffer.getChannelData(0);
                const int16 = new Int16Array(float32.length);
                for (let i = 0; i < float32.length; i++) {
                    const s = Math.max(-1, Math.min(1, float32[i]));
                    int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                this.ws.send(int16.buffer);
            };

            source.connect(this.processor);
            this.processor.connect(this.captureContext.destination);

            // Playback context at 24kHz (Gemini output rate)
            this.playbackContext = new AudioContext({ sampleRate: 24000 });
            this.nextPlayTime = 0;

            // Open WebSocket
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            this.ws = new WebSocket(`${protocol}//${location.host}/ws/audio`);
            this.ws.binaryType = 'arraybuffer';

            this.ws.onopen = () => {
                this.isConnected = true;
                updateStatus('Connected', 'connected');
                updateUI(true);
            };

            this.ws.onmessage = (event) => {
                if (event.data instanceof ArrayBuffer) {
                    this.playAudio(event.data);
                } else {
                    try {
                        const msg = JSON.parse(event.data);
                        if (msg.type === 'text') {
                            appendTranscript(msg.content);
                        } else if (msg.type === 'turn_complete') {
                            // Gemini interrupted or turn ended — stop all playback immediately
                            this.stopAllPlayback();
                        }
                        // Ignore pings
                    } catch (e) {}
                }
            };

            this.ws.onclose = (event) => {
                this.isConnected = false;
                updateUI(false);
                if (event.code === 4001) {
                    updateStatus('Non autorise - reconnectez-vous', 'error');
                    window.location.href = '/auth/login';
                } else if (event.code === 4002) {
                    updateStatus('Session deja active ailleurs', 'error');
                } else {
                    updateStatus('Disconnected', '');
                    // Auto-reconnect after 3 seconds
                    this.reconnectTimer = setTimeout(() => {
                        if (!this.isConnected) {
                            this.connect();
                        }
                    }, 3000);
                }
            };

            this.ws.onerror = () => {
                updateStatus('Connection error', 'error');
            };

        } catch (err) {
            if (err.name === 'NotAllowedError') {
                updateStatus('Microphone access denied', 'error');
            } else {
                updateStatus(`Error: ${err.message}`, 'error');
            }
            this.cleanup();
        }
    }

    stopAllPlayback() {
        // Cancel all scheduled audio sources immediately (barge-in)
        if (this.scheduledSources) {
            for (const src of this.scheduledSources) {
                try { src.stop(); } catch (e) { /* already stopped */ }
            }
        }
        this.scheduledSources = [];
        this.nextPlayTime = 0;
        this.isPlaying = false;
        document.getElementById('pulseRing').classList.remove('speaking');
    }

    playAudio(pcmBuffer) {
        if (!this.playbackContext) return;

        if (!this.scheduledSources) this.scheduledSources = [];

        const int16 = new Int16Array(pcmBuffer);
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
            float32[i] = int16[i] / 32768;
        }

        const audioBuffer = this.playbackContext.createBuffer(1, float32.length, 24000);
        audioBuffer.getChannelData(0).set(float32);

        const source = this.playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackContext.destination);

        // Schedule seamless playback (no gaps between chunks)
        const currentTime = this.playbackContext.currentTime;
        const startTime = Math.max(currentTime + 0.01, this.nextPlayTime);
        source.start(startTime);
        this.nextPlayTime = startTime + audioBuffer.duration;
        this.scheduledSources.push(source);

        // Track speaking state for visual feedback
        if (!this.isPlaying) {
            this.isPlaying = true;
            document.getElementById('pulseRing').classList.add('speaking');
        }

        source.onended = () => {
            // Remove from tracked sources
            const idx = this.scheduledSources.indexOf(source);
            if (idx !== -1) this.scheduledSources.splice(idx, 1);
            // Check if this was the last scheduled buffer
            if (this.playbackContext && this.playbackContext.currentTime >= this.nextPlayTime - 0.05) {
                this.isPlaying = false;
                document.getElementById('pulseRing').classList.remove('speaking');
            }
        };
    }

    sendText(text) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && text.trim()) {
            this.ws.send(JSON.stringify({ type: 'text', content: text }));
            appendTranscript(`> ${text}`);
        }
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        return this.isMuted;
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null; // Prevent auto-reconnect
            this.ws.close();
        }
        this.cleanup();
        this.isConnected = false;
        updateStatus('Disconnected', '');
        updateUI(false);
    }

    cleanup() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(t => t.stop());
            this.mediaStream = null;
        }
        if (this.captureContext) {
            this.captureContext.close().catch(() => {});
            this.captureContext = null;
        }
        if (this.playbackContext) {
            this.playbackContext.close().catch(() => {});
            this.playbackContext = null;
        }
        this.processor = null;
        this.ws = null;
    }
}

// UI helpers
function updateStatus(text, className) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = className || '';
}

function updateUI(connected) {
    const connectBtn = document.getElementById('connectBtn');
    const muteBtn = document.getElementById('muteBtn');
    const textMsg = document.getElementById('textMsg');
    const sendBtn = document.getElementById('sendBtn');
    const pulseRing = document.getElementById('pulseRing');

    if (connected) {
        connectBtn.textContent = 'Disconnect';
        connectBtn.classList.add('active');
        muteBtn.disabled = false;
        textMsg.disabled = false;
        sendBtn.disabled = false;
        pulseRing.classList.add('active');
    } else {
        connectBtn.textContent = 'Connect';
        connectBtn.classList.remove('active');
        muteBtn.disabled = true;
        textMsg.disabled = true;
        sendBtn.disabled = true;
        pulseRing.classList.remove('active', 'speaking');
    }
}

function appendTranscript(text) {
    const el = document.getElementById('transcript');
    el.textContent += text;
    el.scrollTop = el.scrollHeight;
}

// Init
const botti = new BottiVoice();

document.getElementById('connectBtn').addEventListener('click', () => botti.connect());

document.getElementById('muteBtn').addEventListener('click', () => {
    const muted = botti.toggleMute();
    const btn = document.getElementById('muteBtn');
    btn.textContent = muted ? 'Unmute' : 'Mute';
    btn.classList.toggle('muted', muted);
});

document.getElementById('sendBtn').addEventListener('click', () => {
    const input = document.getElementById('textMsg');
    botti.sendText(input.value);
    input.value = '';
});

document.getElementById('textMsg').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        botti.sendText(e.target.value);
        e.target.value = '';
    }
});
