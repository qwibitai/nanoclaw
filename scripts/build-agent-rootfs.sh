#!/bin/bash
# build-agent-rootfs.sh — Builds the base Firecracker agent rootfs image
#
# This script creates /opt/firecracker/agent-rootfs.ext4, a minimal Ubuntu 22.04
# rootfs with Node.js, Claude Code CLI, and SSH configured for NanoClaw agent tasks.
#
# Run once on the host: sudo bash scripts/build-agent-rootfs.sh
# Requires: debootstrap, root access

set -euo pipefail

ROOTFS_PATH="/opt/firecracker/agent-rootfs.ext4"
ROOTFS_SIZE_MB=2048
MOUNT_POINT="/tmp/nanoclaw-rootfs-build"
AGENT_USER="agent"
AGENT_UID=1000

echo "=== NanoClaw Agent Rootfs Builder ==="

# Check if rootfs already exists
if [ -f "$ROOTFS_PATH" ]; then
    echo "Rootfs already exists at $ROOTFS_PATH"
    read -p "Overwrite? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Aborted."
        exit 0
    fi
fi

# Check dependencies
for cmd in debootstrap mkfs.ext4; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: $cmd is required. Install with: sudo apt install debootstrap"
        exit 1
    fi
done

echo "Creating ${ROOTFS_SIZE_MB}MB rootfs image..."

# Create output directory
sudo mkdir -p /opt/firecracker

# Create empty ext4 image
dd if=/dev/zero of="$ROOTFS_PATH" bs=1M count="$ROOTFS_SIZE_MB" status=progress
mkfs.ext4 -F "$ROOTFS_PATH"

# Mount it
mkdir -p "$MOUNT_POINT"
sudo mount -o loop "$ROOTFS_PATH" "$MOUNT_POINT"

cleanup() {
    echo "Cleaning up mount..."
    sudo umount "$MOUNT_POINT" 2>/dev/null || true
    rmdir "$MOUNT_POINT" 2>/dev/null || true
}
trap cleanup EXIT

echo "Running debootstrap (Ubuntu 22.04 jammy)..."
sudo debootstrap --include=systemd,systemd-sysv,openssh-server,sudo,curl,wget,git,jq,python3,build-essential,ca-certificates,gnupg,dbus \
    jammy "$MOUNT_POINT" http://archive.ubuntu.com/ubuntu

echo "Configuring rootfs..."

# Set hostname
echo "nanoclaw-agent" | sudo tee "$MOUNT_POINT/etc/hostname" > /dev/null

# Configure fstab
sudo bash -c "cat > $MOUNT_POINT/etc/fstab << 'EOF'
/dev/vda / ext4 defaults 0 1
EOF"

# Install Node.js 22
echo "Installing Node.js 22..."
sudo chroot "$MOUNT_POINT" bash -c '
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    node --version
    npm --version
'

# Install Claude Code CLI
echo "Installing Claude Code CLI..."
sudo chroot "$MOUNT_POINT" bash -c '
    npm install -g @anthropic-ai/claude-code
'

# Create agent user
echo "Creating agent user..."
sudo chroot "$MOUNT_POINT" bash -c "
    useradd -m -s /bin/bash -u $AGENT_UID $AGENT_USER
    echo '$AGENT_USER ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/$AGENT_USER
    chmod 440 /etc/sudoers.d/$AGENT_USER
"

# Create required directories
sudo mkdir -p "$MOUNT_POINT/mnt/project"
sudo mkdir -p "$MOUNT_POINT/tmp/output"
sudo mkdir -p "$MOUNT_POINT/workspace/group"
sudo mkdir -p "$MOUNT_POINT/workspace/global"
sudo chown -R "$AGENT_UID:$AGENT_UID" "$MOUNT_POINT/mnt/project"
sudo chown -R "$AGENT_UID:$AGENT_UID" "$MOUNT_POINT/tmp/output"
sudo chown -R "$AGENT_UID:$AGENT_UID" "$MOUNT_POINT/workspace"

# Configure SSH
echo "Configuring SSH..."
sudo bash -c "cat > $MOUNT_POINT/etc/ssh/sshd_config << 'EOF'
Port 22
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
ChallengeResponseAuthentication no
UsePAM no
X11Forwarding no
PrintMotd no
AcceptEnv LANG LC_*
Subsystem sftp /usr/lib/openssh/sftp-server
EOF"

# Ensure SSH host keys are generated on first boot
sudo chroot "$MOUNT_POINT" bash -c '
    ssh-keygen -A
'

# Create agent SSH directory
sudo mkdir -p "$MOUNT_POINT/home/$AGENT_USER/.ssh"
sudo chmod 700 "$MOUNT_POINT/home/$AGENT_USER/.ssh"
sudo chown -R "$AGENT_UID:$AGENT_UID" "$MOUNT_POINT/home/$AGENT_USER/.ssh"

# Configure systemd-networkd for eth0
echo "Configuring network..."
sudo mkdir -p "$MOUNT_POINT/etc/systemd/network"
sudo bash -c "cat > $MOUNT_POINT/etc/systemd/network/10-eth0.network << 'EOF'
[Match]
Name=eth0

[Network]
DHCP=no
EOF"

# Enable required services
sudo chroot "$MOUNT_POINT" bash -c '
    systemctl enable ssh
    systemctl enable systemd-networkd
    systemctl enable systemd-resolved
'

# Create the task runner script
echo "Creating run-task.sh..."
sudo bash -c "cat > $MOUNT_POINT/home/$AGENT_USER/run-task.sh << 'TASKEOF'
#!/bin/bash
# Runs inside the microVM. Args: \$1 = task description
set -euo pipefail
export HOME=/home/agent

# Vercel AI Gateway configuration for Claude Max subscription passthrough
export ANTHROPIC_BASE_URL=\"https://ai-gateway.vercel.sh\"

# Load the AI Gateway API key (injected during rootfs preparation)
if [ -f /home/agent/.vercel-ai-gateway-key ]; then
    export ANTHROPIC_CUSTOM_HEADERS=\"x-ai-gateway-api-key: Bearer \$(cat /home/agent/.vercel-ai-gateway-key)\"
fi

cd /mnt/project 2>/dev/null || cd /home/agent

# Run Claude Code with the task
# Claude authenticates via Max subscription (passed through Vercel AI Gateway)
claude --print --dangerously-skip-permissions \"\$1\" 2>&1 | tee /tmp/output/result.txt

echo \"NANOCLAW_TASK_COMPLETE\" > /tmp/output/status
TASKEOF"

sudo chmod +x "$MOUNT_POINT/home/$AGENT_USER/run-task.sh"
sudo chown "$AGENT_UID:$AGENT_UID" "$MOUNT_POINT/home/$AGENT_USER/run-task.sh"

# Set up DNS resolution
sudo bash -c "echo 'nameserver 8.8.8.8' > $MOUNT_POINT/etc/resolv.conf"

# Enable auto-login for agent (console access for debugging)
sudo mkdir -p "$MOUNT_POINT/etc/systemd/system/serial-getty@ttyS0.service.d"
sudo bash -c "cat > $MOUNT_POINT/etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin agent -o '-p -f agent' --keep-baud 115200,57600,38400,9600 %I \$TERM
EOF"

# Clean up apt cache to save space
sudo chroot "$MOUNT_POINT" bash -c '
    apt-get clean
    rm -rf /var/lib/apt/lists/*
    rm -rf /tmp/*
'

echo ""
echo "=== Rootfs build complete ==="
echo "Image: $ROOTFS_PATH"
echo "Size: $(du -h "$ROOTFS_PATH" | cut -f1)"
echo ""
echo "To rebuild: sudo bash scripts/build-agent-rootfs.sh"
