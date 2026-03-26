# Docker to BoxLite Migration Plan

## Context

AgentLite previously used Docker to run agent containers via `spawn('docker', ['run', ...])`. This document describes the migration to BoxLite (`@boxlite-ai/boxlite`), an embedded VM runtime library.

**Why BoxLite?**
- **Embedded library** (no daemon) vs Docker's client-server model
- **Hardware-level VM isolation** (KVM on Linux, Hypervisor.framework on macOS) vs container namespaces
- **No root required** — macOS has built-in Hypervisor.framework; Linux only needs `/dev/kvm` group
- **OCI-compatible** — uses standard Docker Hub images (node:22-slim, etc.)
- **Stateful boxes** — persist state across stop/restart

**Key discovery**: BoxLite's low-level `JsBox.exec()` returns a `JsExecution` object with streaming `.stdin()`, `.stdout()`, `.stderr()` methods. This means the agent-runner's stdin/stdout marker protocol stays entirely unchanged — we just pipe data through BoxLite's streaming API instead of Docker's ChildProcess stdio.

---

## Architecture

### Low-level API: JsBoxlite -> JsBox -> JsExecution

```
JsBoxlite (runtime singleton)
  |-- .create(opts, name) -> JsBox
  |-- .getOrCreate(opts, name) -> { box: JsBox, created: boolean }
  |-- .listInfo() -> JsBoxInfo[]
  |-- .remove(name, force) -> void
  '-- .shutdown(timeout) -> void

JsBox (VM handle)
  |-- .exec(cmd, args, env, tty, user, timeout, cwd) -> JsExecution
  |-- .stop() -> void
  |-- .start() -> void
  |-- .copyIn(host, guest, opts) -> void
  |-- .copyOut(guest, host, opts) -> void
  |-- .snapshot -> JsSnapshotHandle
  '-- .info() -> JsBoxInfo

JsExecution (running command)
  |-- .stdin() -> JsExecStdin { write(), writeString(), close() }
  |-- .stdout() -> JsExecStdout { next() -> line | null }
  |-- .stderr() -> JsExecStderr { next() -> line | null }
  |-- .wait() -> JsExecResult { exitCode }
  |-- .kill() -> void
  '-- .signal(sig) -> void
```

---

## Call Graph: Before (Docker) vs After (BoxLite)

### BEFORE -- Docker CLI Process Spawning

```
+- HOST PROCESS (Node.js) -------------------------------------------------------+
|                                                                                 |
|  src/index.ts                                                                   |
|    |                                                                            |
|    |-> ensureContainerRuntimeRunning()  [container-runtime.ts]                  |
|    |     '-> execSync('docker info')  <-- CHANGE: remove                        |
|    |                                                                            |
|    |-> cleanupOrphans()  [container-runtime.ts]                                 |
|    |     |-> execSync('docker ps --filter name=agentlite-')  <-- CHANGE          |
|    |     '-> execSync('docker stop -t 1 {name}')  <-- CHANGE                   |
|    |                                                                            |
|    '-> processMessages() -> runContainerAgent()  [container-runner.ts]          |
|          |                                                                      |
|          |-> buildVolumeMounts(group, isMain)                                   |
|          |     '-> returns VolumeMount[]  (hostPath, containerPath, readonly)   |
|          |         <-- CHANGE: containerPath -> guestPath                       |
|          |                                                                      |
|          |-> buildContainerArgs(mounts, name, agent)                            |
|          |     |-> onecli.applyContainerConfig(args)  <-- CHANGE: extract env   |
|          |     |-> hostGatewayArgs()  <-- CHANGE: remove (not needed)           |
|          |     |-> readonlyMountArgs()  <-- CHANGE: remove                      |
|          |     '-> returns ['run','-i','--rm','--name',...,'-v',...,image]       |
|          |         <-- CHANGE: replace with JsBoxOptions                        |
|          |                                                                      |
|          |-> spawn('docker', containerArgs)  <-- CHANGE: runtime.create()       |
|          |     '-> returns ChildProcess  <-- CHANGE: returns JsBox              |
|          |                                                                      |
|          |-> container.stdin.write(JSON.stringify(input))  <-- CHANGE           |
|          |     <-- CHANGE: execution.stdin().writeString() instead              |
|          |                                                                      |
|          |-> container.stdout.on('data', parseMarkers)  <-- CHANGE              |
|          |     |-> find OUTPUT_START_MARKER / OUTPUT_END_MARKER                 |
|          |     |-> JSON.parse(between markers)                                  |
|          |     '-> onOutput(parsed)                                             |
|          |     <-- CHANGE: execution.stdout().next() loop instead               |
|          |     (same marker parsing logic, different read API)                  |
|          |                                                                      |
|          |-> setTimeout(killOnTimeout)                                          |
|          |     '-> exec('docker stop -t 1 {name}')  <-- CHANGE: box.stop()     |
|          |                                                                      |
|          '-> container.on('close', handleExit)                                  |
|                <-- CHANGE: await execution.wait()                               |
|                                                                                 |
|  src/group-queue.ts                                                             |
|    |-> registerProcess(jid, ChildProcess, name)  <-- CHANGE: boxName            |
|    '-> shutdown() -> checks process.killed  <-- CHANGE: check boxName           |
|                                                                                 |
|  setup/environment.ts                                                           |
|    '-> commandExists('docker') + execSync('docker info')  <-- CHANGE           |
|                                                                                 |
|  setup/container.ts                                                             |
|    '-> execSync('docker build ...') + execSync('docker run ...')  <-- CHANGE    |
|                                                                                 |
|  setup/service.ts                                                               |
|    '-> checkDockerGroupStale() -> execSync('docker info')  <-- CHANGE: remove   |
|                                                                                 |
+---------------------------------------------------------------------------------+

+- DOCKER DAEMON ----------------------------------------------------------------+
|  Receives CLI commands via socket, manages container lifecycle   <-- REMOVED    |
+---------------------------------------------------------------------------------+

+- CONTAINER (from Dockerfile) --------------------------------------------------+
|                                                                                 |
|  Entrypoint:  <-- CHANGE: no Dockerfile, provisioning via provision.sh          |
|    cd /app && npx tsc --outDir /tmp/dist                                        |
|    node /tmp/dist/index.js < /tmp/input.json                                    |
|                                                                                 |
|  container/agent-runner/src/index.ts  -- UNCHANGED                              |
|    |-> readStdin()  -- UNCHANGED (BoxLite pipes stdin transparently)             |
|    |-> runQuery() -> query(SDK)                                                 |
|    |     '-> on result -> writeOutput()  -- UNCHANGED                           |
|    |           |-> console.log(OUTPUT_START_MARKER)                              |
|    |           |-> console.log(JSON.stringify(output))                           |
|    |           '-> console.log(OUTPUT_END_MARKER)                               |
|    |-> waitForIpcMessage()  (polls ipc/input/)  -- UNCHANGED                    |
|    '-> shouldClose()  (checks ipc/input/_close)  -- UNCHANGED                   |
|                                                                                 |
+---------------------------------------------------------------------------------+
```

### AFTER -- BoxLite Embedded Library

```
+- HOST PROCESS (Node.js) -------------------------------------------------------+
|                                                                                 |
|  src/index.ts                                                                   |
|    |                                                                            |
|    |-> ensureRuntimeReady()  [box-runtime.ts]  * NEW                            |
|    |     '-> JsBoxlite.withDefaultConfig() -> JsBoxlite singleton               |
|    |                                                                            |
|    |-> cleanupOrphans()  [box-runtime.ts]  * REWRITTEN                          |
|    |     |-> runtime.listInfo() -> JsBoxInfo[] -> filter agentlite-* names       |
|    |     '-> runtime.remove(name, true)                                         |
|    |                                                                            |
|    '-> processMessages() -> runContainerAgent()  [container-runner.ts]          |
|          |                                                                      |
|          |-> buildVolumeMounts(group, isMain)  * MODIFIED                       |
|          |     '-> returns [{ hostPath, guestPath, readOnly }]                  |
|          |                                                                      |
|          |-> extractOnecliEnv(agentIdentifier)  * NEW                           |
|          |     |-> onecli.applyContainerConfig(tempArgs)                        |
|          |     '-> parse -e KEY=VALUE -> Record<string,string>                  |
|          |                                                                      |
|          |-> runtime.create({  * REPLACES spawn('docker')                       |
|          |     image, volumes, env, memoryMib, cpus,                            |
|          |     autoRemove, workingDir, user                                     |
|          |   }, containerName) -> JsBox                                         |
|          |                                                                      |
|          |-> if first run -> box.exec('bash', ['provision.sh']).wait()           |
|          |     * REPLACES Dockerfile RUN commands                               |
|          |                                                                      |
|          |-> box.exec('bash', ['-c', 'compile && run'], env, ...)               |
|          |     * REPLACES spawn('docker') -- returns JsExecution handle          |
|          |                                                                      |
|          |-> execution.stdin().writeString(JSON.stringify(input))                |
|          |     * REPLACES container.stdin.write() -- same data, new API         |
|          |     '-> execution.stdin().close()  // signal EOF                     |
|          |                                                                      |
|          |-> execution.stdout().next() loop  (line-by-line streaming)           |
|          |     * REPLACES container.stdout.on('data')                           |
|          |     |-> same OUTPUT_START/END marker parsing                         |
|          |     |-> JSON.parse(between markers)                                  |
|          |     '-> onOutput(parsed) -> delivers to user                         |
|          |                                                                      |
|          |-> execution.stderr().next() loop  (parallel, for logging)            |
|          |     * REPLACES container.stderr.on('data')                           |
|          |                                                                      |
|          |-> timeout: box.stop()  * REPLACES exec('docker stop')                |
|          |                                                                      |
|          '-> execution.wait() -> ExecResult, return ContainerOutput             |
|                                                                                 |
|  src/group-queue.ts  * MODIFIED                                                 |
|    |-> registerBox(jid, boxName, groupFolder)                                   |
|    '-> shutdown() -> logs active boxNames                                       |
|                                                                                 |
|  setup/environment.ts  * REWRITTEN                                              |
|    '-> try { JsBoxlite.withDefaultConfig() } -> 'available' | 'not_found'      |
|                                                                                 |
|  setup/container.ts  * REWRITTEN                                                |
|    '-> create test box, run provision.sh, verify, remove                        |
|                                                                                 |
|  setup/service.ts  * SIMPLIFIED                                                 |
|    '-> (Docker group check removed -- BoxLite needs no daemon/group)            |
|                                                                                 |
+---------------------------------------------------------------------------------+

       | Direct library calls (no daemon, no socket, no CLI)
       v

+- BOXLITE RUNTIME (embedded, in-process) --------------------------------------+
|  JsBoxlite -> manages VM lifecycle                                              |
|  JsBox -> per-group VM with OCI rootfs                                          |
|  KVM (Linux) / Hypervisor.framework (macOS) -> hardware isolation               |
+---------------------------------------------------------------------------------+

       | VM with OCI rootfs (node:22-slim)
       v

+- BOX (VM, provisioned from node:22-slim + provision.sh) ----------------------+
|                                                                                 |
|  Entrypoint (via box.exec):                                                     |
|    cd /app && npx tsc --outDir /tmp/dist                                        |
|    node /tmp/dist/index.js                                                      |
|                                                                                 |
|  container/agent-runner/src/index.ts  -- ENTIRELY UNCHANGED                     |
|    |-> readStdin()  -- same (BoxLite pipes stdin via execution.stdin())          |
|    |-> runQuery() -> query(SDK)                                                 |
|    |     '-> on result -> writeOutput()  -- same stdout markers                 |
|    |           |-> console.log(OUTPUT_START_MARKER)                              |
|    |           |-> console.log(JSON.stringify(output))                           |
|    |           '-> console.log(OUTPUT_END_MARKER)                               |
|    |           (host reads via execution.stdout().next() loop)                  |
|    |-> waitForIpcMessage()  (polls ipc/input/)  -- UNCHANGED                    |
|    '-> shouldClose()  (checks ipc/input/_close)  -- UNCHANGED                   |
|                                                                                 |
+---------------------------------------------------------------------------------+
```

### Data Flow Comparison

```
BEFORE (Docker):
  Host --container.stdin.write()--> Docker Process --stdout markers--> Host parses on('data')
                                    |                                    |
                                    '-- ipc/input/ (follow-ups) <-------'

AFTER (BoxLite):                     Same protocol, different transport
  Host --execution.stdin.writeString()--> Box VM --stdout markers--> Host reads stdout.next()
                                          |                            |
                                          '-- ipc/input/ (follow-ups) <'
```

---

## Summary of Changes

| Component | Before (Docker) | After (BoxLite) |
|-----------|-----------------|-----------------|
| Runtime check | `execSync('docker info')` | `JsBoxlite.withDefaultConfig()` |
| Orphan cleanup | `docker ps` + `docker stop` | `runtime.listInfo()` + `runtime.remove()` |
| Container create | `spawn('docker', ['run',...])` | `runtime.create(opts, name) -> JsBox` |
| Image setup | `Dockerfile` + `docker build` | `provision.sh` + `box.exec()` on first run |
| Input delivery | `container.stdin.write()` | `execution.stdin().writeString()` |
| Output streaming | `stdout.on('data')` + marker parsing | `stdout.next()` loop + same marker parsing |
| Stop/kill | `docker stop -t 1` | `box.stop()` |
| Process tracking | `ChildProcess` in GroupQueue | `boxName: string` in GroupQueue |
| Env injection | OneCLI mutates docker args | OneCLI -> parse `-e` flags -> box env |
| Host gateway | `--add-host=host.docker.internal` | Not needed (BoxLite handles networking) |
| Volume syntax | `-v host:container:ro` | `{ hostPath, guestPath, readOnly }` |
| User mapping | `--user ${uid}:${gid}` | `user: '${uid}:${gid}'` in box opts |

---

## Provisioning (replaces Dockerfile)

On first box creation, `container/provision.sh` runs inside the box to install:
- System packages: chromium, fonts (CJK, emoji), curl, git, X11 libs
- Node.js globals: `agent-browser`, `@anthropic-ai/claude-code`
- Directory structure: `/workspace/{group,global,extra,ipc/}`

Subsequent runs reuse the provisioned box state (BoxLite boxes are stateful).

---

## IPC Protocol (unchanged)

The agent-runner communicates via:

- **Stdin**: Initial `ContainerInput` JSON (prompt, sessionId, groupFolder, etc.)
- **Stdout**: Results wrapped in `---AGENTLITE_OUTPUT_START---` / `---AGENTLITE_OUTPUT_END---` markers
- **IPC files** (`/workspace/ipc/input/`): Follow-up messages as JSON files, `_close` sentinel for shutdown
- **IPC files** (`/workspace/ipc/`): Task snapshots, group lists, outbound messages

---

## Volume Mounts (unchanged logic)

Per-group isolation model:
- **Main group**: Read-only project root (`/workspace/project`), writable group folder
- **Other groups**: Own folder only + read-only global memory
- **Per-group sessions**: Isolated `.claude/` in `data/sessions/{group}/`
- **Per-group IPC**: Isolated `data/ipc/{group}/`
- **Agent-runner source**: Per-group copy in `data/sessions/{group}/agent-runner-src/`
- **Additional mounts**: Validated against external allowlist

---

## OneCLI Credential Injection

OneCLI gateway handles credential injection. Previously mutated Docker CLI args (`-e KEY=VALUE`).
Now: extract env vars from the mutated args array and pass as `JsEnvVar[]` to `runtime.create()`.

```typescript
async function extractOnecliEnv(agentIdentifier?: string): Promise<Record<string, string>> {
  const tempArgs: string[] = [];
  await onecli.applyContainerConfig(tempArgs, { addHostMapping: false, agent: agentIdentifier });
  const env: Record<string, string> = {};
  for (let i = 0; i < tempArgs.length; i++) {
    if (tempArgs[i] === '-e' && i + 1 < tempArgs.length) {
      const [key, ...rest] = tempArgs[i + 1].split('=');
      env[key] = rest.join('=');
      i++;
    }
  }
  return env;
}
```

---

## Files Changed

### Deleted
- `container/Dockerfile`
- `container/build.sh`
- `src/container-runtime.ts`
- `src/container-runtime.test.ts`
- `docs/docker-sandboxes.md`

### Created
- `src/box-runtime.ts` -- BoxLite runtime abstraction
- `src/box-runtime.test.ts` -- tests
- `container/provision.sh` -- first-run box setup script
- `docs/boxlite-migrate-plan.md` -- this document

### Rewritten
- `src/container-runner.ts` -- JsBoxlite/JsBox/JsExecution API
- `src/group-queue.ts` -- boxName replaces ChildProcess

### Unchanged
- `container/agent-runner/src/index.ts` -- stdin/stdout protocol preserved

### Modified
- `src/config.ts` -- BOX_IMAGE, BOX_MEMORY_MIB, BOX_CPUS
- `src/mount-security.ts` -- .docker -> .boxlite
- `src/index.ts` -- updated imports
- `setup/container.ts`, `setup/environment.ts`, `setup/service.ts`
- `package.json` -- @boxlite-ai/boxlite dependency
- All documentation referencing Docker

---

## Troubleshooting

**BoxLite not available on macOS**: Requires Apple Silicon (M1+) and macOS 12+. Hypervisor.framework is built-in.

**BoxLite not available on Linux**: Ensure `/dev/kvm` exists and your user is in the `kvm` group: `sudo usermod -aG kvm $USER`.

**First run is slow**: Provisioning installs system packages and npm globals (~2-5 min). Subsequent runs are fast.

**Volume permission issues**: BoxLite's `user` option maps UID:GID inside the VM. Ensure bind-mounted files are accessible by the specified user.

**Box cleanup**: Orphaned boxes are cleaned on startup via `runtime.listInfo()` + `runtime.remove()`. Manual cleanup: `boxlite list` and `boxlite remove <name>`.
