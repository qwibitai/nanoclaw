/**
 * Voice transcription — local Whisper with optional OpenAI fallback.
 *
 * Sovereignty model: audio never leaves the machine unless explicitly opted in.
 *
 * Config via env vars:
 *   WHISPER_MODEL_PATH        Path to ggml model file (default: /whisper/model.bin)
 *   WHISPER_OPENAI_FALLBACK   'true' to allow OpenAI Whisper API fallback (default: false)
 *   WHISPER_REQUIRE_APPROVAL  'true' to require explicit consent before OpenAI call (default: false)
 */
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH ?? '/whisper/model.bin';
const OPENAI_FALLBACK_ENABLED = process.env.WHISPER_OPENAI_FALLBACK === 'true';
const REQUIRE_APPROVAL = process.env.WHISPER_REQUIRE_APPROVAL === 'true';

function log(msg: string): void {
  console.error(`[transcription] ${msg}`);
}

export interface TranscriptionResult {
  text: string;
  source: 'local-whisper' | 'openai-fallback';
  durationMs: number;
  model: string;
}

export interface TranscriptionOptions {
  /** Override WHISPER_OPENAI_FALLBACK env default. */
  allowFallback?: boolean;
  /** Override WHISPER_REQUIRE_APPROVAL env default. */
  requireApproval?: boolean;
}

/**
 * Transcribe an audio file. Tries local Whisper first; falls back to OpenAI
 * Whisper API only when explicitly enabled via env or options.
 *
 * Throws with an actionable error message when local fails and fallback is
 * disabled (the sovereign default).
 */
export async function transcribeAudio(filePath: string, options?: TranscriptionOptions): Promise<TranscriptionResult> {
  const allowFallback = options?.allowFallback ?? OPENAI_FALLBACK_ENABLED;
  const requireApproval = options?.requireApproval ?? REQUIRE_APPROVAL;

  if (fs.existsSync(WHISPER_MODEL_PATH)) {
    try {
      const start = Date.now();
      const text = await runWhisperCli(filePath);
      return { text, source: 'local-whisper', durationMs: Date.now() - start, model: 'whisper-local' };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!allowFallback) {
        throw new Error(
          `Local transcription failed and OpenAI fallback is disabled. ` +
            `Error: ${errMsg}. ` +
            `To enable fallback, set WHISPER_OPENAI_FALLBACK=true.`,
        );
      }
      log(`Local Whisper failed, falling back to OpenAI: ${errMsg}`);
    }
  } else if (!allowFallback) {
    throw new Error(
      `Whisper model not found at ${WHISPER_MODEL_PATH} and OpenAI fallback is disabled. ` +
        `Install the model file or set WHISPER_OPENAI_FALLBACK=true.`,
    );
  } else {
    log(`Model not found at ${WHISPER_MODEL_PATH}, falling back to OpenAI`);
  }

  // OpenAI fallback. When WHISPER_REQUIRE_APPROVAL=true, don't proceed
  // automatically — inform the caller to use the explicit MCP tool path.
  if (requireApproval) {
    throw new Error(
      `OpenAI transcription fallback requires explicit approval (WHISPER_REQUIRE_APPROVAL=true). ` +
        `Use the transcribe MCP tool with allowFallback:true to explicitly opt in.`,
    );
  }

  const start = Date.now();
  const text = await runOpenAITranscription(filePath);
  return { text, source: 'openai-fallback', durationMs: Date.now() - start, model: 'whisper-1' };
}

/** Run whisper-cli subprocess. Expects stdout to contain the plain transcript. */
async function runWhisperCli(filePath: string): Promise<string> {
  // whisper-cli -m <model> -f <file> -nt (no timestamps) outputs plain text to stdout
  const { stdout } = await execFileAsync('whisper-cli', ['-m', WHISPER_MODEL_PATH, '-f', filePath, '-nt']);
  const text = stdout.trim();
  if (!text) {
    throw new Error('whisper-cli produced no output');
  }
  return text;
}

/**
 * Compress audio with ffmpeg to 16 kHz mono Opus, then POST to OpenAI Whisper API.
 * Opus at 16 kbps compresses even hour-long voice messages to a few MB.
 */
async function runOpenAITranscription(filePath: string): Promise<string> {
  const tmpPath = path.join(os.tmpdir(), `nanoclaw-audio-${Date.now()}.opus`);
  try {
    // Pre-compress: 16 kHz mono Opus. Voice-quality-preserving, ~10× smaller than raw.
    await execFileAsync('ffmpeg', [
      '-i',
      filePath,
      '-ar',
      '16000',
      '-ac',
      '1',
      '-c:a',
      'libopus',
      '-b:a',
      '16k',
      '-y',
      tmpPath,
    ]);

    const bytes = fs.readFileSync(tmpPath);
    const form = new FormData();
    form.append('file', new File([bytes], 'audio.opus', { type: 'audio/opus' }));
    form.append('model', 'whisper-1');

    const apiKey = process.env.OPENAI_API_KEY ?? '';
    const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${body}`);
    }

    const json = (await resp.json()) as { text: string };
    return json.text;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup
    }
  }
}
