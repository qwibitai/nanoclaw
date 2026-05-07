/**
 * Persist attachments that chat-sdk-bridge has already downloaded+base64'd
 * onto the session workspace so the container agent can actually read
 * them (via Read/Bash tools) instead of seeing only the filename.
 *
 * Chat SDK stores attachments with a base64 `data` field in the inbound
 * content JSON. That's bloated in the session DB and invisible to
 * Claude. This module decodes `data` → file under
 * `data/v2-sessions/<ag>/<sess>/attachments/<msgId>/<filename>` and
 * rewrites the attachment entry with a relative `localPath` that the
 * agent-runner's formatter resolves to `/workspace/<localPath>`.
 *
 * Phase 2.6 minimum: text/document attachments land on disk for
 * Read/Bash access. Image vision (base64 → content blocks passed to
 * Claude directly) is a separate formatter change if we want inline
 * image reading rather than tool-based reads.
 */
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { readContainerConfig } from './container-config.js';
import { isNonSymlinkChain } from './memory-daemon/source-ingest.js';
import { sessionDir } from './session-manager.js';
import { log } from './log.js';

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25MB per file — Slack's own limit

function sanitizeSegment(segment: string, fallback: string): string {
  const cleaned = segment
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 200);
  return cleaned || fallback;
}

interface AttachmentEntry {
  type?: string;
  name?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  data?: string; // base64
  url?: string;
  localPath?: string;
}

/**
 * Inspect content JSON, persist any base64 attachments to disk, and
 * mutate the content in place to replace `data` with `localPath`.
 * Returns the new content string. Idempotent if called twice (skips
 * entries that already have a localPath).
 */
export function persistInboundAttachments(
  agentGroupId: string,
  sessionId: string,
  messageId: string,
  rawContent: string,
): string {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }

  const attachments = content.attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) return rawContent;

  const safeMessageId = sanitizeSegment(messageId, 'msg');
  const baseDir = path.join(sessionDir(agentGroupId, sessionId), 'attachments', safeMessageId);
  let anyPersisted = false;

  for (const raw of attachments as AttachmentEntry[]) {
    if (raw.localPath || !raw.data) continue; // already saved or nothing to save
    try {
      const buffer = Buffer.from(raw.data, 'base64');
      if (buffer.length === 0) continue;
      if (buffer.length > MAX_ATTACHMENT_BYTES) {
        log.warn('Attachment exceeds size limit, skipping', {
          messageId,
          name: raw.name,
          bytes: buffer.length,
        });
        delete raw.data;
        continue;
      }
      fs.mkdirSync(baseDir, { recursive: true });
      // Content-hash the filename to disambiguate same-named attachments
      // (Slack/Discord paste every clipboard image as "image.png"). Prior fix
      // 50556f7 lived in the pre-Phase-2.6 download path that 8f913c6 replaced
      // with this function; the dedup didn't migrate over.
      const sha = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
      const rawName = sanitizeSegment(raw.name || raw.filename || 'file', 'file');
      const ext = path.extname(rawName);
      const base = ext ? rawName.slice(0, -ext.length) : rawName;
      const filename = `${base}-${sha}${ext}`;
      const absPath = path.join(baseDir, filename);
      fs.writeFileSync(absPath, buffer);

      // Memory sources mirror — additive, only when memory is enabled for this group.
      try {
        const ag = getAgentGroup(agentGroupId);
        if (ag) {
          const cfg = readContainerConfig(ag.folder);
          if (cfg.memory?.enabled === true) {
            // Codex F7 round 3 (2026-05-05): the daemon hardens its sweep
            // path against intermediate-symlink bypasses (sources or
            // sources/inbox symlinked to another group's matching path
            // would cross-ingest victim files). The host attachment mirror
            // writes directly into the same tree and was bypassing the
            // chain check — an attachment routed to group A could land in
            // group B's inbox and become B's facts. Apply the same chain
            // validation here.
            const groupRoot = path.join(GROUPS_DIR, ag.folder);
            if (isNonSymlinkChain(groupRoot, 'sources', 'inbox')) {
              const sourcesInbox = path.join(groupRoot, 'sources', 'inbox');
              fs.mkdirSync(sourcesInbox, { recursive: true });
              const mirrorExt = ext || '.bin';
              const finalName = `attachment-${sha}${mirrorExt}`;
              const finalPath = path.join(sourcesInbox, finalName);
              // Codex F11 round 4 (2026-05-05): the prior tmpPath was
              // `<finalName>.tmp` — fully predictable from attacker-supplied
              // attachment bytes and extension. An attacker with write
              // access to the inbox can pre-place that tmp path as a
              // symlink to /etc/passwd or another group's inbox file;
              // default writeFileSync follows symlinks and the host
              // truncates/writes the symlink target. Defense:
              //   1. Randomize tmp name so it can't be pre-placed
              //   2. Open with O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW —
              //      O_EXCL refuses to clobber existing entries, O_NOFOLLOW
              //      refuses to traverse if the final path component is a
              //      symlink. Together they bound the write to a fresh,
              //      regular-file fd that we control.
              const tmpName = `${finalName}.${randomBytes(8).toString('hex')}.tmp`;
              const tmpPath = path.join(sourcesInbox, tmpName);
              if (!fs.existsSync(finalPath)) {
                let fd: number | undefined;
                try {
                  fd = fs.openSync(
                    tmpPath,
                    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
                    0o600,
                  );
                  fs.writeSync(fd, buffer);
                } finally {
                  if (fd !== undefined) {
                    try {
                      fs.closeSync(fd);
                    } catch {
                      /* best-effort */
                    }
                  }
                }
                // renameSync moves the directory entry; if finalPath was
                // pre-placed as a symlink the rename replaces the symlink
                // with the regular file (the symlink target is untouched).
                fs.renameSync(tmpPath, finalPath);
              }
            } else {
              log.warn('Skipped attachment mirror — sources/inbox chain failed validation', {
                messageId,
                folder: ag.folder,
              });
            }
          }
        }
      } catch (mirrorErr) {
        log.warn('Failed to mirror attachment to memory sources inbox', { messageId, name: raw.name, err: mirrorErr });
      }

      // Relative to the session root (which the container mounts as /workspace)
      raw.localPath = path.posix.join('attachments', safeMessageId, filename);
      delete raw.data;
      anyPersisted = true;
    } catch (err) {
      log.warn('Failed to persist attachment', { messageId, name: raw.name, err });
    }
  }

  if (!anyPersisted) return rawContent;
  log.info('Persisted attachments', {
    sessionId,
    messageId,
    count: attachments.filter((a: AttachmentEntry) => a.localPath).length,
  });
  return JSON.stringify(content);
}
