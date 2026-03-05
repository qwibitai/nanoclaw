import { exec } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';

import makeWASocket, {
  Browsers,
  DisconnectReason,
  WASocket,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

import {
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  STORE_DIR,
} from '../config.js';
import { getLastGroupSync, setLastGroupSync, updateChatName } from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const WHISPER_URL = process.env.WHISPER_URL || 'http://localhost:8083';
const XTTS_URL = process.env.XTTS_URL || 'http://localhost:8082';
const XTTS_SPEAKER = process.env.XTTS_SPEAKER || 'Sofia Hellen';
const XTTS_LANGUAGE = process.env.XTTS_LANGUAGE || 'de';
const VLM_URL = process.env.VLM_URL || 'http://192.168.178.10:8089';
const VLM_MODEL = process.env.VLM_MODEL || 'qwen3-vl-8b';
const VLM_TIMEOUT_MS = 60_000;

/**
 * Describe an image buffer via the local VLM service (Qwen3-VL).
 * If userPrompt is provided it becomes the VLM question; otherwise a default
 * German description prompt is used.
 * Returns the VLM response text, or null on any failure.
 */
async function describeImageWithVLM(
  imageBuffer: Buffer,
  mimeType: string,
  userPrompt?: string,
): Promise<string | null> {
  const ext = mimeType.includes('webp')
    ? 'image/webp'
    : mimeType.includes('png')
      ? 'image/png'
      : 'image/jpeg';
  const b64 = imageBuffer.toString('base64');
  const dataUrl = `data:${ext};base64,${b64}`;

  const prompt =
    userPrompt?.trim() ||
    'Beschreibe kurz was du auf diesem Bild siehst. Antworte auf Deutsch in maximal 3 Sätzen.';

  const body = JSON.stringify({
    model: VLM_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 500,
    temperature: 0.1,
    stream: false,
  });

  return new Promise((resolve) => {
    const url = new URL('/v1/chat/completions', VLM_URL);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ message?: { content?: string } }>;
            };
            const text = parsed.choices?.[0]?.message?.content?.trim();
            resolve(text || null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.setTimeout(VLM_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

const DOCUMENT_TEXT_LIMIT = 50_000; // ~30 pages of text

/**
 * Extract text from Office documents (DOCX, XLSX, ODT, ODS, etc.) via LibreOffice.
 * Returns extracted text (truncated with warning if too long), or null on failure.
 */
async function extractOfficeText(
  docBuffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string | null> {
  const ext = filename.split('.').pop()?.toLowerCase() || 'bin';
  const tmpDir = path.join('/tmp', `nanoclaw-doc-${Date.now()}`);
  const inputPath = path.join(tmpDir, `input.${ext}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(inputPath, docBuffer);

    const text = await new Promise<string>((resolve, reject) => {
      exec(
        `libreoffice --headless --cat "${inputPath}"`,
        { maxBuffer: 10 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });

    const trimmed = text.trim();
    if (!trimmed) return null;

    if (trimmed.length > DOCUMENT_TEXT_LIMIT) {
      return (
        trimmed.slice(0, DOCUMENT_TEXT_LIMIT) +
        `\n\n⚠️ Dokument zu groß — nur die ersten ~${Math.round(DOCUMENT_TEXT_LIMIT / 500)} Seiten extrahiert. Sag Klaus, dass du nur einen Ausschnitt siehst und frag ihn welcher Teil relevant ist.`
      );
    }
    return trimmed;
  } catch (err) {
    logger.warn({ err, filename }, 'Office text extraction failed');
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Convert an Office presentation (PPTX, PPT, ODP) to PDF via LibreOffice,
 * then analyse via VLM page-by-page.
 */
async function analysePresentationWithVLM(
  docBuffer: Buffer,
  filename: string,
  userPrompt?: string,
): Promise<string | null> {
  const ext = filename.split('.').pop()?.toLowerCase() || 'pptx';
  const tmpDir = path.join('/tmp', `nanoclaw-ppt-${Date.now()}`);
  const inputPath = path.join(tmpDir, `input.${ext}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(inputPath, docBuffer);

    // Convert to PDF
    await new Promise<void>((resolve, reject) => {
      exec(
        `libreoffice --headless --convert-to pdf --outdir "${tmpDir}" "${inputPath}"`,
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const pdfFile = fs.readdirSync(tmpDir).find((f) => f.endsWith('.pdf'));
    if (!pdfFile) return null;

    const pdfBuffer = fs.readFileSync(path.join(tmpDir, pdfFile));
    return await analysePdfWithVLM(pdfBuffer, userPrompt);
  } catch (err) {
    logger.warn({ err, filename }, 'Presentation VLM analysis failed');
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Analyse a PDF buffer via VLM: convert each page to PNG with pdftoppm,
 * then describe each page with Qwen3-VL. Returns combined analysis text
 * or null on failure.
 */
async function analysePdfWithVLM(
  pdfBuffer: Buffer,
  userPrompt?: string,
): Promise<string | null> {
  const tmpDir = path.join('/tmp', `nanoclaw-pdf-${Date.now()}`);
  const pdfPath = path.join(tmpDir, 'input.pdf');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(pdfPath, pdfBuffer);

    // Convert PDF pages to PNG images (max 10 pages, 150 dpi)
    await new Promise<void>((resolve, reject) => {
      exec(
        `pdftoppm -png -r 150 -l 10 "${pdfPath}" "${path.join(tmpDir, 'page')}"`,
        (err) => (err ? reject(err) : resolve()),
      );
    });

    const pageFiles = fs
      .readdirSync(tmpDir)
      .filter((f) => f.endsWith('.png'))
      .sort();

    if (pageFiles.length === 0) return null;

    const prompt =
      userPrompt?.trim() ||
      'Beschreibe den Inhalt dieser PDF-Seite auf Deutsch. Extrahiere alle relevanten Informationen wie Namen, Daten, Beträge und Texte.';

    const results: string[] = [];
    for (let i = 0; i < pageFiles.length; i++) {
      const imgBuffer = fs.readFileSync(path.join(tmpDir, pageFiles[i]));
      const pageResult = await describeImageWithVLM(
        imgBuffer,
        'image/png',
        prompt,
      );
      if (pageResult) {
        const prefix = pageFiles.length > 1 ? `[Seite ${i + 1}] ` : '';
        results.push(`${prefix}${pageResult}`);
      }
    }

    return results.length > 0 ? results.join('\n\n') : null;
  } catch (err) {
    logger.warn({ err }, 'PDF VLM analysis failed');
    return null;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Transcribe an audio buffer via the local Whisper STT service.
 * Returns the transcribed text, or null on failure.
 */
async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeType.includes('ogg') ? 'ogg' : 'mp4';
  const tmpFile = path.join('/tmp', `nanoclaw-stt-${Date.now()}.${ext}`);
  try {
    fs.writeFileSync(tmpFile, audioBuffer);
    const response = await new Promise<string>((resolve, reject) => {
      exec(
        `curl -s -X POST "${WHISPER_URL}/transcribe" -F "file=@${tmpFile}" -F "language=de" --max-time 30`,
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        },
      );
    });
    const data = JSON.parse(response) as { text?: string };
    return data.text?.trim() || null;
  } catch (err) {
    logger.warn({ err }, 'Whisper STT error');
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Synthesize text to OGG/Opus audio via XTTS service.
 * Returns the audio buffer, or null if TTS is unavailable.
 */
async function synthesizeVoice(text: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${XTTS_URL}/synthesize-ogg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language: XTTS_LANGUAGE,
        speaker: XTTS_SPEAKER,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'XTTS TTS failed');
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    logger.warn({ err }, 'XTTS TTS error');
    return null;
  }
}

export interface WhatsAppChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class WhatsAppChannel implements Channel {
  name = 'whatsapp';

  private sock!: WASocket;
  private connected = false;
  private authRequired = false;
  private reconnectDelay = 5000;
  private lidToPhoneMap: Record<string, string> = {};
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private botSentPttIds = new Set<string>();

  private opts: WhatsAppChannelOpts;

  constructor(opts: WhatsAppChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const connectionPromise = new Promise<void>((resolve, reject) => {
      this.connectInternal(resolve).catch(reject);
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              'WhatsApp connection timed out after 30s — check auth or delete store/auth/ and re-authenticate',
            ),
          ),
        30000,
      ),
    );
    return Promise.race([connectionPromise, timeoutPromise]);
  }

  private async connectInternal(onFirstOpen?: () => void): Promise<void> {
    // Destroy the previous socket before creating a new one.
    // Without this, each reconnection leaves a ghost socket in memory: its
    // event listeners, signal-key LRU cache, and internal Baileys buffers all
    // remain alive via closure references. Over many reconnections (network
    // blips, phone sleep, WA server drops) this compounds into an OOM crash.
    if (this.sock) {
      try {
        this.sock.ev.removeAllListeners('connection.update');
        this.sock.ev.removeAllListeners('creds.update');
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.end(undefined);
      } catch {
        // socket may already be closed — ignore
      }
    }

    const authDir = path.join(STORE_DIR, 'auth');
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    const { version } = await fetchLatestWaWebVersion({}).catch((err) => {
      logger.warn(
        { err },
        'Failed to fetch latest WA Web version, using default',
      );
      return { version: undefined };
    });
    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Chrome'),
    });

    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const msg =
          'WhatsApp authentication required. Run /setup in Claude Code.';
        logger.error(msg);
        exec(
          `osascript -e 'display notification "${msg}" with title "NanoClaw" sound name "Basso"'`,
        );
        // Mark auth as required but do not exit — the service can continue
        // serving other channels while waiting for re-authentication.
        this.authRequired = true;
      }

      if (connection === 'close') {
        this.connected = false;
        const reason = (
          lastDisconnect?.error as { output?: { statusCode?: number } }
        )?.output?.statusCode;
        const shouldReconnect =
          reason !== DisconnectReason.loggedOut && !this.authRequired;
        logger.info(
          {
            reason,
            shouldReconnect,
            queuedMessages: this.outgoingQueue.length,
          },
          'Connection closed',
        );

        if (!shouldReconnect) {
          if (reason === DisconnectReason.loggedOut) {
            logger.info('Logged out. Run /setup to re-authenticate.');
            process.exit(0);
          }
          // authRequired — wait for manual re-auth, do not reconnect
          return;
        }

        const delay =
          reason === 405
            ? (this.reconnectDelay = Math.min(
                this.reconnectDelay * 2,
                5 * 60 * 1000,
              ))
            : 0;

        if (delay > 0) {
          logger.warn(
            { reason, delay },
            'Rate-limited by WhatsApp (405), backing off before reconnect',
          );
        } else {
          logger.info('Reconnecting...');
        }

        setTimeout(() => {
          this.connectInternal().catch((err) => {
            logger.error({ err }, 'Failed to reconnect, retrying in 5s');
            setTimeout(() => {
              this.connectInternal().catch((err2) => {
                logger.error({ err: err2 }, 'Reconnection retry failed');
              });
            }, 5000);
          });
        }, delay);
      } else if (connection === 'open') {
        this.connected = true;
        this.reconnectDelay = 5000;
        logger.info('Connected to WhatsApp');

        // Announce availability so WhatsApp relays subsequent presence updates (typing indicators)
        this.sock.sendPresenceUpdate('available').catch((err) => {
          logger.warn({ err }, 'Failed to send presence update');
        });

        // Build LID to phone mapping from auth state for self-chat translation
        if (this.sock.user) {
          const phoneUser = this.sock.user.id.split(':')[0];
          const lidUser = this.sock.user.lid?.split(':')[0];
          if (lidUser && phoneUser) {
            this.lidToPhoneMap[lidUser] = `${phoneUser}@s.whatsapp.net`;
            logger.debug({ lidUser, phoneUser }, 'LID to phone mapping set');
          }
        }

        // Flush any messages queued while disconnected
        this.flushOutgoingQueue().catch((err) =>
          logger.error({ err }, 'Failed to flush outgoing queue'),
        );

        // Sync group metadata on startup (respects 24h cache)
        this.syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Initial group sync failed'),
        );
        // Set up daily sync timer (only once)
        if (!this.groupSyncTimerStarted) {
          this.groupSyncTimerStarted = true;
          setInterval(() => {
            this.syncGroupMetadata().catch((err) =>
              logger.error({ err }, 'Periodic group sync failed'),
            );
          }, GROUP_SYNC_INTERVAL_MS);
        }

        // Signal first connection to caller
        if (onFirstOpen) {
          onFirstOpen();
          onFirstOpen = undefined;
        }
      }
    });

    this.sock.ev.on('creds.update', saveCreds);

    this.sock.ev.on('messages.upsert', async ({ messages }) => {
      for (const msg of messages) {
        if (!msg.message) continue;
        // Unwrap container types (viewOnceMessageV2, ephemeralMessage,
        // editedMessage, etc.) so that conversation, extendedTextMessage,
        // imageMessage, etc. are accessible at the top level.
        const normalized = normalizeMessageContent(msg.message);
        if (!normalized) continue;
        const rawJid = msg.key.remoteJid;
        if (!rawJid || rawJid === 'status@broadcast') continue;

        // Translate LID JID to phone JID if applicable
        const chatJid = await this.translateJid(rawJid);

        const timestamp = new Date(
          Number(msg.messageTimestamp) * 1000,
        ).toISOString();

        // Always notify about chat metadata for group discovery
        const isGroup = chatJid.endsWith('@g.us');
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          undefined,
          'whatsapp',
          isGroup,
        );

        // Only deliver full message for registered groups
        const groups = this.opts.registeredGroups();
        if (groups[chatJid]) {
          let content =
            normalized.conversation ||
            normalized.extendedTextMessage?.text ||
            normalized.imageMessage?.caption ||
            normalized.videoMessage?.caption ||
            '';

          // Transcribe PTT/audio messages via Whisper STT
          let isVoiceMessage = false;
          if (!content && normalized.audioMessage) {
            const audioMsg = normalized.audioMessage;
            const isPtt = (audioMsg as Record<string, unknown>)?.ptt === true;
            // Skip PTT sent by the bot itself (our own TTS voice responses)
            if (isPtt && msg.key.id && this.botSentPttIds.has(msg.key.id)) {
              this.botSentPttIds.delete(msg.key.id);
              continue;
            }
            isVoiceMessage = isPtt;
            logger.info(
              { chatJid, isPtt },
              'Received audio message, transcribing...',
            );
            try {
              const audioBuffer = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
              )) as Buffer;
              const mimeType = audioMsg?.mimetype || 'audio/ogg; codecs=opus';
              const transcribed = await transcribeAudio(audioBuffer, mimeType);
              if (transcribed) {
                content = transcribed;
                logger.info({ chatJid, transcribed }, 'Audio transcribed');
              } else {
                logger.warn(
                  { chatJid },
                  'Audio transcription returned empty result',
                );
              }
            } catch (err) {
              logger.warn(
                { err, chatJid },
                'Failed to download/transcribe audio',
              );
            }
          }

          // Analyse images/stickers via VLM; fall back to saving to disk if VLM unavailable
          if (normalized.imageMessage || normalized.stickerMessage) {
            const imgMsg = normalized.imageMessage || normalized.stickerMessage;
            const group = groups[chatJid];
            try {
              const imgBuffer = (await downloadMediaMessage(
                msg,
                'buffer',
                {},
              )) as Buffer;
              const mimeType = imgMsg?.mimetype || 'image/jpeg';
              const caption = normalized.imageMessage?.caption?.trim() || '';

              // VLM analysis — caption becomes the user question if present
              const vlmResult = await describeImageWithVLM(
                imgBuffer,
                mimeType,
                caption || undefined,
              );

              if (vlmResult) {
                content = caption
                  ? `${caption}\n[Bildanalyse: ${vlmResult}]`
                  : `[Bildanalyse: ${vlmResult}]`;
                logger.info(
                  {
                    chatJid,
                    captionLen: caption.length,
                    vlmLen: vlmResult.length,
                  },
                  'Image described by VLM',
                );
              } else {
                // Fallback: save to disk as before
                const ext = mimeType.includes('webp') ? 'webp' : 'jpg';
                const mediaDir = path.join(
                  STORE_DIR,
                  '..',
                  'groups',
                  group.folder,
                  'media',
                );
                fs.mkdirSync(mediaDir, { recursive: true });
                const filename = `img-${Date.now()}.${ext}`;
                const hostPath = path.join(mediaDir, filename);
                fs.writeFileSync(hostPath, imgBuffer);
                const containerPath = `/workspace/group/media/${filename}`;
                content = caption
                  ? `${caption}\n[Bild gespeichert unter: ${containerPath}]`
                  : `[Bild gespeichert unter: ${containerPath}]`;
                logger.warn(
                  { chatJid },
                  'VLM unavailable, image saved to disk as fallback',
                );
              }
            } catch (err) {
              logger.warn({ err, chatJid }, 'Failed to download/process image');
            }
          }

          // Process document attachments (PDF, Office, presentations)
          if (!content && normalized.documentMessage) {
            const docMsg = normalized.documentMessage;
            const filename = docMsg?.fileName || 'Dokument';
            const mime = docMsg?.mimetype || '';
            const ext = filename.split('.').pop()?.toLowerCase() || '';
            const caption = docMsg?.caption?.trim() || '';

            const isPdf = mime.includes('pdf') || ext === 'pdf';
            const isPresentation = ['pptx', 'ppt', 'odp'].includes(ext) ||
              mime.includes('presentation') || mime.includes('powerpoint');
            const isOfficeText = ['docx', 'doc', 'odt', 'xlsx', 'xls', 'ods', 'csv', 'txt', 'rtf'].includes(ext) ||
              mime.includes('word') || mime.includes('spreadsheet') || mime.includes('text');

            if (isPdf || isPresentation || isOfficeText) {
              try {
                const docBuffer = (await downloadMediaMessage(msg, 'buffer', {})) as Buffer;

                if (isPdf) {
                  const result = await analysePdfWithVLM(docBuffer, caption || undefined);
                  if (result) {
                    content = caption
                      ? `${caption}\n[PDF-Analyse "${filename}": ${result}]`
                      : `[PDF-Analyse "${filename}": ${result}]`;
                    logger.info({ chatJid, filename }, 'PDF analysed by VLM');
                  }
                } else if (isPresentation) {
                  const result = await analysePresentationWithVLM(docBuffer, filename, caption || undefined);
                  if (result) {
                    content = caption
                      ? `${caption}\n[Präsentation-Analyse "${filename}": ${result}]`
                      : `[Präsentation-Analyse "${filename}": ${result}]`;
                    logger.info({ chatJid, filename }, 'Presentation analysed by VLM');
                  }
                } else if (isOfficeText) {
                  const result = await extractOfficeText(docBuffer, mime, filename);
                  if (result) {
                    content = caption
                      ? `${caption}\n[Dokument "${filename}": ${result}]`
                      : `[Dokument "${filename}": ${result}]`;
                    logger.info({ chatJid, filename, chars: result.length }, 'Office doc text extracted');
                  }
                }
              } catch (err) {
                logger.warn({ err, chatJid, filename }, 'Failed to process document');
              }
            }
          }

          // Skip protocol messages with no text content (encryption keys, read receipts, etc.)
          if (!content) continue;

          const sender = msg.key.participant || msg.key.remoteJid || '';
          const senderName = msg.pushName || sender.split('@')[0];

          const fromMe = msg.key.fromMe || false;
          // Detect bot messages: with own number, fromMe is reliable
          // since only the bot sends from that number.
          // With shared number, bot messages carry the assistant name prefix
          // (even in DMs/self-chat) so we check for that.
          const isBotMessage = ASSISTANT_HAS_OWN_NUMBER
            ? fromMe
            : content.startsWith(`${ASSISTANT_NAME}:`);

          this.opts.onMessage(chatJid, {
            id: msg.key.id || '',
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: fromMe,
            is_bot_message: isBotMessage,
            is_voice_message: isVoiceMessage,
          });
        }
      }
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Prefix bot messages with assistant name so users know who's speaking.
    // On a shared number, prefix is also needed in DMs (including self-chat)
    // to distinguish bot output from user messages.
    // Skip only when the assistant has its own dedicated phone number.
    const prefixed = ASSISTANT_HAS_OWN_NUMBER
      ? text
      : `${ASSISTANT_NAME}: ${text}`;

    if (!this.connected) {
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.info(
        { jid, length: prefixed.length, queueSize: this.outgoingQueue.length },
        'WA disconnected, message queued',
      );
      return;
    }
    try {
      await this.sock.sendMessage(jid, { text: prefixed });
      logger.info({ jid, length: prefixed.length }, 'Message sent');
    } catch (err) {
      // If send fails, queue it for retry on reconnect
      this.outgoingQueue.push({ jid, text: prefixed });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async sendVoiceMessage(jid: string, text: string): Promise<boolean> {
    const audio = await synthesizeVoice(text);
    if (!audio) return false;
    try {
      const result = await this.sock.sendMessage(jid, {
        audio,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
      });
      if (result?.key?.id) this.botSentPttIds.add(result.key.id);
      logger.info({ jid, length: audio.length }, 'Voice message sent');
      return true;
    } catch (err) {
      logger.warn({ err, jid }, 'Failed to send voice message');
      return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.sock?.end(undefined);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    try {
      const status = isTyping ? 'composing' : 'paused';
      logger.debug({ jid, status }, 'Sending presence update');
      await this.sock.sendPresenceUpdate(status, jid);
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  /**
   * Sync group metadata from WhatsApp.
   * Fetches all participating groups and stores their names in the database.
   * Called on startup, daily, and on-demand via IPC.
   */
  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from WhatsApp...');
      const groups = await this.sock.groupFetchAllParticipating();

      let count = 0;
      for (const [jid, metadata] of Object.entries(groups)) {
        if (metadata.subject) {
          updateChatName(jid, metadata.subject);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  private async translateJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lidUser = jid.split('@')[0].split(':')[0];

    // Check local cache first
    const cached = this.lidToPhoneMap[lidUser];
    if (cached) {
      logger.debug(
        { lidJid: jid, phoneJid: cached },
        'Translated LID to phone JID (cached)',
      );
      return cached;
    }

    // Query Baileys' signal repository for the mapping
    try {
      const pn = await this.sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const phoneJid = `${pn.split('@')[0].split(':')[0]}@s.whatsapp.net`;
        this.lidToPhoneMap[lidUser] = phoneJid;
        logger.info(
          { lidJid: jid, phoneJid },
          'Translated LID to phone JID (signalRepository)',
        );
        return phoneJid;
      }
    } catch (err) {
      logger.debug({ err, jid }, 'Failed to resolve LID via signalRepository');
    }

    return jid;
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        // Send directly — queued items are already prefixed by sendMessage
        await this.sock.sendMessage(item.jid, { text: item.text });
        logger.info(
          { jid: item.jid, length: item.text.length },
          'Queued message sent',
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}
