# Issue #414: Linux stale docker group detected but not remediated

## Summary
On Linux, when a user is added to the `docker` group during setup, the running systemd user session keeps the old group list from login time. The setup flow correctly detects this with `checkDockerGroupStale()`, but only logs a warning and continues to start the service. The service then fails to access Docker.

## Reproduction
1. Start from a fresh Linux server where Docker was not previously installed.
2. Install Docker and add the current user to the `docker` group (during setup or manually).
3. Without logging out or rebooting, run `/setup`.
4. Setup detects stale group (`DOCKER_GROUP_STALE: true`), warns, then starts the service.
5. Service fails to connect to Docker socket.

## Expected Behavior
When stale Docker group membership is detected, setup should remediate before start, or clearly stop and instruct the user how to proceed.

## Actual Behavior
`checkDockerGroupStale()` returns `true`, a `logger.warn()` is emitted (not user-visible), and service start still proceeds and fails.

## Relevant Code
- `setup/service.ts` around lines 171-187: stale group detection (`checkDockerGroupStale()`)
- `setup/service.ts` around lines 236-242: warning-only behavior before service start

## Proposed Fix (Priority Order)
1. Socket ACL drop-in (preferred)
   - Create `/etc/systemd/system/docker.service.d/socket-acl.conf`:
     ```ini
     [Service]
     ExecStartPost=/usr/bin/setfacl -m u:USERNAME:rw /var/run/docker.sock
     ```
   - This survives Docker restarts and applies automatically when Docker starts.
2. User relogin fallback
   - If ACL path is not possible, stop setup start flow and prompt user to log out/back in, then re-run setup.
3. Minimum guardrail
   - Make stale group warning user-visible and block service start while stale state is known.

## Additional Required Change
Run `killOrphanedProcesses()` before any service start attempt to clean up zombie Node processes that can trigger WhatsApp conflict/disconnect loops.

## Suggested Implementation Plan
1. In setup start flow, move `killOrphanedProcesses()` to execute before any start attempt.
2. If `DOCKER_GROUP_STALE` is `true`, branch into remediation flow instead of warning-only.
3. Try ACL remediation first (single sudo command / drop-in).
4. Re-check Docker access after remediation.
5. If still stale or inaccessible, stop with explicit user instructions and non-zero exit.
6. Add user-facing output (not log-only) for stale group state and next steps.

## Acceptance Criteria
- Setup does not start service when stale docker group is detected without remediation.
- User gets clear terminal guidance when manual relogin is required.
- On systems where ACL remediation is applied, service starts successfully without relogin.
- Orphaned process cleanup runs before every start attempt.
