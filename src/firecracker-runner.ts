/**
 * Firecracker MicroVM Runner for NanoClaw
 *
 * Each agent task gets its own microVM with its own Linux kernel,
 * providing strong isolation on Linux (Ubuntu Server 24.04).
 *
 * Flow: Allocate VM → Create TAP → Prepare rootfs → Boot VM → SSH task → Capture output → Cleanup
 */

import { execSync, spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import pino from 'pino';
import {
  GROUPS_DIR,
  DATA_DIR,
  CONTAINER_TIMEOUT,
  CONTAINER_MAX_OUTPUT_SIZE
} from './config.js';
import { RegisteredGroup } from './types.js';
import { validateAdditionalMounts } from './mount-security.js';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } }
});

// ── Constants ──────────────────────────────────────────────────────────

const FIRECRACKER_BIN = '/usr/local/bin/firecracker';
const KERNEL_PATH = '/opt/firecracker/vmlinux.bin';
const BASE_ROOTFS_PATH = '/opt/firecracker/agent-rootfs.ext4';
const BRIDGE_NAME = 'fcbr0';
const BRIDGE_IP = '172.16.0.1';
const SUBNET_MASK = '255.255.255.0';
const DNS_SERVER = '8.8.8.8';
const VM_VCPUS = 2;
const VM_MEM_MIB = 1024;
const SSH_BOOT_TIMEOUT_MS = 30_000;
const SSH_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

// ── Types ──────────────────────────────────────────────────────────────

export interface Mount {
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
}

export interface TaskResult {
  output: string;
  filesChanged: string[];
  exitCode: number;
  durationMs: number;
}

export interface VMStatus {
  groupId: string;
  vmId: number;
  ip: string;
  startedAt: number;
  runtimeMs: number;
}

interface MicroVM {
  vmId: number;
  groupId: string;
  ip: string;
  tapDevice: string;
  rootfsPath: string;
  socketPath: string;
  process: ChildProcess;
  startedAt: number;
}

// ── State ──────────────────────────────────────────────────────────────

let nextVmId = 1;
const activeVMs = new Map<string, MicroVM>();

// SSH keypair for VM communication
function getSSHKeyPath(): string {
  const homeDir = process.env.HOME || os.homedir();
  return path.join(homeDir, '.ssh', 'nanoclaw_agent');
}

// ── SSH Key Management ─────────────────────────────────────────────────

function ensureSSHKey(): void {
  const keyPath = getSSHKeyPath();
  if (fs.existsSync(keyPath)) return;

  const sshDir = path.dirname(keyPath);
  fs.mkdirSync(sshDir, { recursive: true });

  console.log('[FC] Generating SSH keypair for VM communication...');
  execSync(`ssh-keygen -t ed25519 -f ${keyPath} -N "" -C "nanoclaw-agent"`, {
    stdio: 'pipe'
  });
  console.log(`[FC] SSH keypair generated at ${keyPath}`);
}

// ── Startup Checks ─────────────────────────────────────────────────────

export function verifyFirecrackerSetup(): void {
  // Check /dev/kvm access
  try {
    fs.accessSync('/dev/kvm', fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    throw new Error(
      '[FC] Cannot access /dev/kvm. Ensure your user is in the "kvm" group: sudo usermod -aG kvm $USER'
    );
  }

  // Check firecracker binary
  if (!fs.existsSync(FIRECRACKER_BIN)) {
    throw new Error(
      `[FC] Firecracker not found at ${FIRECRACKER_BIN}. Install from https://github.com/firecracker-microvm/firecracker/releases`
    );
  }

  // Check kernel
  if (!fs.existsSync(KERNEL_PATH)) {
    throw new Error(
      `[FC] Kernel not found at ${KERNEL_PATH}. Download a Firecracker-compatible vmlinux.`
    );
  }

  // Check base rootfs
  if (!fs.existsSync(BASE_ROOTFS_PATH)) {
    throw new Error(
      `[FC] Agent rootfs not found at ${BASE_ROOTFS_PATH}. Run: npm run build-rootfs`
    );
  }

  // Check bridge
  try {
    execSync(`ip link show ${BRIDGE_NAME}`, { stdio: 'pipe' });
  } catch {
    throw new Error(
      `[FC] Network bridge ${BRIDGE_NAME} not found. Run: npm run setup-network`
    );
  }

  ensureSSHKey();
  console.log('[FC] Firecracker setup verified');
}

// ── VM Lifecycle ───────────────────────────────────────────────────────

function allocateVm(groupId: string): { vmId: number; ip: string } {
  const vmId = nextVmId++;
  if (vmId > 253) {
    throw new Error('[FC] Maximum VM count exceeded (253 concurrent VMs)');
  }
  const ip = `172.16.0.${vmId + 1}`;
  return { vmId, ip };
}

function generateMac(vmId: number): string {
  const hex = vmId.toString(16).padStart(2, '0');
  return `AA:FC:00:00:00:${hex}`;
}

function createTapDevice(vmId: number): string {
  const tap = `tap${vmId}`;
  try {
    execSync(`sudo ip tuntap add dev ${tap} mode tap`, { stdio: 'pipe' });
    execSync(`sudo ip link set ${tap} up`, { stdio: 'pipe' });
    execSync(`sudo ip link set ${tap} master ${BRIDGE_NAME}`, { stdio: 'pipe' });
    console.log(`[FC] Created TAP device ${tap}`);
  } catch (err) {
    throw new Error(`[FC] Failed to create TAP device ${tap}: ${err}`);
  }
  return tap;
}

function destroyTapDevice(tap: string): void {
  try {
    execSync(`sudo ip link delete ${tap}`, { stdio: 'pipe' });
    console.log(`[FC] Destroyed TAP device ${tap}`);
  } catch {
    console.log(`[FC] TAP device ${tap} already gone`);
  }
}

function prepareRootfs(
  vmId: number,
  ip: string,
  claudeAuthDir: string,
  mounts: Mount[]
): string {
  const rootfsPath = `/tmp/nanoclaw-vm-${vmId}.ext4`;
  const mountPoint = `/tmp/nanoclaw-mount-${vmId}`;

  // Copy base rootfs
  execSync(`cp ${BASE_ROOTFS_PATH} ${rootfsPath}`, { stdio: 'pipe' });

  // Mount the rootfs image
  fs.mkdirSync(mountPoint, { recursive: true });
  execSync(`sudo mount -o loop ${rootfsPath} ${mountPoint}`, { stdio: 'pipe' });

  try {
    const agentHome = path.join(mountPoint, 'home', 'agent');

    // Inject SSH public key
    const sshDir = path.join(agentHome, '.ssh');
    execSync(`sudo mkdir -p ${sshDir}`, { stdio: 'pipe' });
    const pubKey = fs.readFileSync(`${getSSHKeyPath()}.pub`, 'utf-8').trim();
    execSync(`sudo bash -c 'echo "${pubKey}" > ${sshDir}/authorized_keys'`, { stdio: 'pipe' });
    execSync(`sudo chmod 700 ${sshDir}`, { stdio: 'pipe' });
    execSync(`sudo chmod 600 ${sshDir}/authorized_keys`, { stdio: 'pipe' });
    execSync(`sudo chown -R 1000:1000 ${sshDir}`, { stdio: 'pipe' });

    // Inject Claude credentials
    if (fs.existsSync(claudeAuthDir)) {
      const claudeDir = path.join(agentHome, '.claude');
      execSync(`sudo mkdir -p ${claudeDir}`, { stdio: 'pipe' });
      execSync(`sudo cp -r ${claudeAuthDir}/. ${claudeDir}/`, { stdio: 'pipe' });
      execSync(`sudo chown -R 1000:1000 ${claudeDir}`, { stdio: 'pipe' });
    }

    // Inject Vercel AI Gateway key
    const gatewayKey = process.env.VERCEL_AI_GATEWAY_KEY;
    if (gatewayKey) {
      const keyFile = path.join(agentHome, '.vercel-ai-gateway-key');
      execSync(`sudo bash -c 'echo "${gatewayKey}" > ${keyFile}'`, { stdio: 'pipe' });
      execSync(`sudo chown 1000:1000 ${keyFile}`, { stdio: 'pipe' });
      execSync(`sudo chmod 600 ${keyFile}`, { stdio: 'pipe' });
    }

    // Copy project files from each mount into the rootfs
    for (const mount of mounts) {
      if (!fs.existsSync(mount.hostPath)) {
        console.log(`[FC] Skipping non-existent mount: ${mount.hostPath}`);
        continue;
      }
      const guestTarget = path.join(mountPoint, mount.guestPath.replace(/^\//, ''));
      execSync(`sudo mkdir -p ${guestTarget}`, { stdio: 'pipe' });
      execSync(`sudo cp -a ${mount.hostPath}/. ${guestTarget}/`, { stdio: 'pipe' });
      execSync(`sudo chown -R 1000:1000 ${guestTarget}`, { stdio: 'pipe' });
    }

    // Configure static network inside rootfs
    const networkDir = path.join(mountPoint, 'etc', 'systemd', 'network');
    execSync(`sudo mkdir -p ${networkDir}`, { stdio: 'pipe' });
    const networkConfig = `[Match]\nName=eth0\n\n[Network]\nAddress=${ip}/24\nGateway=${BRIDGE_IP}\nDNS=${DNS_SERVER}\n`;
    execSync(`sudo bash -c 'cat > ${networkDir}/10-eth0.network << "NETEOF"\n${networkConfig}NETEOF'`, { stdio: 'pipe' });

    // Configure DNS
    const resolvConf = path.join(mountPoint, 'etc', 'resolv.conf');
    execSync(`sudo bash -c 'echo "nameserver ${DNS_SERVER}" > ${resolvConf}'`, { stdio: 'pipe' });

  } finally {
    execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
    fs.rmSync(mountPoint, { recursive: true, force: true });
  }

  return rootfsPath;
}

function firecrackerApiCall(socketPath: string, method: string, endpoint: string, body: object): void {
  const json = JSON.stringify(body).replace(/'/g, "'\\''");
  execSync(
    `curl --unix-socket ${socketPath} -s -X ${method} ` +
    `'http://localhost${endpoint}' ` +
    `-H 'Content-Type: application/json' ` +
    `-d '${json}'`,
    { stdio: 'pipe', timeout: 5000 }
  );
}

function startFirecrackerProcess(vmId: number): { process: ChildProcess; socketPath: string } {
  const socketPath = `/tmp/nanoclaw-fc-${vmId}.socket`;

  // Clean up old socket if it exists
  if (fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  const proc = spawn(FIRECRACKER_BIN, ['--api-sock', socketPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  });

  // Wait for socket to appear
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(socketPath)) {
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      throw new Error(`[FC] Firecracker socket did not appear at ${socketPath}`);
    }
    execSync('sleep 0.1');
  }

  return { process: proc, socketPath };
}

function configureAndBootVM(
  socketPath: string,
  vmId: number,
  ip: string,
  rootfsPath: string,
  tapDevice: string
): void {
  const mac = generateMac(vmId);
  const bootArgs = [
    'console=ttyS0',
    'reboot=k',
    'panic=1',
    'pci=off',
    `ip=${ip}::${BRIDGE_IP}:${SUBNET_MASK}::eth0:off`,
    `nameserver=${DNS_SERVER}`
  ].join(' ');

  // Configure kernel
  firecrackerApiCall(socketPath, 'PUT', '/boot-source', {
    kernel_image_path: KERNEL_PATH,
    boot_args: bootArgs
  });

  // Configure rootfs
  firecrackerApiCall(socketPath, 'PUT', '/drives/rootfs', {
    drive_id: 'rootfs',
    path_on_host: rootfsPath,
    is_root_device: true,
    is_read_only: false
  });

  // Configure network
  firecrackerApiCall(socketPath, 'PUT', '/network-interfaces/eth0', {
    iface_id: 'eth0',
    guest_mac: mac,
    host_dev_name: tapDevice
  });

  // Configure resources
  firecrackerApiCall(socketPath, 'PUT', '/machine-config', {
    vcpu_count: VM_VCPUS,
    mem_size_mib: VM_MEM_MIB
  });

  // Start the VM
  firecrackerApiCall(socketPath, 'PUT', '/actions', {
    action_type: 'InstanceStart'
  });

  console.log(`[FC] VM ${vmId} started (${ip}, ${tapDevice})`);
}

function waitForSSH(ip: string): void {
  const keyPath = getSSHKeyPath();
  const deadline = Date.now() + SSH_BOOT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      execSync(
        `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o ConnectTimeout=2 ` +
        `-o BatchMode=yes agent@${ip} 'echo ready'`,
        { stdio: 'pipe', timeout: 5000 }
      );
      return;
    } catch {
      // Not ready yet
      execSync(`sleep ${SSH_POLL_INTERVAL_MS / 1000}`);
    }
  }

  throw new Error(`[FC] SSH did not become available at ${ip} within ${SSH_BOOT_TIMEOUT_MS}ms`);
}

function executeTaskViaSSH(ip: string, task: string, timeoutMs: number): { stdout: string; exitCode: number } {
  const keyPath = getSSHKeyPath();

  // Escape the task string for safe SSH transmission:
  // Use base64 encoding to avoid any shell escaping issues
  const taskBase64 = Buffer.from(task).toString('base64');
  const remoteCmd = `echo '${taskBase64}' | base64 -d | bash -c 'read -r -d "" TASK; bash /home/agent/run-task.sh "$TASK"'`;

  // Use a simpler approach: write task to a temp file, then execute
  const sshBase = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes agent@${ip}`;

  // Write task to file inside VM, then run
  const escapedTask = task.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  try {
    // Upload task via stdin to avoid shell escaping issues
    execSync(
      `${sshBase} 'cat > /tmp/task.txt'`,
      { input: task, stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 }
    );

    // Execute the task runner with the file
    const result = execSync(
      `${sshBase} 'bash /home/agent/run-task.sh "$(cat /tmp/task.txt)"'`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: CONTAINER_MAX_OUTPUT_SIZE }
    );
    return { stdout: result.toString(), exitCode: 0 };
  } catch (err: any) {
    if (err.killed) {
      throw new Error(`[FC] Task timed out after ${timeoutMs}ms`);
    }
    return {
      stdout: (err.stdout || '').toString() + '\n' + (err.stderr || '').toString(),
      exitCode: err.status ?? 1
    };
  }
}

function getChangedFiles(ip: string): string[] {
  const keyPath = getSSHKeyPath();
  try {
    const result = execSync(
      `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes agent@${ip} ` +
      `'cd /mnt/project 2>/dev/null && git diff --name-only 2>/dev/null || find /mnt/project -newer /tmp/task.txt -type f 2>/dev/null | head -50'`,
      { stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }
    );
    return result.toString().trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function syncFilesBack(ip: string, mounts: Mount[]): void {
  const keyPath = getSSHKeyPath();
  for (const mount of mounts) {
    if (mount.readOnly) continue;
    try {
      execSync(
        `scp -i ${keyPath} -o StrictHostKeyChecking=no -o BatchMode=yes -r ` +
        `agent@${ip}:${mount.guestPath}/. ${mount.hostPath}/`,
        { stdio: 'pipe', timeout: 60000 }
      );
      console.log(`[FC] Synced ${mount.guestPath} → ${mount.hostPath}`);
    } catch (err) {
      console.log(`[FC] Warning: Failed to sync ${mount.guestPath} back: ${err}`);
    }
  }
}

function cleanupVM(vm: MicroVM): void {
  console.log(`[FC] Cleaning up VM ${vm.vmId} (${vm.groupId})`);

  // Kill the Firecracker process
  try {
    if (vm.process && !vm.process.killed) {
      vm.process.kill('SIGKILL');
    }
  } catch { /* already dead */ }

  // Destroy TAP device
  destroyTapDevice(vm.tapDevice);

  // Delete temp rootfs
  try {
    fs.unlinkSync(vm.rootfsPath);
  } catch { /* already gone */ }

  // Delete socket
  try {
    fs.unlinkSync(vm.socketPath);
  } catch { /* already gone */ }

  // Remove from active map
  activeVMs.delete(vm.groupId);

  console.log(`[FC] VM ${vm.vmId} cleaned up`);
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Run a task inside a Firecracker microVM.
 * Each call boots a fresh VM, executes the task via Claude Code CLI,
 * captures output, syncs files back, and destroys the VM.
 */
export async function runTask(
  groupId: string,
  task: string,
  mounts: Mount[],
  claudeAuthDir: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<TaskResult> {
  const startTime = Date.now();

  // Prevent duplicate VMs for the same group
  if (activeVMs.has(groupId)) {
    console.log(`[FC] VM already running for group ${groupId}, waiting...`);
    // Wait for existing VM to finish (poll)
    while (activeVMs.has(groupId)) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  const { vmId, ip } = allocateVm(groupId);
  console.log(`[FC] Starting VM ${vmId} for group ${groupId} (${ip})`);

  let vm: MicroVM | null = null;

  try {
    // Step 1: Create TAP device
    const tapDevice = createTapDevice(vmId);

    // Step 2: Prepare rootfs (inject credentials, files, network config)
    const rootfsPath = prepareRootfs(vmId, ip, claudeAuthDir, mounts);

    // Step 3: Start Firecracker process
    const { process: fcProcess, socketPath } = startFirecrackerProcess(vmId);

    vm = {
      vmId,
      groupId,
      ip,
      tapDevice,
      rootfsPath,
      socketPath,
      process: fcProcess,
      startedAt: startTime
    };
    activeVMs.set(groupId, vm);

    // Step 4: Configure and boot the VM
    configureAndBootVM(socketPath, vmId, ip, rootfsPath, tapDevice);

    // Step 5: Wait for SSH
    console.log(`[FC] Waiting for SSH on ${ip}...`);
    waitForSSH(ip);
    const bootDuration = Date.now() - startTime;
    console.log(`[FC] VM ${vmId} booted in ${bootDuration}ms`);

    // Step 6: Execute the task via SSH
    console.log(`[FC] Dispatching task to VM ${vmId}`);
    const { stdout, exitCode } = executeTaskViaSSH(ip, task, timeoutMs);

    // Step 7: Detect changed files
    const filesChanged = getChangedFiles(ip);

    // Step 8: Sync writable mounts back to host
    syncFilesBack(ip, mounts);

    const durationMs = Date.now() - startTime;
    console.log(`[FC] VM ${vmId} task completed (exit=${exitCode}, ${durationMs}ms)`);

    return {
      output: stdout,
      filesChanged,
      exitCode,
      durationMs
    };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.log(`[FC] VM ${vmId} error: ${errorMsg}`);

    return {
      output: `Error: ${errorMsg}`,
      filesChanged: [],
      exitCode: 1,
      durationMs
    };

  } finally {
    if (vm) {
      cleanupVM(vm);
    } else {
      // Cleanup partial state if VM struct wasn't created
      destroyTapDevice(`tap${vmId}`);
      try { fs.unlinkSync(`/tmp/nanoclaw-vm-${vmId}.ext4`); } catch { /* noop */ }
      try { fs.unlinkSync(`/tmp/nanoclaw-fc-${vmId}.socket`); } catch { /* noop */ }
    }
  }
}

/**
 * Get status of all running VMs.
 */
export function getActiveVMs(): VMStatus[] {
  const now = Date.now();
  return Array.from(activeVMs.values()).map(vm => ({
    groupId: vm.groupId,
    vmId: vm.vmId,
    ip: vm.ip,
    startedAt: vm.startedAt,
    runtimeMs: now - vm.startedAt
  }));
}

/**
 * Kill a specific VM by group ID.
 */
export async function killVM(groupId: string): Promise<void> {
  const vm = activeVMs.get(groupId);
  if (vm) {
    cleanupVM(vm);
  }
}

/**
 * Clean up all running VMs (for graceful shutdown).
 */
export async function cleanupAll(): Promise<void> {
  console.log(`[FC] Cleaning up ${activeVMs.size} active VMs...`);
  for (const vm of activeVMs.values()) {
    cleanupVM(vm);
  }
  console.log('[FC] All VMs cleaned up');
}

// ── Compatibility Layer ────────────────────────────────────────────────
// These functions provide the same interface used by index.ts and
// task-scheduler.ts so the rest of the codebase requires minimal changes.

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

function getHomeDir(): string {
  const home = process.env.HOME || os.homedir();
  if (!home) {
    throw new Error('Unable to determine home directory');
  }
  return home;
}

/**
 * Build the mount list for a Firecracker VM.
 */
function buildMounts(group: RegisteredGroup, isMain: boolean): Mount[] {
  const mounts: Mount[] = [];
  const projectRoot = process.cwd();

  if (isMain) {
    // Main gets the entire project root
    mounts.push({
      hostPath: projectRoot,
      guestPath: '/mnt/project',
      readOnly: false
    });
  }

  // Group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });
  mounts.push({
    hostPath: groupDir,
    guestPath: '/workspace/group',
    readOnly: false
  });

  // Global memory (read-only for non-main)
  if (!isMain) {
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        guestPath: '/workspace/global',
        readOnly: true
      });
    }
  }

  // Additional mounts validated against allowlist
  if (group.containerConfig?.additionalMounts) {
    const validated = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain
    );
    for (const m of validated) {
      mounts.push({
        hostPath: m.hostPath,
        guestPath: m.containerPath,
        readOnly: m.readonly
      });
    }
  }

  return mounts;
}

/**
 * Run an agent task in a Firecracker microVM.
 * Compatible interface with the original runContainerAgent.
 */
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  // Build mount list
  const mounts = buildMounts(group, input.isMain);

  // Claude auth directory
  const claudeAuthDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
  fs.mkdirSync(claudeAuthDir, { recursive: true });

  const timeout = group.containerConfig?.timeout || CONTAINER_TIMEOUT;

  logger.info({
    group: group.name,
    mountCount: mounts.length,
    isMain: input.isMain
  }, 'Spawning Firecracker VM agent');

  // Write container log
  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  try {
    const result = await runTask(
      group.folder,
      input.prompt,
      mounts,
      claudeAuthDir,
      timeout
    );

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const logFile = path.join(logsDir, `firecracker-${timestamp}.log`);
    const logLines = [
      '=== Firecracker VM Run Log ===',
      `Timestamp: ${new Date().toISOString()}`,
      `Group: ${group.name}`,
      `IsMain: ${input.isMain}`,
      `Duration: ${result.durationMs}ms`,
      `Exit Code: ${result.exitCode}`,
      `Files Changed: ${result.filesChanged.join(', ') || 'none'}`,
      '',
      '=== Output ===',
      result.output.slice(-2000)
    ];
    fs.writeFileSync(logFile, logLines.join('\n'));

    if (result.exitCode !== 0 && !result.output.includes('NANOCLAW_TASK_COMPLETE')) {
      logger.error({
        group: group.name,
        exitCode: result.exitCode,
        duration: result.durationMs
      }, 'VM agent error');

      return {
        status: 'error',
        result: null,
        error: `VM exited with code ${result.exitCode}: ${result.output.slice(-200)}`
      };
    }

    // Extract the meaningful output (everything before NANOCLAW_TASK_COMPLETE marker)
    let agentOutput = result.output;
    const markerIdx = agentOutput.indexOf('NANOCLAW_TASK_COMPLETE');
    if (markerIdx !== -1) {
      agentOutput = agentOutput.slice(0, markerIdx).trim();
    }

    logger.info({
      group: group.name,
      duration: result.durationMs,
      filesChanged: result.filesChanged.length
    }, 'VM agent completed');

    return {
      status: 'success',
      result: agentOutput || null,
      // Sessions are managed by Claude Code inside the VM via the auth directory;
      // session ID continuity is handled through the .claude dir on disk
      newSessionId: input.sessionId
    };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, error: errorMsg }, 'VM agent spawn error');

    return {
      status: 'error',
      result: null,
      error: `VM error: ${errorMsg}`
    };
  }
}

// ── IPC Helpers ────────────────────────────────────────────────────────
// These write data to IPC directories for reference on the host.

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string;
    groupFolder: string;
    prompt: string;
    schedule_type: string;
    schedule_value: string;
    status: string;
    next_run: string | null;
  }>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const filteredTasks = isMain
    ? tasks
    : tasks.filter(t => t.groupFolder === groupFolder);

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2));
}

export interface AvailableGroup {
  jid: string;
  name: string;
  lastActivity: string;
  isRegistered: boolean;
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const visibleGroups = isMain ? groups : [];

  const groupsFile = path.join(groupIpcDir, 'available_groups.json');
  fs.writeFileSync(groupsFile, JSON.stringify({
    groups: visibleGroups,
    lastSync: new Date().toISOString()
  }, null, 2));
}
