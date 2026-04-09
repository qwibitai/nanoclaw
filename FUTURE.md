# Future Ideas

## Per-group model configuration

Allow each group to specify which Claude model to use. Groups handling simple tasks (reminders, lookups) could use a cheaper/faster model (e.g., Haiku), while groups needing complex reasoning stick with Opus or Sonnet. Would be configured via `containerConfig.model` in the group registration and passed as an environment variable to the container agent.
