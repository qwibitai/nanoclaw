import { describe, it, expect } from 'vitest';
import {
  buildRcloneRemoteName,
  buildSystemdServiceName,
  buildMountPoint,
  generateSystemdService,
} from './remote-mount.js';

describe('setup remote-mount helpers', () => {
  it('builds rclone remote name from mount name', () => {
    expect(buildRcloneRemoteName('gambi-casa')).toBe('nanoclaw-gambi-casa');
  });

  it('builds systemd service name from mount name', () => {
    expect(buildSystemdServiceName('gambi-casa')).toBe(
      'nanoclaw-mount-gambi-casa.service',
    );
  });

  it('builds mount point path', () => {
    expect(buildMountPoint('gambi-casa')).toBe('/mnt/nanoclaw/gambi-casa');
  });

  it('generates systemd service content', () => {
    const unit = generateSystemdService({
      name: 'gambi-casa',
      rcloneRemote: 'nanoclaw-gambi-casa',
      remotePath: '/Projects/personal/gambi-nanoclaw-casa',
      rcloneConfigPath: '/home/nanoclaw/.config/rclone/rclone.conf',
    });

    expect(unit).toContain('[Unit]');
    expect(unit).toContain('Description=NanoClaw remote storage: gambi-casa');
    expect(unit).toContain('After=network-online.target');
    expect(unit).toContain('StartLimitIntervalSec=300');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('Type=notify');
    expect(unit).toContain(
      'rclone mount nanoclaw-gambi-casa:/Projects/personal/gambi-nanoclaw-casa /mnt/nanoclaw/gambi-casa',
    );
    expect(unit).toContain('--config /home/nanoclaw/.config/rclone/rclone.conf');
    expect(unit).toContain('--vfs-cache-mode full');
    expect(unit).toContain('--allow-other');
    expect(unit).toContain('fusermount -u /mnt/nanoclaw/gambi-casa');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('WantedBy=multi-user.target');
  });
});
