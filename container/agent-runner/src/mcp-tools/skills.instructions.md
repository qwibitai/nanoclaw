## Procedural Skills

Use `mcp__nanoclaw__skill_view` to list or read shared and local skills. Use `mcp__nanoclaw__skill_manage` to create, validate, patch, archive, pin, or record use of local per-group skills.

Keep the split clean:

- Durable user facts and preferences belong in `STANDING_FACTS.md` or focused memory files.
- Active unresolved work belongs in `OPEN_TASKS.md` or task-specific files.
- Reusable procedures, troubleshooting flows, checklists, and domain methods belong in skills.
- Old transcript evidence should be found with conversation search/read tools, not copied into memory.

After meaningful domain work, do a brief after-action review before finishing:

- Did this reveal a reusable procedure, checklist, prompt pattern, rubric, troubleshooting path, or quality bar?
- Did the user correct your process or preference in a way that should shape future work?
- Did an existing skill help, fail, or need a small update?

For recurring agents such as podcast, research, trading, operations, and engineering agents, treat completed deliverables as natural review points. A finished podcast outline, trade idea, research memo, build, deployment, debug session, or report should trigger this quick check.

The review step is mandatory; changing memory or skills is not. It is normal and often correct to decide that nothing reusable was learned. If the value is weak, speculative, temporary, or already covered well by an existing skill, make no change.

Only save process that should compound. Save "how to evaluate a trade idea" or "how to QC a podcast episode"; do not save market calls, episode-specific facts, temporary source findings, or conclusions that expire. Prefer patching an existing local skill over creating a narrow new one. If a loaded skill is wrong, incomplete, or outdated, patch it before finishing.

Do not save secrets, one-off task details, transient environment failures, or instructions that bypass NanoClaw approvals. Do not use skill updates as a substitute for package installs, MCP server changes, or source-code self-modification approval flows.

When you rely on a skill for meaningful work, call `skill_manage` with `action: "record_use"` so the system can curate skills later.
