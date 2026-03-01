# Browser Audio and DRM Setup

This document explains how to enable audio playback and DRM (Digital Rights Management) content in the NanoClaw browser automation.

## Audio Support

### Requirements

NanoClaw forwards audio from the containerized browser to your host system's display using PulseAudio or PipeWire socket forwarding.

**Prerequisites:**
- PulseAudio or PipeWire running on host system
- PulseAudio socket accessible at `/run/user/<uid>/pulse/native` (default on most Linux systems)

### Verification

Check if audio forwarding is enabled:

```bash
# Check if PulseAudio socket exists
ls /run/user/$(id -u)/pulse/native

# Check NanoClaw logs for audio configuration
# Should see: "PulseAudio socket forwarding enabled"
```

### Troubleshooting

**No sound from browser:**

1. Verify PulseAudio is running:
   ```bash
   pulseaudio --check && echo "PulseAudio is running"
   ```

2. Check PulseAudio socket permissions:
   ```bash
   ls -l /run/user/$(id -u)/pulse/native
   ```

3. Test audio on host:
   ```bash
   paplay /usr/share/sounds/alsa/Front_Center.wav
   ```

4. For PipeWire systems, check socket location:
   ```bash
   ls -l /run/user/$(id -u)/pipewire-0
   ```

**Audio stuttering or crackling:**
- May indicate buffer size issues
- Check host audio configuration in `/etc/pulse/daemon.conf`

## DRM Content (Netflix, etc.)

### Current Support

- ✅ **YouTube**: Full support (no DRM required)
- ⚠️ **Netflix, Disney+, etc.**: Requires Widevine CDM

### Chromium (Recommended)

Chromium includes Widevine CDM by default on most distributions:

```bash
# Check if Widevine is available
chromium --version
ls /usr/lib/chromium*/WidevineCdm/
```

NanoClaw uses Chromium by default for best DRM compatibility.

### Firefox DRM Support

Firefox requires additional setup for DRM content:

1. **Enable DRM in Firefox preferences:**
   - Navigate to `about:preferences#general`
   - Enable "Play DRM-controlled content"

2. **Widevine CDM download:**
   - Firefox attempts to auto-download Widevine
   - May timeout in containerized environments
   - Workaround: Pre-install Widevine (see Advanced Setup below)

3. **Browser restart required:**
   - Changes to DRM preferences require full Firefox restart
   - `browser_close` only closes tabs, not the process
   - Restart the Playwright MCP service or container

### Advanced Setup: Pre-installing Widevine for Firefox

If Firefox's auto-download fails, manually install Widevine:

```bash
# Download Widevine CDM
mkdir -p ~/.widevine
cd ~/.widevine
wget https://dl.google.com/widevine-cdm/4.10.2710.0-linux-x64.zip
unzip 4.10.2710.0-linux-x64.zip

# Configure Firefox to use it
# Add to Firefox profile prefs.js:
user_pref("media.gmp-widevinecdm.version", "4.10.2710.0");
user_pref("media.gmp-widevinecdm.lastUpdate", 1234567890);
```

Or modify the Dockerfile to include Widevine:

```dockerfile
RUN mkdir -p /opt/widevine && \
    curl -L https://dl.google.com/widevine-cdm/4.10.2710.0-linux-x64.zip -o /tmp/widevine.zip && \
    unzip /tmp/widevine.zip -d /opt/widevine && \
    rm /tmp/widevine.zip

ENV MOZ_GMP_PATH=/opt/widevine
```

## Testing

### Test Audio

```typescript
// In agent-browser
await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
await page.click('[aria-label="Play"]');
// Audio should play through display speakers
```

### Test DRM (Netflix)

```typescript
// Note: Requires Netflix account
await page.goto('https://www.netflix.com');
// Login and play a video
// Should play without error F7701-1003
```

## Known Limitations

1. **Audio only works when display forwarding is enabled**
   - Requires X11 or Wayland display passthrough
   - Headless mode will not have audio

2. **Firefox DRM may require manual intervention**
   - Widevine auto-download can fail in containers
   - Use Chromium for more reliable DRM support

3. **Audio latency**
   - Some delay may occur due to socket forwarding
   - Usually imperceptible for video playback

## Architecture

```
┌─────────────────────────────────────┐
│         Host System                 │
│  ┌──────────────────────────────┐  │
│  │ PulseAudio / PipeWire        │  │
│  │ Socket: /run/user/UID/pulse  │  │
│  └────────────┬─────────────────┘  │
│               │ (mounted)           │
│  ┌────────────▼─────────────────┐  │
│  │ Docker Container             │  │
│  │  ┌────────────────────────┐  │  │
│  │  │ Browser (Chromium/FF)  │  │  │
│  │  │ └──> Audio Output      │  │  │
│  │  │      via PulseAudio    │  │  │
│  │  └────────────────────────┘  │  │
│  └──────────────────────────────┘  │
│               │                     │
│  ┌────────────▼─────────────────┐  │
│  │ Physical Audio Device        │  │
│  │ (Speakers/HDMI)              │  │
│  └──────────────────────────────┘  │
└─────────────────────────────────────┘
```

## References

- [PulseAudio Documentation](https://www.freedesktop.org/wiki/Software/PulseAudio/)
- [Widevine CDM](https://www.widevine.com/)
- [Firefox DRM Settings](https://support.mozilla.org/en-US/kb/enable-drm)
