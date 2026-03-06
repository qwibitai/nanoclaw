# Intent: Add react_to_message MCP tool

Add a `react_to_message` tool to the MCP server that lets container agents send
emoji reactions via IPC. Takes an emoji (required) and optional message_id.
Writes a `type: 'reaction'` IPC file to the messages directory.
