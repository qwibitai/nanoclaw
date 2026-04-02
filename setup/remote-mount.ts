import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { emitStatus } from './status.js';
import {
  addMount,
  removeMount,
  loadRegistry,
  type RemoteMount,
} from '../src/remote-mounts.js';
import {
  initDatabase,
  getAllRegisteredGroups,
  setRegisteredGroup,
} from '../src/db.js';
import { MOUNT_ALLOWLIST_PATH } from '../src/config.js';

export function buildRcloneRemoteName(name: string): string {
  return `nanoclaw-${name}`;
}

export function buildSystemdServiceName(name: string): string {
  return `nanoclaw-mount-${name}.service`;
}

export function buildMountPoint(name: string): string {
  return `/mnt/nanoclaw/${name}`;
}

export function generateSystemdService(opts: {
  name: string;
  rcloneRemote: string;
  remotePath: string;
  rcloneConfigPath: string;
}): string {
  const mountPoint = buildMountPoint(opts.name);
  return `[Unit]
Description=NanoClaw remote storage: ${opts.name}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=notify
ExecStart=/usr/bin/rclone mount ${opts.rcloneRemote}:${opts.remotePath} ${mountPoint} \\
  --config ${opts.rcloneConfigPath} \\
  --vfs-cache-mode full \\
  --vfs-cache-max-age 1h \\
  --allow-other \\
  --log-level INFO
ExecStop=/bin/fusermount -u ${mountPoint}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
}

function checkDependency(cmd: string): boolean {
  try {
    execFileSync('which', [cmd], { encoding: 'utf-8' });
    return true;
  } catch {
    return false;
  }
}

function updateAllowlist(mountPoint: string, name: string): void {
  interface AllowlistRoot {
    path: string;
    allowReadWrite: boolean;
    description: string;
  }
  interface Allowlist {
    allowedRoots: AllowlistRoot[];
    blockedPatterns: string[];
    nonMainReadOnly: boolean;
  }

  let allowlist: Allowlist;
  if (existsSync(MOUNT_ALLOWLIST_PATH)) {
    allowlist = JSON.parse(readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8'));
  } else {
    // Create default allowlist
    const dir = join(MOUNT_ALLOWLIST_PATH, '..');
    execFileSync('mkdir', ['-p', dir]);
    allowlist = {
      allowedRoots: [],
      blockedPatterns: [],
      nonMainReadOnly: true,
    };
  }

  const alreadyExists = allowlist.allowedRoots.some(
    (r) => r.path === mountPoint,
  );
  if (!alreadyExists) {
    allowlist.allowedRoots.push({
      path: mountPoint,
      allowReadWrite: true,
      description: `Remote storage: ${name}`,
    });
    writeFileSync(
      MOUNT_ALLOWLIST_PATH,
      JSON.stringify(allowlist, null, 2) + '\n',
    );
  }
}

export async function run(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === 'list') {
    const registry = loadRegistry();
    emitStatus('REMOTE_MOUNT_LIST', {
      MOUNTS: JSON.stringify(registry),
    });
    return;
  }

  if (subcommand === 'status') {
    const name = args[1];
    if (name === 'deps') {
      emitStatus('REMOTE_MOUNT_DEPS', {
        RCLONE: checkDependency('rclone') ? 'true' : 'false',
        FUSE3: checkDependency('fusermount3') ? 'true' : 'false',
      });
      return;
    }
    if (!name) {
      emitStatus('REMOTE_MOUNT_STATUS', { ERROR: 'Mount name required' });
      return;
    }
    try {
      const serviceName = buildSystemdServiceName(name);
      const result = execFileSync('systemctl', ['is-active', serviceName], {
        encoding: 'utf-8',
      }).trim();
      emitStatus('REMOTE_MOUNT_STATUS', {
        NAME: name,
        ACTIVE: result === 'active' ? 'true' : 'false',
        UNIT: serviceName,
      });
    } catch {
      emitStatus('REMOTE_MOUNT_STATUS', { NAME: name, ACTIVE: 'false' });
    }
    return;
  }

  if (subcommand === 'remove') {
    const name = args[1];
    if (!name) {
      emitStatus('REMOTE_MOUNT_REMOVE', { ERROR: 'Mount name required' });
      return;
    }
    const serviceName = buildSystemdServiceName(name);
    try {
      execFileSync('sudo', ['systemctl', 'stop', serviceName]);
      execFileSync('sudo', ['systemctl', 'disable', serviceName]);
      execFileSync('sudo', ['rm', '-f', `/etc/systemd/system/${serviceName}`]);
      execFileSync('sudo', ['systemctl', 'daemon-reload']);
    } catch {
      // Unit may not exist, continue cleanup
    }
    removeMount(name);
    emitStatus('REMOTE_MOUNT_REMOVE', { NAME: name, STATUS: 'success' });
    return;
  }

  if (subcommand === 'create') {
    const [, name, type, url, remotePath] = args;
    if (!name || !type || !url || !remotePath) {
      emitStatus('REMOTE_MOUNT_CREATE', {
        ERROR: 'Usage: create <name> <type> <url> <remote-path>',
      });
      return;
    }

    // 1. Check dependencies
    const hasRclone = checkDependency('rclone');
    const hasFuse = checkDependency('fusermount3');
    if (!hasRclone || !hasFuse) {
      emitStatus('REMOTE_MOUNT_CREATE', {
        ERROR: `Missing: ${!hasRclone ? 'rclone ' : ''}${!hasFuse ? 'fuse3' : ''}`.trim(),
        STATUS: 'missing_deps',
      });
      return;
    }

    // 2. Verify rclone remote exists (configured by operator via `rclone config`)
    const rcloneRemote = buildRcloneRemoteName(name);
    try {
      execFileSync('rclone', ['listremotes'], { encoding: 'utf-8' });
      const remotes = execFileSync('rclone', ['listremotes'], {
        encoding: 'utf-8',
      });
      if (!remotes.includes(`${rcloneRemote}:`)) {
        emitStatus('REMOTE_MOUNT_CREATE', {
          ERROR: `Rclone remote "${rcloneRemote}" not found. Run "rclone config" to create it first.`,
          STATUS: 'missing_remote',
        });
        return;
      }
    } catch {
      emitStatus('REMOTE_MOUNT_CREATE', {
        ERROR: 'Failed to list rclone remotes',
        STATUS: 'rclone_error',
      });
      return;
    }

    // 3. Create mount point
    const mountPoint = buildMountPoint(name);
    if (!existsSync(mountPoint)) {
      execFileSync('sudo', ['mkdir', '-p', mountPoint]);
    }

    // 4. Detect rclone config path
    const home = process.env.HOME || `/home/${process.env.USER}`;
    const rcloneConfigPath = `${home}/.config/rclone/rclone.conf`;

    // 5. Generate and install systemd service
    const serviceContent = generateSystemdService({
      name,
      rcloneRemote,
      remotePath,
      rcloneConfigPath,
    });
    const serviceName = buildSystemdServiceName(name);
    execFileSync('sudo', ['tee', `/etc/systemd/system/${serviceName}`], {
      input: serviceContent,
      encoding: 'utf-8',
    });
    execFileSync('sudo', ['systemctl', 'daemon-reload']);
    execFileSync('sudo', ['systemctl', 'enable', serviceName]);
    execFileSync('sudo', ['systemctl', 'start', serviceName]);

    // 5. Test mount
    let mountActive = false;
    try {
      const result = execFileSync('systemctl', ['is-active', serviceName], {
        encoding: 'utf-8',
      }).trim();
      mountActive = result === 'active';
    } catch {
      mountActive = false;
    }

    // 6. Update mount allowlist
    updateAllowlist(mountPoint, name);

    // 7. Save to registry
    const mount: RemoteMount = {
      type,
      url,
      remotePath,
      mountPoint,
      rcloneRemote,
      createdAt: new Date().toISOString().split('T')[0],
    };
    addMount(name, mount);

    emitStatus('REMOTE_MOUNT_CREATE', {
      NAME: name,
      MOUNT_POINT: mountPoint,
      UNIT: serviceName,
      ACTIVE: mountActive ? 'true' : 'false',
      STATUS: mountActive ? 'success' : 'mount_failed',
    });
    return;
  }

  if (subcommand === 'assign-group') {
    // args: assign-group <mount-name> <group-folder> <ro|rw>
    const [, mountName, folder, access] = args;
    if (!mountName || !folder || !access) {
      emitStatus('REMOTE_MOUNT_ASSIGN', {
        ERROR: 'Usage: assign-group <mount-name> <group-folder> <ro|rw>',
      });
      return;
    }

    const registry = loadRegistry();
    const mount = registry[mountName];
    if (!mount) {
      emitStatus('REMOTE_MOUNT_ASSIGN', {
        ERROR: `Mount "${mountName}" not found in registry`,
      });
      return;
    }

    initDatabase();
    const groups = getAllRegisteredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
    if (!entry) {
      emitStatus('REMOTE_MOUNT_ASSIGN', {
        ERROR: `Group with folder "${folder}" not found`,
      });
      return;
    }

    const [jid, group] = entry;
    const config = group.containerConfig || {};
    const mounts = config.additionalMounts || [];
    const existing = mounts.find(
      (m: { hostPath: string }) => m.hostPath === mount.mountPoint,
    );
    if (existing) {
      emitStatus('REMOTE_MOUNT_ASSIGN', {
        STATUS: 'already_assigned',
        GROUP: folder,
        MOUNT: mountName,
      });
      return;
    }

    mounts.push({
      hostPath: mount.mountPoint,
      containerPath: mountName,
      readonly: access === 'ro',
    });
    config.additionalMounts = mounts;
    group.containerConfig = config;
    setRegisteredGroup(jid, group);

    emitStatus('REMOTE_MOUNT_ASSIGN', {
      STATUS: 'success',
      GROUP: folder,
      MOUNT: mountName,
      ACCESS: access,
    });
    return;
  }

  if (subcommand === 'unassign-group') {
    // args: unassign-group <mount-name> <group-folder>
    const [, mountName, folder] = args;
    if (!mountName || !folder) {
      emitStatus('REMOTE_MOUNT_UNASSIGN', {
        ERROR: 'Usage: unassign-group <mount-name> <group-folder>',
      });
      return;
    }

    const registry = loadRegistry();
    const mount = registry[mountName];
    if (!mount) {
      emitStatus('REMOTE_MOUNT_UNASSIGN', {
        ERROR: `Mount "${mountName}" not found in registry`,
      });
      return;
    }

    initDatabase();
    const groups = getAllRegisteredGroups();
    const entry = Object.entries(groups).find(([, g]) => g.folder === folder);
    if (!entry) {
      emitStatus('REMOTE_MOUNT_UNASSIGN', {
        ERROR: `Group with folder "${folder}" not found`,
      });
      return;
    }

    const [jid, group] = entry;
    const config = group.containerConfig || {};
    config.additionalMounts = (config.additionalMounts || []).filter(
      (m: { hostPath: string }) => m.hostPath !== mount.mountPoint,
    );
    group.containerConfig = config;
    setRegisteredGroup(jid, group);

    emitStatus('REMOTE_MOUNT_UNASSIGN', {
      STATUS: 'success',
      GROUP: folder,
      MOUNT: mountName,
    });
    return;
  }

  emitStatus('REMOTE_MOUNT', {
    ERROR: `Unknown subcommand: ${subcommand}. Use: create, remove, status, list, assign-group, unassign-group`,
  });
}
