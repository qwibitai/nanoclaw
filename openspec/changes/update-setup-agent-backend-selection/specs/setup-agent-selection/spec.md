# Spec: Setup Agent Backend Selection

## ADDED Requirements

### Requirement: Backend Choice Prompt
The setup skill MUST present an agent backend selection question before Claude Authentication, using `AskUserQuestion` with two options: **Claude** (default) and **Cursor**.

#### Scenario: User chooses Claude
Given the user selects Claude as the agent backend,
Then the skill continues to Claude Authentication (Step 4) without modification,
And `.env` is NOT modified regarding `AGENT_BACKEND` (defaults to `claude`).

#### Scenario: User chooses Cursor
Given the user selects Cursor as the agent backend,
Then the skill checks whether the `agent` CLI is available (`which agent`),
And if the agent CLI is missing, the skill informs the user and waits for confirmation before continuing,
And the skill prompts the user to run `agent login` if not already authenticated,
And the skill writes `AGENT_BACKEND=cursor` to `.env`,
And the skill skips the Claude Authentication step (Step 4).

### Requirement: Agent CLI Availability Check
When Cursor is selected, the skill MUST verify the `agent` CLI is installed before proceeding.

#### Scenario: agent CLI missing
Given `which agent` returns nothing,
Then the skill asks the user for confirmation to install Cursor via `curl https://cursor.com/install -fsS | bash`,
And if confirmed, runs the install command and verifies `which agent` succeeds afterward,
And if the user declines, the skill informs them they can install manually and halts.

### Requirement: Troubleshooting Entry
The Troubleshooting section MUST include an entry explaining how to switch backends via `AGENT_BACKEND` in `.env`.

#### Scenario: User wants to switch backend after setup
Given the user has already completed setup with one backend,
Then the Troubleshooting section provides instructions to set `AGENT_BACKEND=claude` or `AGENT_BACKEND=cursor` in `.env`,
And instructs the user to restart the service.
