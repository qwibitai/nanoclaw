# Browser Audio and DRM Fixes for NanoClaw

## Issues Identified

### Issue 1: No Audio from Browser
**Symptom:** Video plays in browser but no sound reaches the display
**Root Cause:** X11 display forwarding only passes video, not audio
**Impact:** YouTube videos, Netflix, and other media play silently

### Issue 2: Netflix DRM Playback Failure
**Symptom:** Netflix error F7701-1003 - "We're having trouble playing Netflix"
**Root Cause:** Widevine CDM (Content Decryption Module) not available
**Technical Details:**
- Firefox/Chromium in container lacks Widevine CDM for DRM content
- GMP (Google Media Plugin) updates may be disabled in browser profile
- Browser process needs full restart to apply preference changes
- Playwright-managed browsers may not include proprietary DRM components

## Proposed Solutions

### Solution 1: Audio Support via PulseAudio Forwarding

**Container Changes:**
1. Install PulseAudio client libraries in Dockerfile
2. Mount PulseAudio socket from host into container
3. Set PULSE_SERVER environment variable

**Host Requirements:**
- PulseAudio or PipeWire-Pulse running on host
- PulseAudio socket accessible (typically `/run/user/<uid>/pulse/native`)

**Implementation:**
```dockerfile
# In Dockerfile - Add PulseAudio support
RUN apt-get update && apt-get install -y \
    pulseaudio \
    && rm -rf /var/lib/apt/lists/*
```

```typescript
// In container-runner.ts buildContainerArgs()
// Audio passthrough: PulseAudio socket forwarding
const pulseSocket = xdgRuntime ? path.join(xdgRuntime, 'pulse', 'native') : null;
if (pulseSocket && fs.existsSync(pulseSocket)) {
  args.push('-v', `${pulseSocket}:/tmp/pulse-socket`);
  args.push('-e', 'PULSE_SERVER=unix:/tmp/pulse-socket');
  // Allow access to host audio group if needed
  if (hostGid) {
    const audioGid = execSync('getent group audio | cut -d: -f3').toString().trim();
    if (audioGid) {
      args.push('--group-add', audioGid);
    }
  }
}
```

### Solution 2: Netflix DRM Support

**Option A: Use Chromium Instead of Firefox**
- Chromium has better built-in Widevine support
- Already specified in current Dockerfile
- Most reliable solution

**Option B: Pre-install Widevine for Firefox**
```dockerfile
# Download and install Widevine CDM
RUN mkdir -p /opt/widevine && \
    curl -L https://dl.google.com/widevine-cdm/4.10.2710.0-linux-x64.zip -o /tmp/widevine.zip && \
    unzip /tmp/widevine.zip -d /opt/widevine && \
    rm /tmp/widevine.zip

ENV MOZ_GMP_PATH=/opt/widevine
```

**Option C: Ensure GMP Updates Enabled** (Partial fix implemented)
- Modified `media.gmp-manager.updateEnabled` in Firefox prefs ✓
- Requires full Firefox process restart (not just page close)
- May still timeout on download in containerized environment

**Recommendation:** Use Chromium (Option A) as it's already in the Dockerfile and has better DRM support out-of-the-box.

### Solution 3: Proper Browser Restart Mechanism

**Problem:** `browser_close` tool only closes page/tab, not Firefox process
**Solution:** Add a way to fully restart the Playwright MCP server or Firefox process

**Implementation Options:**
1. Add systemd service to restart Playwright MCP
2. Add a restart command to Playwright MCP itself
3. Document manual restart procedure for users

## Testing Checklist

- [ ] Audio plays from YouTube videos on kitchen display
- [ ] Netflix content plays with both video and audio
- [ ] Browser profile persists between restarts
- [ ] No regression in existing browser automation features
- [ ] Works with both Firefox and Chromium

## Files Modified

1. `container/Dockerfile` - Add PulseAudio support
2. `src/container-runner.ts` - Add audio socket mounting logic
3. `README.md` - Document audio requirements and DRM limitations

## Alternative: PipeWire Support

For newer systems using PipeWire instead of PulseAudio:

```typescript
// Mount PipeWire socket instead
const pipewireSocket = xdgRuntime ? path.join(xdgRuntime, 'pipewire-0') : null;
if (pipewireSocket && fs.existsSync(pipewireSocket)) {
  args.push('-v', `${pipewireSocket}:/tmp/pipewire-0`);
  args.push('-e', 'PIPEWIRE_RUNTIME_DIR=/tmp');
}
```

## Implementation Priority

1. **HIGH**: Audio support (PulseAudio forwarding) - Enables sound for all media
2. **MEDIUM**: Chromium verification - Ensure DRM works out-of-box
3. **LOW**: Firefox Widevine pre-install - Only if Chromium insufficient
4. **LOW**: Browser restart mechanism - Workaround exists (restart container)
