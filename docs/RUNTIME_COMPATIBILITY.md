# Runtime Compatibility Matrix

NanoClaw currently ships one production runtime: tmux host sessions.

## Current Matrix

| Environment     | Status       | Notes                                                         |
| --------------- | ------------ | ------------------------------------------------------------- |
| Linux           | Supported    | Primary production target for the tmux runtime.               |
| macOS           | Supported    | Works with tmux and launchd; same host-exec model as Linux.   |
| Windows via WSL | Experimental | Feasible when tmux, Node, and service wiring live inside WSL. |
| Windows native  | Unsupported  | Current service and runtime assumptions are Unix-centric.     |

## Runtime Modes

| Runtime            | Status              | Isolation                       | Notes                                                                                                           |
| ------------------ | ------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| tmux host sessions | Production          | Host process boundary only      | Current default. Explicit mounts and credential proxy reduce blast radius, but this is not container isolation. |
| Docker sandboxes   | Historical / target | Container or micro-VM isolation | Legacy documentation remains for reference, not as the default path.                                            |
| Apple Container    | Historical / target | Container isolation             | Not the current shipped runtime.                                                                                |

## Operational Assumptions

- `tmux` must be installed and available in `PATH`.
- The service health endpoint is served on `SKILL_SERVER_PORT` and exposed at `/health`.
- Runtime smoke validation lives in `npm run smoke:runtime`.

## Preferred Long-Term Direction

NanoClaw now has a runtime adapter so future work can add:

- a true container runtime
- an Apple Container runtime
- a micro-VM-backed runtime

Until one of those ships as the default, all security and product messaging should describe the current tmux host runtime accurately.
