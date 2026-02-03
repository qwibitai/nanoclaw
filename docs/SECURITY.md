# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Firecracker VM agents | Sandboxed | Isolated execution environment (own kernel) |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Firecracker MicroVM Isolation (Primary Boundary)

Agents execute in Firecracker microVMs (each with its own Linux kernel), providing:
- **Kernel isolation** - Each VM has its own kernel, isolated at the hypervisor level via KVM
- **Process isolation** - VM processes cannot affect the host
- **Filesystem isolation** - Files are copied into the VM rootfs, not live-mounted
- **Non-root execution** - Runs as unprivileged `agent` user (uid 1000)
- **Ephemeral VMs** - Fresh VM per invocation, destroyed after task completion
- **Network isolation** - VMs on private bridge (172.16.0.0/24) with NAT

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's copied into the rootfs. This provides stronger isolation than Docker (which shares the host kernel).

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Guest path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated Claude sessions at `data/sessions/{group}/.claude/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Injected into VM rootfs:**
- Claude session credentials (from `data/sessions/{group}/.claude/`)
- Vercel AI Gateway API key (from `.env`)

**NOT accessible to VMs:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never copied into VMs
- Any credentials matching blocked patterns

> **Note:** Claude credentials are copied into the VM rootfs so that Claude Code can authenticate when the agent runs. This means the agent can discover these credentials via Bash or file operations inside the VM. However, the ephemeral nature of VMs limits exposure — credentials are destroyed with the VM after task completion.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • VM lifecycle (Firecracker microVMs)                             │
│  • Credential injection into rootfs                               │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│              FIRECRACKER microVM (ISOLATED/SANDBOXED)             │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
