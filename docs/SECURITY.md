# NanoClaw Security Model

## Current Reality

NanoClaw currently runs agent work in tmux sessions on the host.

That means:

- the default runtime is **not** container-isolated
- bash and CLI tools run on the host inside a controlled working context
- the main security controls are mount scoping, privilege checks, sender allowlists, credential proxying, and minimal admin surfaces

If you need true container or micro-VM isolation, treat that as future runtime work rather than assuming it exists today.

## Trust Model

| Entity              | Trust level           | Rationale                                                      |
| ------------------- | --------------------- | -------------------------------------------------------------- |
| Main group          | Trusted               | Private admin surface with elevated control paths              |
| Non-main groups     | Untrusted             | Other users may be malicious or prompt-injecting               |
| tmux agent sessions | Semi-trusted          | Constrained by mounts and runtime wiring, but still host-exec  |
| Credential proxy    | Trusted               | Holds or fetches real API credentials on the host              |
| Host exec watcher   | Trusted admin surface | Narrow allowlist only; should not be treated as a general tool |

## Primary Boundaries

### 1. Explicit Mount Boundaries

Agents only receive paths NanoClaw mounts for them.

- Main-group project root is mounted read-only.
- Group folders are writable only for that group.
- Shared global context is mounted read-only.
- Additional mounts must pass allowlist validation.

### 2. Mount Allowlist

Mount permissions live outside the repo at `~/.config/nanoclaw/mount-allowlist.json`.

That file is:

- outside project control
- never mounted into agent sessions
- validated before every additional mount is accepted

Blocked patterns still include common credential and secret locations such as `.ssh`, `.aws`, `.env`, and private key filenames.

### 3. Per-Group Session Isolation

Each group has isolated Claude session state in `data/sessions/{group}/.claude/`.

- Groups do not share conversation history.
- Session archival for `/clear` happens on the host.
- Group IPC namespaces are separate.

### 4. Authorization And Admin Boundaries

IPC commands are checked against the source group and privilege level.

| Operation                       | Main group            | Non-main group |
| ------------------------------- | --------------------- | -------------- |
| Send to own chat                | Yes                   | Yes            |
| Send to another chat            | Yes                   | No             |
| Schedule task for self          | Yes                   | Yes            |
| Schedule task for another group | Yes                   | No             |
| Register groups                 | Yes                   | No             |
| Reload service                  | Main or ops path only | No             |

## Credential Proxy Model

Real Anthropic credentials stay on the host.

### How it works

1. NanoClaw starts a local HTTP proxy on `CREDENTIAL_PROXY_PORT`.
2. Agent sessions receive `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` plus a placeholder auth value.
3. The SDK talks to the local proxy.
4. The proxy injects the real API key or OAuth token at request time.
5. Agent sessions never receive the real credential in mounted files or runtime env.

### Secret sources

- `.env`
- Solo Vault, when configured

## Host-Exec Threat Model

NanoClaw includes an allowlisted host-exec path for narrowly scoped administrative commands.

That path should be treated as sensitive because it is one of the few places where NanoClaw intentionally crosses from the agent session boundary back into privileged host operations.

Current safety properties:

- command allowlist
- subcommand restrictions for sensitive tools like `git`
- dedicated watcher instead of broad shell passthrough

Current limitations:

- this is still host execution
- mistakes in the allowlist are high-impact
- operators should audit changes to host-exec rules carefully

## What This Model Does Not Claim

NanoClaw does **not** currently claim:

- container isolation by default
- micro-VM isolation by default
- safe arbitrary host shell access for untrusted groups
- protection against every prompt-injection or tool-misuse scenario

## Practical Guidance

- Keep mounts minimal.
- Treat non-main groups as untrusted.
- Review host-exec changes like security-sensitive code.
- Use `/health` and the runtime smoke scripts after deploys.
- Prefer skills for optional integrations instead of widening core privileges.
