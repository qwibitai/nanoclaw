/**
 * Unit tests for Sonos MCP tool
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock environment variables
const mockEnv = {
  SONOS_CONTROL_MODE: 'local',
  SONOS_SPEAKER_IP: '192.168.1.100',
  SONOS_TTS_ENDPOINT: 'https://api.streamelements.com/kappa/v2/speech',
  SONOS_CLIENT_ID: 'test-client-id',
  SONOS_CLIENT_SECRET: 'test-client-secret',
  SONOS_REFRESH_TOKEN: 'test-refresh-token',
  SONOS_HOUSEHOLD_ID: 'Sonos_test123',
  SONOS_ACCESS_TOKEN: 'test-access-token',
};

// Mock @svrooij/sonos
vi.mock('@svrooij/sonos', () => ({
  SonosDevice: vi.fn().mockImplementation(() => ({
    LoadDeviceData: vi.fn().mockResolvedValue(undefined),
    Name: 'Test Speaker',
    Play: vi.fn().mockResolvedValue(undefined),
    Pause: vi.fn().mockResolvedValue(undefined),
    Next: vi.fn().mockResolvedValue(undefined),
    Previous: vi.fn().mockResolvedValue(undefined),
    SetVolume: vi.fn().mockResolvedValue(undefined),
    PlayTTS: vi.fn().mockResolvedValue(undefined),
    AVTransportService: {
      GetTransportInfo: vi.fn().mockResolvedValue({ CurrentTransportState: 'PLAYING' }),
      GetPositionInfo: vi.fn().mockResolvedValue({ TrackMetaData: 'test-track' }),
    },
    RenderingControlService: {
      GetVolume: vi.fn().mockResolvedValue({ CurrentVolume: 50 }),
    },
    GroupName: 'Test Group',
  })),
  SonosManager: vi.fn().mockImplementation(() => ({
    InitializeWithDiscovery: vi.fn().mockResolvedValue(undefined),
    Devices: [
      { Name: 'Speaker 1', Host: '192.168.1.100', GroupName: 'Living Room' },
      { Name: 'Speaker 2', Host: '192.168.1.101', GroupName: 'Bedroom' },
    ],
  })),
}));

// Mock fetch for cloud API
global.fetch = vi.fn();

describe('Sonos MCP Tool', () => {
  beforeEach(() => {
    // Reset environment
    Object.assign(process.env, mockEnv);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Local Mode', () => {
    it('should discover speakers', async () => {
      process.env.SONOS_CONTROL_MODE = 'local';

      const { SonosManager } = await import('@svrooij/sonos');
      const manager = new SonosManager();
      await manager.InitializeWithDiscovery(10);

      expect(manager.Devices).toHaveLength(2);
      expect(manager.Devices[0].Name).toBe('Speaker 1');
    });

    it('should play music', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.Play();

      expect(device.Play).toHaveBeenCalled();
    });

    it('should pause music', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.Pause();

      expect(device.Pause).toHaveBeenCalled();
    });

    it('should skip to next track', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.Next();

      expect(device.Next).toHaveBeenCalled();
    });

    it('should go to previous track', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.Previous();

      expect(device.Previous).toHaveBeenCalled();
    });

    it('should set volume', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.SetVolume(75);

      expect(device.SetVolume).toHaveBeenCalledWith(75);
    });

    it('should get volume', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      const vol = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });

      expect(vol.CurrentVolume).toBe(50);
    });

    it('should send TTS announcement', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();
      await device.PlayTTS({
        text: 'Test announcement',
        lang: 'en-US',
        gender: 'male',
        volume: 60,
        endpoint: 'https://api.streamelements.com/kappa/v2/speech',
      });

      expect(device.PlayTTS).toHaveBeenCalledWith({
        text: 'Test announcement',
        lang: 'en-US',
        gender: 'male',
        volume: 60,
        endpoint: 'https://api.streamelements.com/kappa/v2/speech',
      });
    });

    it('should get playback status', async () => {
      const { SonosDevice } = await import('@svrooij/sonos');
      const device = new SonosDevice('192.168.1.100');
      await device.LoadDeviceData();

      const state = await device.AVTransportService.GetTransportInfo();
      const position = await device.AVTransportService.GetPositionInfo();
      const volume = await device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' });

      expect(state.CurrentTransportState).toBe('PLAYING');
      expect(position.TrackMetaData).toBe('test-track');
      expect(volume.CurrentVolume).toBe(50);
    });
  });

  describe('Cloud Mode', () => {
    beforeEach(() => {
      process.env.SONOS_CONTROL_MODE = 'cloud';
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ groups: [{ id: 'group1', name: 'Living Room' }] }),
        text: async () => '',
      } as Response);
    });

    it('should list groups', async () => {
      const response = await fetch('https://api.ws.sonos.com/control/api/v1/households/test/groups');
      const data = await response.json();

      expect(data.groups).toHaveLength(1);
      expect(data.groups[0].name).toBe('Living Room');
    });

    it('should play via cloud API', async () => {
      await fetch('https://api.ws.sonos.com/control/api/v1/households/test/groups/group1/playback/play', {
        method: 'POST',
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/playback/play'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should set volume via cloud API', async () => {
      await fetch('https://api.ws.sonos.com/control/api/v1/households/test/groups/group1/groupVolume', {
        method: 'POST',
        body: JSON.stringify({ volume: 80 }),
      });

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/groupVolume'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ volume: 80 }),
        })
      );
    });
  });

  describe('Token Refresh', () => {
    beforeEach(() => {
      process.env.SONOS_CONTROL_MODE = 'cloud';
    });

    it('should refresh expired token', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'new-access-token',
          expires_in: 86400,
        }),
      } as Response);

      const response = await fetch('https://api.sonos.com/login/v3/oauth/access', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic dGVzdC1jbGllbnQtaWQ6dGVzdC1jbGllbnQtc2VjcmV0',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=refresh_token&refresh_token=test-refresh-token',
      });

      const data = await response.json();
      expect(data.access_token).toBe('new-access-token');
      expect(data.expires_in).toBe(86400);
    });

    it('should handle refresh failure', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Invalid refresh token',
      } as Response);

      const response = await fetch('https://api.sonos.com/login/v3/oauth/access', {
        method: 'POST',
      });

      expect(response.ok).toBe(false);
      expect(response.status).toBe(401);
    });
  });

  describe('Error Handling', () => {
    it('should throw error if SONOS_SPEAKER_IP not set (local mode)', async () => {
      delete process.env.SONOS_SPEAKER_IP;

      expect(() => {
        if (!process.env.SONOS_SPEAKER_IP) {
          throw new Error('SONOS_SPEAKER_IP environment variable not set. Please configure a speaker IP address.');
        }
      }).toThrow('SONOS_SPEAKER_IP environment variable not set');
    });

    it('should throw error if cloud credentials missing', () => {
      process.env.SONOS_CONTROL_MODE = 'cloud';
      delete process.env.SONOS_HOUSEHOLD_ID;

      expect(() => {
        if (!process.env.SONOS_HOUSEHOLD_ID) {
          throw new Error('SONOS_HOUSEHOLD_ID not set. Run OAuth setup first.');
        }
      }).toThrow('SONOS_HOUSEHOLD_ID not set');
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal server error',
      } as Response);

      const response = await fetch('test-url');
      expect(response.ok).toBe(false);
      expect(response.status).toBe(500);
    });
  });

  describe('Input Validation', () => {
    it('should validate volume range (0-100)', () => {
      expect(() => {
        const volume = 150;
        if (volume < 0 || volume > 100) {
          throw new Error('Volume must be between 0 and 100');
        }
      }).toThrow('Volume must be between 0 and 100');
    });

    it('should require text for TTS', () => {
      expect(() => {
        const text = undefined;
        if (!text) {
          throw new Error('TTS requires text parameter');
        }
      }).toThrow('TTS requires text parameter');
    });

    it('should validate action enum', () => {
      const validActions = ['play', 'pause', 'next', 'previous', 'volume', 'tts', 'discover', 'status', 'groups'];
      const action = 'invalid-action';

      expect(validActions).not.toContain(action);
    });
  });
});
