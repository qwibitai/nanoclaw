# Intent: container/Dockerfile modifications

## What changed

Added PDF reading capability via poppler-utils and a custom pdf-reader CLI script.

## Key sections

### apt-get install (system dependencies block)

- Added: `poppler-utils` to the package list (provides pdftotext, pdfinfo, pdftohtml)
- Changed: Comment updated to mention PDF tools

### After pnpm global installs

- Added: `COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader` to copy CLI script
- Added: `RUN chmod +x /usr/local/bin/pdf-reader` to make it executable

## Invariants (must-keep)

- All Chromium dependencies unchanged
- agent-browser and claude-code pnpm global installs unchanged
- WORKDIR, COPY agent-runner, pnpm install, pnpm run build sequence unchanged
- Workspace directory creation unchanged
- Entrypoint script unchanged
- User switching (node user) unchanged
- ENTRYPOINT unchanged
