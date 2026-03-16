# NanoClaw Security Model

## Trust Model

| Entity            | Trust Level | Rationale                        |
| ----------------- | ----------- | -------------------------------- |
| Main group        | Trusted     | Private self-chat, admin control |
| Non-main groups   | Untrusted   | Other users may be malicious     |
| Container agents  | Sandboxed   | Isolated execution environment   |
| WhatsApp messages | User input  | Potential prompt injection       |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in containers (lightweight Linux VMs), providing:

- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

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
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

**Read-Only Project Root:**

The main group's project root is mounted read-only. Writable paths the agent needs (group folder, IPC, `.claude/`) are mounted separately. This prevents the agent from modifying host application code (`src/`, `dist/`, `package.json`, etc.) which would bypass the sandbox entirely on next restart.

### 3. Session Isolation

Each group has isolated sessions at `data/sessions/{group}/.claude/`:

- Groups cannot see other groups' conversation history
- Session data includes full message history and file contents read
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation                   | Main Group | Non-Main Group |
| --------------------------- | ---------- | -------------- |
| Send message to own chat    | ✓          | ✓              |
| Send message to other chats | ✓          | ✗              |
| Schedule task for self      | ✓          | ✓              |
| Schedule task for others    | ✓          | ✗              |
| View all tasks              | ✓          | Own only       |
| Manage other groups         | ✓          | ✗              |

### 5. LLM Credential Handling

**Note:** The Anthropic credential proxy was removed in the OpenCode migration. LLM credentials are now passed directly to containers.

**Current Model:**

1. **Configuration via environment**: LLM endpoint and credentials are passed via `NANOCLAW_LLM_CONFIG` (JSON) or individual env vars
2. **Container scope**: Credentials exist only in container environment during execution
3. **SDK-managed**: OpenCode SDK (not agent code) handles credential usage
4. **Ephemeral**: Containers are destroyed after each request; credentials don't persist on disk

**Security considerations:**

- Credentials are visible in container environment (unlike the previous proxy model)
- However, agent code still cannot directly access credentials used by OpenCode SDK
- For cloud providers with sensitive API keys, consider using local LLMs (LM Studio, Ollama) instead
- Containers run with restricted filesystem access — agent code cannot read `/proc` or environment dumps

**NOT Mounted:**

- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns
- `.env` is shadowed with `/dev/null` in the project root mount

## Privilege Comparison

| Capability          | Main Group                | Non-Main Group           |
| ------------------- | ------------------------- | ------------------------ |
| Project root access | `/workspace/project` (ro) | None                     |
| Group folder        | `/workspace/group` (rw)   | `/workspace/group` (rw)  |
| Global memory       | Implicit via project      | `/workspace/global` (ro) |
| Additional mounts   | Configurable              | Read-only unless allowed |
| Network access      | Unrestricted              | Unrestricted             |
| MCP tools           | All                       | All                      |

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
│  • Container lifecycle                                            │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only, no secrets
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • LLM API calls (via OpenCode SDK)                              │
│  • Credentials passed via environment (ephemeral)                │
└──────────────────────────────────────────────────────────────────┘
```
