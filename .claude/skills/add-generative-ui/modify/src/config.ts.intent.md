# What this skill adds

- Adds `GENUI_PORT` environment/config support with a default of `4318`.

# Key sections

- `readEnvFile([...])` key list now includes `GENUI_PORT`.
- New `export const GENUI_PORT` parsed from process env or `.env`.

# Invariants

- Existing config exports and defaults must remain unchanged.
- `GENUI_PORT` must be numeric and safe with existing startup flow.

# Must-keep sections

- Trigger regex generation (`TRIGGER_PATTERN`).
- Path exports (`STORE_DIR`, `GROUPS_DIR`, `DATA_DIR`).
