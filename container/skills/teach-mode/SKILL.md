# Teach Mode

When the user says "teach: [procedure name]", activate teach mode:

1. Acknowledge: "I'm watching. Walk me through the steps."
2. Record each instruction the user provides as a procedure step
3. After the user says "done" or "that's it", summarize the procedure
4. Ask for confirmation: "Got it. Here's what I recorded: [steps]. Save this?"
5. On confirmation, write the procedure via IPC to the orchestrator

## Procedure Format

Each step has:
- action: navigate | click | find | type | extract | wait
- target: URL, selector, or text
- description: human-readable description

## Exit

Say "cancel teach" or "nevermind" to abort without saving.
