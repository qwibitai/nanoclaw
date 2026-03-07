## ADDED Requirements

### Requirement: Scheduler-Driven Agent Execution
NanoClaw MUST execute scheduled tasks through the same containerized agent runtime used for interactive conversations.

#### Scenario: Running a due task
- **WHEN** the scheduler loop detects a task whose schedule is due
- **THEN** the task runs as a full agent invocation in that task's group context

### Requirement: Group-Context Task Scoping
Scheduled tasks MUST inherit their creating group's working directory and memory context.

#### Scenario: Task executes with group context
- **WHEN** a task created from a group runs
- **THEN** it uses that group's files and `CLAUDE.md` hierarchy as execution context

### Requirement: Supported Schedule Types
The scheduler MUST support `cron`, `interval`, and `once` schedule types with defined value formats.

#### Scenario: Creating a recurring cron task
- **WHEN** a task is scheduled with `schedule_type=cron`
- **THEN** `schedule_value` is interpreted as a cron expression

#### Scenario: Creating an interval task
- **WHEN** a task is scheduled with `schedule_type=interval`
- **THEN** `schedule_value` is interpreted as a millisecond interval

#### Scenario: Creating a one-time task
- **WHEN** a task is scheduled with `schedule_type=once`
- **THEN** `schedule_value` is interpreted as an ISO timestamp

### Requirement: MCP-Based Task Control Surface
The built-in `nanoclaw` MCP server MUST expose task lifecycle and messaging tools to the agent.

#### Scenario: Managing tasks through MCP tools
- **WHEN** the assistant needs to create or manage scheduled work
- **THEN** it can call `schedule_task`, `list_tasks`, `get_task`, `update_task`, `pause_task`, `resume_task`, and `cancel_task`

### Requirement: Optional Task Messaging
Scheduled tasks MUST be able to complete silently or send channel messages explicitly.

#### Scenario: Task sends a user-visible reminder
- **WHEN** a task needs to notify the group
- **THEN** it uses the MCP `send_message` tool to emit a message through the group's channel

### Requirement: Permission Model for Task Visibility and Control
Task management scope MUST differ between regular groups and the main group.

#### Scenario: Regular group views tasks
- **WHEN** a non-main group lists or manages tasks
- **THEN** actions apply only to tasks in that group

#### Scenario: Main group manages cross-group tasks
- **WHEN** the main group lists or schedules tasks
- **THEN** it can view and manage tasks across all registered groups
