## MODIFIED Requirements

### Requirement: Cursor ACP Output Buffering
`cursor-runner.ts` SHALL accumulate all `agent_message_chunk` text fragments during a single `connection.prompt()` call and emit exactly one `writeOutput({ result: text })` per prompt turn, followed by one `writeOutput({ result: null })` completion marker.

The runner SHALL NOT call `writeOutput()` inside `client.sessionUpdate()`.

#### Scenario: Single prompt response
- **WHEN** the agent emits multiple `agent_message_chunk` notifications during one `connection.prompt()` call
- **THEN** all text is accumulated in a buffer
- **AND** exactly one `writeOutput({ status: 'success', result: <full text>, newSessionId })` is called after `prompt()` resolves
- **AND** exactly one `writeOutput({ status: 'success', result: null, newSessionId })` completion marker follows

#### Scenario: Empty response
- **WHEN** the agent emits no `agent_message_chunk` notifications during one `connection.prompt()` call
- **THEN** no content `writeOutput` is emitted
- **AND** only the completion marker `writeOutput({ result: null })` is sent

#### Scenario: Follow-up message
- **WHEN** a follow-up IPC message triggers a second `connection.prompt()` call
- **THEN** the text buffer is reset to empty before the new prompt
- **AND** the same buffering behavior applies for the second turn
