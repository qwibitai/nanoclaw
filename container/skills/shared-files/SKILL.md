---
name: shared-files
description: Share files with users via public URLs. Save files to /workspace/shared-files/ and they become downloadable links.
---

# Sharing Files

To share files (code, images, CSVs, PDFs, charts, etc.) with the user:

1. Save the file to `/workspace/shared-files/`
2. The file becomes accessible at `https://code.goette.co/files/<group>/<filename>`
3. Include the full URL in your response so the user can click it

**The `<group>` name** is the name of the directory at `/workspace/group/`. To find it:

```bash
basename $(readlink -f /workspace/group)
```

**Example:**

```bash
# Save a generated chart
cp /tmp/analysis.png /workspace/shared-files/analysis.png
```

Then in your response:
> Here's the analysis: https://code.goette.co/files/my-group/analysis.png

**Notes:**
- Files are automatically cleaned up after 7 days
- Use descriptive filenames — they appear in the URL
- Any file type is supported
