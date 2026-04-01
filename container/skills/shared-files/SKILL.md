---
name: shared-files
description: Share files with users via public URLs. Save files to /workspace/shared-files/ and they become downloadable links. Trigger phrases include "serve as file", "share as file", "make a link", "give me a link".
---

# Sharing Files

When the user says **"serve as file"**, **"share as file"**, **"make a link"**, or **"give me a link"**, take whatever content was just discussed or generated (code, text, data, etc.), save it to a file, and return a clickable URL.

## How it works

1. Save the file to `/workspace/shared-files/` with a descriptive filename
2. The file becomes accessible at `https://code.goette.co/files/<group>/<filename>`
3. Reply with the full URL so the user can click it

**The `<group>` name** is the name of the directory at `/workspace/group/`. To find it:

```bash
basename $(readlink -f /workspace/group)
```

## Example

If the user asks you to write a script then says "serve as file":

```bash
# Save it
cat > /workspace/shared-files/script.py << 'PYEOF'
# ... the script content ...
PYEOF
```

Then reply:
> Here's your file: https://code.goette.co/files/my-group/script.py

## Guidelines
- Pick a descriptive filename with the right extension (`.py`, `.csv`, `.html`, `.md`, `.json`, etc.)
- For code, use the appropriate source extension
- For formatted content (tables, reports), consider `.html` for rich rendering or `.md` for plain text
- Files are automatically cleaned up after 7 days
- Any file type is supported
