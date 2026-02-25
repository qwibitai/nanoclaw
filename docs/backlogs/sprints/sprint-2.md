# Sprint 2: Document Processing

**Package:** cambot-agent
**Duration:** ~2 weeks
**Sprint Goal:** Enable sandboxed document processing in agent containers.

---

## Stories

### 4.5 — Sandboxed document processing
- [ ] Route uploaded files to agent container for processing (not main process)
- [ ] Enforce mount security on uploaded files (same allowlist as other mounts)
- [ ] Ensure container sandbox prevents file system escape
- [ ] Add tests for sandboxed processing

---

## Definition of Done
- Document parsing happens inside container sandbox
- Mount security enforced on all uploaded files
- No file processing in the main cambot-agent process
