/**
 * Sonos MCP Tool for NanoClaw
 * Provides music control and TTS announcements for Sonos speakers
 */
import { SonosDevice, SonosManager } from '@svrooij/sonos';

const SONOS_SPEAKER_IP = process.env.SONOS_SPEAKER_IP;
const SONOS_TTS_ENDPOINT = process.env.SONOS_TTS_ENDPOINT || 'https://api.streamelements.com/kappa/v2/speech';

interface SonosToolInput {
  action: 'play' | 'pause' | 'next' | 'previous' | 'volume' | 'tts' | 'discover' | 'status';
  volume?: number;
  text?: string;
  lang?: string;
}

let sonosDevice: SonosDevice | null = null;
let sonosManager: SonosManager | null = null;

async function getSonosDevice(): Promise<SonosDevice> {
  if (sonosDevice) return sonosDevice;

  if (!SONOS_SPEAKER_IP) {
    throw new Error('SONOS_SPEAKER_IP environment variable not set. Please configure a speaker IP address.');
  }

  sonosDevice = new SonosDevice(SONOS_SPEAKER_IP);
  await sonosDevice.LoadDeviceData();
  return sonosDevice;
}

async function discoverSpeakers(): Promise<string> {
  if (!sonosManager) {
    sonosManager = new SonosManager();
  }

  await sonosManager.InitializeWithDiscovery(10);

  const devices = sonosManager.Devices.map(d =>
    `- ${d.Name} (${d.Host}) - Group: ${d.GroupName}`
  ).join('\n');

  return `Found ${sonosManager.Devices.length} Sonos speaker(s):\n${devices}`;
}

async function handleSonosAction(input: SonosToolInput): Promise<string> {
  switch (input.action) {
    case 'discover':
      return await discoverSpeakers();

    case 'play': {
      const device = await getSonosDevice();
      await device.Play();
      return `▶️ Playing on ${device.Name}`;
    }

    case 'pause': {
      const device = await getSonosDevice();
      await device.Pause();
      return `⏸️ Paused on ${device.Name}`;
    }

    case 'next': {
      const device = await getSonosDevice();
      await device.Next();
      return `⏭️ Skipped to next track on ${device.Name}`;
    }

    case 'previous': {
      const device = await getSonosDevice();
      await device.Previous();
      return `⏮️ Back to previous track on ${device.Name}`;
    }

    case 'volume': {
      const device = await getSonosDevice();
      if (input.volume === undefined) {
        const state = await device.AVTransportService.GetTransportInfo();
        return `🔊 Current volume: ${state.CurrentTransportState}`;
      }
      await device.SetVolume(input.volume);
      return `🔊 Volume set to ${input.volume} on ${device.Name}`;
    }

    case 'tts': {
      if (!input.text) {
        throw new Error('TTS requires text parameter');
      }
      const device = await getSonosDevice();
      await device.PlayTTS({
        text: input.text,
        lang: input.lang || 'en-US',
        gender: 'male',
        volume: input.volume || 50,
        endpoint: SONOS_TTS_ENDPOINT,
      });
      return `🔊 TTS announcement sent to ${device.Name}`;
    }

    case 'status': {
      const device = await getSonosDevice();
      const state = await device.AVTransportService.GetTransportInfo();
      const position = await device.AVTransportService.GetPositionInfo();
      const volume = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });

      return [
        `📊 Status for ${device.Name}:`,
        `State: ${state.CurrentTransportState}`,
        `Track: ${position.TrackMetaData ? 'Playing' : 'Stopped'}`,
        `Volume: ${volume.CurrentVolume}`,
        `Group: ${device.GroupName}`,
      ].join('\n');
    }

    default:
      throw new Error(`Unknown action: ${input.action}`);
  }
}

// MCP Tool Definition
export const sonosTool = {
  name: 'sonos',
  description: `Control Sonos speakers - play/pause music, adjust volume, send TTS announcements.

Actions:
- discover: Find all Sonos speakers on network
- play: Resume playback
- pause: Pause playback
- next: Skip to next track
- previous: Go to previous track
- volume: Get or set volume (0-100)
- tts: Send text-to-speech announcement
- status: Get current playback status

Examples:
- {"action": "discover"}
- {"action": "play"}
- {"action": "volume", "volume": 30}
- {"action": "tts", "text": "Dinner is ready", "volume": 60}`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['play', 'pause', 'next', 'previous', 'volume', 'tts', 'discover', 'status'],
        description: 'Action to perform',
      },
      volume: {
        type: 'number',
        description: 'Volume level (0-100) for volume or tts actions',
        minimum: 0,
        maximum: 100,
      },
      text: {
        type: 'string',
        description: 'Text to speak for TTS action',
      },
      lang: {
        type: 'string',
        description: 'Language code for TTS (e.g., en-US, es-ES)',
        default: 'en-US',
      },
    },
    required: ['action'],
  },

  handler: async (input: SonosToolInput): Promise<{ content: Array<{ type: string; text: string }> }> => {
    try {
      const result = await handleSonosAction(input);
      return {
        content: [{ type: 'text', text: result }],
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text', text: `❌ Sonos error: ${errorMessage}` }],
      };
    }
  },
};
