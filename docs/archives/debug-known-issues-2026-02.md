# Debug Known Issues Archive (2026-02)

Historical debug notes moved out of the active troubleshooting checklist so the current checklist stays operational and evergreen.

## Archived Issues

### 1. [FIXED] Resume branches from stale tree position

When agent teams spawns subagent CLI processes, they write to the same session JSONL. On subsequent `query()` resumes, the CLI reads the JSONL but may pick a stale branch tip (from before the subagent activity), causing the agent's response to land on a branch the host never receives a `result` for.

Fix: pass `resumeSessionAt` with the last assistant message UUID to explicitly anchor each resume.

### 2. [FIXED 2026-02-28] Timeout model separation (idle vs no-output vs hard timeout)

The runtime now separates three timeout paths:

- `IDLE_TIMEOUT` (default `300000`) closes stdin after inactivity.
- `CONTAINER_NO_OUTPUT_TIMEOUT` (default `720000`) fails fast when no streamed output appears.
- `CONTAINER_TIMEOUT` (default `1800000`) remains the hard safety timeout.

Timeout logs now include reason codes (`no_output_timeout` or `hard_timeout`) and effective timeout values for triage.

### 3. Cursor advanced before agent succeeds

`processGroupMessages` advances `lastAgentTimestamp` before the agent runs. If the container times out, retries find no messages because the cursor is already past them.

### 4. [FIXED 2026-02-22] Skill sync crash (`ERR_FS_CP_EINVAL`)

Hidden skill metadata from symlinked skill sources created copy collisions during per-group skill staging.

Fix:

- hidden entries are skipped during staging
- overlapping source/destination paths are guarded
- runtime copies real skill files into staged session storage instead of depending on symlink passthrough

### 5. Claude subscription quota hit (model responds but task does not progress)

Symptom:

- Group replies with `You've hit your limit ...` or equivalent quota text.

Action:

1. verify the response in `logs/nanoclaw.log`
2. wait for reset or switch the group to an available model/runtime
3. for worker execution, continue routing bounded tasks to OpenCode workers through `andy-developer`

### 6. [FIXED 2026-02-23] Duplicate running group containers

Symptom:

- Two same-group containers can appear as `running`, causing races with stale prior runs.

Fix:

- verified stop escalation on orphan cleanup
- pre-launch cleanup for already-running same-group containers
- timeout shutdown with verified stop escalation and attempt history

### 7. [FIXED 2026-02-25] Transient skill staging ENOENT under parallel runs

Concurrent Andy runs could fail early on transient `ENOENT`, `EBUSY`, or `EPERM` filesystem races during skill staging.

Fix:

- runtime retries transient skill sync filesystem errors before failing run setup
