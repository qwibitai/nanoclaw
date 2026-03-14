import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';
import { tmpdir } from 'os';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

interface VoiceProfile {
  name: string;
  embedding: number[];
  enrolledAt: string;
  sampleCount: number;
}

export interface SpeakerIdentification {
  speaker: string | null;
  similarity: number;
  confidence: 'high' | 'medium' | 'low';
  embedding: number[];
}

const PROFILE_DIR = path.join(process.cwd(), 'data', 'voice-profiles');
const VENV_PYTHON = process.env.VOICE_PYTHON_PATH ?? path.join(process.cwd(), 'scripts', 'venv', 'bin', 'python3');
const PYTHON_SERVICE = path.join(process.cwd(), 'scripts', 'voice-recognition-service.py');
const SIMILARITY_THRESHOLD_HIGH = 0.7;
const SIMILARITY_THRESHOLD_MEDIUM = 0.55;

// ── Pure math (no Python needed) ──────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function averageEmbeddings(embeddings: number[][]): number[] {
  const dim = embeddings[0].length;
  const avg = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      avg[i] += emb[i];
    }
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    avg[i] /= embeddings.length;
    norm += avg[i] * avg[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) {
    avg[i] /= norm;
  }
  return avg;
}

// ── Profile name validation ──────────────────────────────────────

function validateProfileName(name: string): void {
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) {
    throw new Error(
      `Invalid profile name "${name}" — use only letters, numbers, spaces, hyphens, and underscores`,
    );
  }
}

// ── Python daemon management ──────────────────────────────────────

let daemon: ChildProcess | null = null;
let pendingResolve: ((value: any) => void) | null = null;
let pendingReject: ((reason: any) => void) | null = null;
let daemonReady = false;

async function ensureDaemon(): Promise<void> {
  if (daemon && !daemon.killed && daemonReady) return;

  // Clean up any dead process
  if (daemon) {
    daemon.kill();
    daemon = null;
    daemonReady = false;
  }

  return new Promise<void>((resolve, reject) => {
    // Read HF_TOKEN from .env (not in process.env by design)
    const env = readEnvFile(['HF_TOKEN']);
    if (!env.HF_TOKEN) {
      reject(new Error('HF_TOKEN not set in .env — needed for PyAnnote model'));
      return;
    }

    const proc = spawn(VENV_PYTHON, [PYTHON_SERVICE], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HF_TOKEN: env.HF_TOKEN },
    });

    proc.stderr!.on('data', (data: Buffer) => {
      logger.info({ msg: data.toString().trim() }, 'voice-recognition-service');
    });

    proc.on('error', (err) => {
      logger.error({ err }, 'Failed to spawn voice recognition daemon');
      daemon = null;
      daemonReady = false;
      reject(err);
    });

    proc.on('exit', (code) => {
      logger.info({ code }, 'Voice recognition daemon exited');
      daemon = null;
      daemonReady = false;
      if (pendingReject) {
        pendingReject(new Error(`Daemon exited with code ${code}`));
        pendingResolve = null;
        pendingReject = null;
      }
    });

    const rl = readline.createInterface({ input: proc.stdout! });

    rl.on('line', (line: string) => {
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        logger.warn({ line }, 'Non-JSON line from voice daemon');
        return;
      }

      // First message is the "ready" signal
      if (!daemonReady && parsed.status === 'ready') {
        daemonReady = true;
        resolve();
        return;
      }

      // Subsequent messages are responses to commands
      if (pendingResolve) {
        const res = pendingResolve;
        pendingResolve = null;
        pendingReject = null;
        res(parsed);
      }
    });

    daemon = proc;

    // Timeout if model doesn't load within 120s
    setTimeout(() => {
      if (!daemonReady) {
        proc.kill();
        reject(new Error('Voice recognition daemon timed out loading model'));
      }
    }, 120_000);
  });
}

// Serialize all commands — the daemon handles one request at a time
// and uses a single pendingResolve/pendingReject slot.
let commandInFlight: Promise<unknown> = Promise.resolve();

async function sendCommand(cmd: Record<string, unknown>): Promise<any> {
  return (commandInFlight = commandInFlight.catch(() => {}).then(async () => {
    await ensureDaemon();

    if (!daemon || !daemon.stdin) {
      throw new Error('Voice recognition daemon not available');
    }

    return new Promise<any>((resolve, reject) => {
      pendingResolve = resolve;
      pendingReject = reject;

      daemon!.stdin!.write(JSON.stringify(cmd) + '\n');

      // Timeout per command (60s for extraction)
      setTimeout(() => {
        if (pendingReject) {
          pendingReject(new Error('Command timed out'));
          pendingResolve = null;
          pendingReject = null;
        }
      }, 60_000);
    });
  }));
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Extract voice embedding from an audio buffer.
 * Writes buffer to a temp file, sends to Python daemon, returns embedding.
 */
export async function extractVoiceEmbedding(audioBuffer: Buffer): Promise<number[]> {
  const tempFile = path.join(tmpdir(), `voice-${Date.now()}.ogg`);

  try {
    await fs.writeFile(tempFile, audioBuffer);
    const result = await sendCommand({ cmd: 'extract', audio_path: tempFile });

    if (result.error) {
      throw new Error(result.error);
    }

    return result.embedding;
  } finally {
    try { await fs.unlink(tempFile); } catch { /* ignore */ }
  }
}

/**
 * Load a voice profile from disk.
 */
async function loadVoiceProfile(name: string): Promise<VoiceProfile | null> {
  const profilePath = path.join(PROFILE_DIR, `${name}.json`);
  try {
    const data = await fs.readFile(profilePath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Save a voice profile to disk.
 */
async function saveVoiceProfile(profile: VoiceProfile): Promise<void> {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
  const profilePath = path.join(PROFILE_DIR, `${profile.name}.json`);
  await fs.writeFile(profilePath, JSON.stringify(profile, null, 2));
}

/**
 * List all available voice profiles.
 */
export async function listVoiceProfiles(): Promise<string[]> {
  try {
    await fs.mkdir(PROFILE_DIR, { recursive: true });
    const files = await fs.readdir(PROFILE_DIR);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace('.json', ''));
  } catch {
    return [];
  }
}

/**
 * Create a voice profile from multiple embeddings.
 * All math done in TypeScript — no Python needed.
 */
export async function createVoiceProfile(
  name: string,
  embeddings: number[][],
): Promise<void> {
  validateProfileName(name);
  if (embeddings.length === 0) {
    throw new Error('At least one embedding is required to create a profile');
  }

  const averaged = averageEmbeddings(embeddings);

  const profile: VoiceProfile = {
    name,
    embedding: averaged,
    enrolledAt: new Date().toISOString(),
    sampleCount: embeddings.length,
  };

  await saveVoiceProfile(profile);
  logger.info({ name, sampleCount: embeddings.length }, 'Voice profile created');
}

/**
 * Identify speaker from audio buffer.
 * Extracts embedding via Python daemon, compares against profiles in TypeScript.
 */
export async function identifySpeaker(
  audioBuffer: Buffer,
): Promise<SpeakerIdentification> {
  const profileNames = await listVoiceProfiles();
  if (profileNames.length === 0) {
    return { speaker: null, similarity: 0, confidence: 'low', embedding: [] };
  }

  const embedding = await extractVoiceEmbedding(audioBuffer);

  let bestMatch: { name: string; similarity: number } | null = null;

  for (const name of profileNames) {
    const profile = await loadVoiceProfile(name);
    if (!profile) continue;

    const similarity = cosineSimilarity(embedding, profile.embedding);

    if (!bestMatch || similarity > bestMatch.similarity) {
      bestMatch = { name, similarity };
    }
  }

  if (!bestMatch) {
    return { speaker: null, similarity: 0, confidence: 'low', embedding };
  }

  let confidence: 'high' | 'medium' | 'low';
  if (bestMatch.similarity >= SIMILARITY_THRESHOLD_HIGH) {
    confidence = 'high';
  } else if (bestMatch.similarity >= SIMILARITY_THRESHOLD_MEDIUM) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    speaker: bestMatch.similarity >= SIMILARITY_THRESHOLD_MEDIUM ? bestMatch.name : null,
    similarity: bestMatch.similarity,
    confidence,
    embedding,
  };
}

/**
 * Update an existing voice profile with new samples.
 * All math done in TypeScript.
 */
export async function updateVoiceProfile(
  name: string,
  newEmbeddings: number[][],
): Promise<void> {
  validateProfileName(name);
  const existingProfile = await loadVoiceProfile(name);
  if (!existingProfile) {
    throw new Error(`Voice profile for ${name} not found`);
  }

  const allEmbeddings = [existingProfile.embedding, ...newEmbeddings];
  const averaged = averageEmbeddings(allEmbeddings);

  const updatedProfile: VoiceProfile = {
    ...existingProfile,
    embedding: averaged,
    sampleCount: existingProfile.sampleCount + newEmbeddings.length,
  };

  await saveVoiceProfile(updatedProfile);
  logger.info({ name, sampleCount: updatedProfile.sampleCount }, 'Voice profile updated');
}

/**
 * Shut down the Python daemon (call on process exit).
 */
export function shutdownVoiceRecognition(): void {
  if (daemon && !daemon.killed) {
    daemon.kill();
    daemon = null;
    daemonReady = false;
  }
}
