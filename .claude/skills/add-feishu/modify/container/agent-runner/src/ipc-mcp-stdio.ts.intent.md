# Intent: Add send_media MCP tool

Add a `send_media` tool to the MCP server that allows the container agent to send media files (images, files, audio, video) to the user or group via IPC.

**Changes:**
1. New `send_media` tool with parameters:
   - `file_path` (string, required): Must be under `/workspace/group/`
   - `type` (enum: image/file/audio/video, required): Media type
   - `filename` (string, optional): Display filename
2. Validation: path must start with `/workspace/group/`, must not contain `..`, file must exist
3. Writes IPC message file with `media` object instead of `text`

**Security invariants:**
- File path must start with `/workspace/group/` (no access outside workspace)
- Path traversal (`..`) is rejected
- File existence is verified before writing IPC
