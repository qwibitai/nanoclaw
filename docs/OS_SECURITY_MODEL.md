# NanoClaw OS — Security Model

## Trust Model

| Entity | Trust Level | Access |
|--------|------------|--------|
| Host process | Full | DB, secrets, file system, network |
| Container (agent) | Sandboxed | Read-only code, writable group dir, IPC only |
| Main group | Administrative | Create tasks, grant capabilities, manage products |
| Developer group | Operational | Execute assigned tasks, product-scoped ext access |
| Security group | Audit | Gate approvals, read-only ext access |

## Container Isolation

- Apple Container Linux VMs — full process isolation
- No direct access to host secrets, DB, or network
- Read-only code mount (immutable agent code)
- Per-group writable data mount (session persistence)
- IPC via file-based protocol (no TCP/HTTP)

## Governance Security

### Separation of Powers
- **Approver != Executor**: `checkApproverNotExecutor()` enforced at gate approval time
- **Gate→Group mapping**: Only authorized groups can approve specific gates
- **Two-man rule (L3)**: Deploy actions require 2+ approvals from different groups

### State Machine Integrity
- **Optimistic locking**: Version field prevents concurrent stale writes
- **Strict mode** (`GOV_STRICT=1`): Enforces review summary for DOING→REVIEW
- **Policy version tracking**: Stored on every task and ext_call for forensic audit

### Product Isolation
- PRODUCT-scoped tasks require capability with matching `product_id`
- Non-main groups cannot use company-wide capabilities for product tasks
- Cross-product access denied: cap for product A cannot be used on product B task
- Main group override: allowed but logged for audit

## External Access Security

### HMAC & Signing
- **Params hash**: HMAC-SHA256 of validated parameters (never raw secrets in audit)
- **Request signing**: Per-group `.ipc_secret`, HMAC over request body
- **Fail-closed**: `EXT_REQUIRE_SIGNING=1` denies unsigned requests

### Access Control
- **Deny-wins**: `denied_actions` checked before `allowed_actions`
- **Mandatory expiry**: L2/L3 capabilities auto-expire in 7 days
- **Backpressure**: Max pending calls per group (default 5), fail-closed with BUSY

### Inflight Protection
- **Processing lock**: INSERT with status='processing' (UNIQUE request_id prevents double-exec)
- **Idempotency**: `idempotency_key` returns cached response for duplicate writes

## Audit Trail

- **gov_activities**: Append-only log of all governance actions (transitions, approvals, evidence)
- **ext_calls**: Full audit of every external access attempt (including denied calls)
- **Policy version**: Tracked on every record for forensic context
- **No PII in params**: HMAC hash stored instead of raw parameters

## Credential Handling

- Secrets stored in host `.env` file only
- Never mounted into containers
- Provider secrets read once at startup (`GITHUB_TOKEN`, `EXT_CALL_HMAC_SECRET`)
- Sanitized backup strips all secret values
