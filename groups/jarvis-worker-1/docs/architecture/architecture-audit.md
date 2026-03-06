 Priority Report (Apple Container-First Audit)

  ### P0 (Fix Immediately)

  1. Secret blast radius: untrusted non-main groups can receive and exfiltrate GitHub token
     Evidence: docs/reference/SECURITY.md:8, src/container-runner.ts:475, container/agent-runner/src/index.ts:441, container/agent-runner/src/index.ts:456, container/agent-runner/src/index.ts:197
     Why this is critical: trust model marks non-main groups as untrusted, but non-worker groups currently get GITHUB_TOKEN; agent lane has Bash + web tools + bypassed permissions, and Bash sanitization only unsets Anthropic/Claude tokens, not GitHub token.
     Benefit after fix: closes highest-impact repo/account compromise path and reduces credential leakage risk massively.
     Owner lens: Security Architect + Agent Runtime/MCP Architect.
  2. Silent message loss risk from timestamp-only cursor semantics
     Evidence: src/channels/whatsapp.ts:156, src/db.ts:319, src/db.ts:346, src/index.ts:425, src/index.ts:466
     Why this is critical: message timestamp is second-based from WhatsApp; queries use timestamp > cursor, and cursor advances to max timestamp. Messages arriving later with same timestamp can be skipped permanently.
     Benefit after fix: eliminates silent drops and stabilizes correctness of chat processing.
     Owner lens: Data Engineer + Messaging Protocol Engineer.

  ———

  ### P1 (Next Sprint)

  1. Retry exhaustion drops work until a future inbound message re-triggers processing
     Evidence: src/group-queue.ts:249, src/group-queue.ts:254, src/group-queue.test.ts:185
     Benefit: fewer “stuck” conversations, lower MTTR, predictable recovery.
  2. Outgoing WhatsApp queue is in-memory only
     Evidence: src/channels/whatsapp.ts:36, src/channels/whatsapp.ts:214, src/channels/whatsapp.ts:319
     Benefit: durable user response delivery across process crash/restart/disconnect.
  3. Agent runner always uses bypass permissions
     Evidence: container/agent-runner/src/index.ts:456, container/agent-runner/src/index.ts:457
     Benefit: reduces accidental/tool misuse blast radius and improves least-privilege posture.
  4. Main lane has read-write project-root mount
     Evidence: src/container-runner.ts:266, src/container-runner.ts:269, docs/reference/SECURITY.md:85
     Benefit: hardens host repo/config integrity against prompt-injection or accidental destructive edits.
  5. Browser-testing gate is policy-first, not enforced by code contract
     Evidence: container/rules/andy-developer-operating-rule.md:15, container/rules/jarvis-worker-operating-rule.md:10, src/dispatch-validator.ts:21, src/dispatch-validator.ts:31
     Benefit: prevents false-positive “tested” handoffs and improves fix accuracy before user QA.

  ———

  ### P2 (Planned Hardening)

  1. No explicit CPU/memory limits on spawned Apple containers
     Evidence: src/container-runner.ts:479
     Benefit: better host stability under runaway tasks; fewer resource-starvation incidents.
  2. Task snapshot does O(total_tasks) writes every run
     Evidence: src/index.ts:336, src/task-scheduler.ts:69
     Benefit: lower startup latency and better scale as scheduled tasks grow.
  3. Container-side runtimes are under-tested compared to host-side code
     Evidence: vitest.config.ts:5
     Benefit: catches regressions in agent/worker runtime contracts before runtime failures.
  4. Docs/runtime drift in operational guidance
     Evidence: docs/operations/roles-classification.md:23, docs/reference/SECURITY.md:74, docs/troubleshooting/APPLE-CONTAINER-NETWORKING.md:39
     Benefit: fewer operator mistakes and less confusion during incidents.
  5. Baileys auth store strategy uses useMultiFileAuthState
     Evidence: src/channels/whatsapp.ts:10, src/channels/whatsapp.ts:56
     Benefit: more robust long-term auth-state durability/performance (especially with frequent key updates).

  ———

  ## Architecture Strengths

  1. Strong per-group isolation model with explicit mounts and separate session/IPC directories: src/container-runner.ts:255, src/container-runner.ts:375.
  4. Queue architecture is clear and operationally understandable; supports global concurrency and task/message sequencing: src/group-queue.ts:71, src/group-queue.ts:298.
  5. Streaming container output contract with markers and timeout controls is solid: src/container-runner.ts:603, src/container-runner.ts:682.
  6. Worker/agent lane split is clear and deterministic in runtime contract: container/worker/runner/src/index.ts:9, container/agent-runner/src/index.ts:430.
  7. Test baseline is strong for host code and skills engine (359 tests passing in this run): vitest.config.ts:5.

  ———
  2. P0 cursor refactor: move from timestamp cursors to monotonic ingest_seq cursors globally and per-group.
  3. P1 reliability: durable outgoing queue + retry/dead-letter strategy for max-retry exhaustion.
  4. P1 enforcement: extend dispatch/completion schema to require browser evidence fields and reject missing evidence automatically.
  5. P2 ops hardening: add container resource limits and automated preflight checks for Apple container networking/runtime assumptions.

  ———

  ## External References Used

  - Docker resource constraints: https://docs.docker.com/engine/containers/resource_constraints/
  - Docker read-only container patterns: https://docs.docker.com/engine/security/
  - SQLite WAL: https://sqlite.org/wal.html
  - SQLite busy_timeout pragma: https://sqlite.org/pragma.html#pragma_busy_timeout
  - Vitest test.include behavior: https://vitest.dev/config/include
  - Baileys README (useMultiFileAuthState caveat): https://github.com/WhiskeySockets/Baileys/blob/master/README.md
  - DeepWiki repo architecture index: https://deepwiki.com/qwibitai/nanoclaw