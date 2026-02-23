---
name: add-sonos
description: Add Sonos speaker control with music playback and TTS announcements
---

# Add Sonos Integration

This skill adds Sonos speaker control to NanoClaw with music playback and text-to-speech announcements.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `sonos` is in `applied_skills`, the code changes are already in place.

### Ask the user

1. **Do you know your Sonos speaker's IP address?** If not, we'll discover it during setup.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-sonos
```

This deterministically:
- Adds `container/tools/sonos.ts` (Sonos MCP tool)
- Installs the `@svrooij/sonos` npm dependency
- Updates `.env.example` with `SONOS_SPEAKER_IP` and `SONOS_TTS_ENDPOINT`
- Records the application in `.nanoclaw/state.yaml`

### Validate code changes

```bash
npm install
npm run build
```

Build must be clean before proceeding.

## Phase 3: Setup

### Discover Sonos speakers

If the user doesn't know their speaker IP, run discovery:

```bash
npx tsx -e "
import { SonosManager } from '@svrooij/sonos';
const manager = new SonosManager();
manager.InitializeWithDiscovery(10).then(() => {
  manager.Devices.forEach(d =>
    console.log(\`\${d.Name} - IP: \${d.Host}\`)
  );
});
"
```

Wait for the user to choose a speaker and note its IP address.

### Configure environment

Add to `.env`:

```bash
SONOS_SPEAKER_IP=192.168.x.x
```

Optional - configure custom TTS endpoint (defaults to StreamElements):

```bash
SONOS_TTS_ENDPOINT=https://your-tts-endpoint.com/api/generate
```

### Rebuild container

The Sonos tool needs to be available inside the container:

```bash
cd container/agent-runner
npm install
npm run build
cd ../..
docker build -t nanoclaw-agent container/
```

Or if using Podman:

```bash
podman build -t nanoclaw-agent container/
```

### Restart the orchestrator

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

## Phase 4: Testing

### Test discovery

Send a message to test speaker discovery:

> "Discover Sonos speakers"

The agent should list all speakers on the network.

### Test music control

> "Play music on Sonos"
> "Pause Sonos"
> "Set Sonos volume to 30"

### Test TTS announcements

> "Send TTS announcement: Dinner is ready"

## Available Actions

Once configured, you can:

- **discover** - Find all Sonos speakers on network
- **play** - Resume playback
- **pause** - Pause playback
- **next** - Skip to next track
- **previous** - Go to previous track
- **volume** - Get or set volume (0-100)
- **tts** - Send text-to-speech announcement
- **status** - Get current playback status

## Troubleshooting

### Speaker not found

1. Check speaker is on the same network
2. Verify `SONOS_SPEAKER_IP` is correct in `.env`
3. Try discovery command to find the IP

### TTS not working

1. Check `SONOS_TTS_ENDPOINT` (default should work)
2. Verify speaker is not grouped (TTS works best on individual speakers)
3. Check volume level isn't muted

### Tool not available

1. Verify container was rebuilt: `docker images | grep nanoclaw-agent`
2. Check container/agent-runner has the tool: `ls container/tools/sonos.ts`
3. Restart orchestrator

## Advanced Configuration

### Using a different TTS service

Set `SONOS_TTS_ENDPOINT` to your preferred service:

```bash
# Google Cloud TTS (requires API key)
SONOS_TTS_ENDPOINT=https://texttospeech.googleapis.com/v1/text:synthesize

# Amazon Polly (requires AWS credentials)
SONOS_TTS_ENDPOINT=https://polly.amazonaws.com/v1/speech
```

### Multi-speaker setup

For multiple speakers, you can:
1. Set `SONOS_SPEAKER_IP` to your primary speaker
2. Use discovery to find others dynamically
3. Group speakers via the Sonos app, then control the group
