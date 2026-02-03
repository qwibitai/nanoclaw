# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process that connects to WhatsApp, routes messages to Claude Code CLI running in Firecracker microVMs (each with its own Linux kernel). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main app: WhatsApp connection, message routing, IPC |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/firecracker-runner.ts` | Spawns Firecracker microVMs, manages lifecycle |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `src/mount-security.ts` | Validates mounts against allowlist |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |

## Architecture

```
WhatsApp (Baileys) → SQLite → Polling Loop → Firecracker microVM (Claude Code CLI) → Response
```

Each task boots a fresh microVM on the `fcbr0` bridge (172.16.0.0/24), runs Claude Code via SSH, syncs files back, and destroys the VM. VMs authenticate to Anthropic API via Vercel AI Gateway.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/build-agent-rootfs.sh` | Builds the base Firecracker rootfs image |
| `scripts/setup-firecracker-networking.sh` | Configures bridge + NAT for VM networking |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | VM issues, logs, troubleshooting |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev            # Run with hot reload
npm run build          # Compile TypeScript
npm run build-rootfs   # Rebuild agent rootfs image
npm run setup-network  # Configure Firecracker networking
```

## Target Environment

- Ubuntu Server 24.04 (Intel x86_64)
- Firecracker v1.7.0 at `/usr/local/bin/firecracker`
- Kernel at `/opt/firecracker/vmlinux.bin`
- Rootfs at `/opt/firecracker/agent-rootfs.ext4`
- Network bridge: `fcbr0` at `172.16.0.1/24`
