#!/usr/bin/env -S npx tsx
/**
 * Voice Enrollment Script
 *
 * Processes saved audio files into a voice profile.
 *
 * Usage:
 *   npx tsx scripts/enroll-voice.ts --user="Yonatan"
 *     → Uses the 5 most recent files from data/voice-audio/
 *
 *   npx tsx scripts/enroll-voice.ts --user="Yonatan" --files="a.ogg,b.ogg,c.ogg"
 *     → Uses specific files
 *
 *   npx tsx scripts/enroll-voice.ts --user="Yonatan" --count=3
 *     → Uses the 3 most recent files from data/voice-audio/
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import {
  extractVoiceEmbedding,
  createVoiceProfile,
  shutdownVoiceRecognition,
} from '../src/voice-recognition.js';

const VOICE_AUDIO_DIR = path.join(process.cwd(), 'data', 'voice-audio');

interface Options {
  user: string;
  files?: string[];
  count: number;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Partial<Options> = { count: 5 };

  for (const arg of args) {
    if (arg.startsWith('--user=')) {
      options.user = arg.split('=').slice(1).join('=');
    } else if (arg.startsWith('--files=')) {
      options.files = arg.split('=').slice(1).join('=').split(',');
    } else if (arg.startsWith('--count=')) {
      options.count = parseInt(arg.split('=')[1], 10);
    }
  }

  if (!options.user) {
    console.error('Usage: npx tsx scripts/enroll-voice.ts --user="Name" [--files=a.ogg,b.ogg] [--count=5]');
    process.exit(1);
  }

  return options as Options;
}

async function getRecentAudioFiles(count: number): Promise<string[]> {
  let entries: { name: string; mtimeMs: number }[];
  try {
    const files = await fs.readdir(VOICE_AUDIO_DIR);
    entries = await Promise.all(
      files
        .filter((f) => f.endsWith('.ogg'))
        .map(async (f) => {
          const stat = await fs.stat(path.join(VOICE_AUDIO_DIR, f));
          return { name: f, mtimeMs: stat.mtimeMs };
        }),
    );
  } catch {
    console.error(`No audio files found in ${VOICE_AUDIO_DIR}`);
    console.error('Send some voice messages first, then re-run this script.');
    process.exit(1);
  }

  // Sort newest first
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (entries.length < count) {
    console.error(`Only ${entries.length} audio files found, need ${count}.`);
    console.error('Send more voice messages, then re-run this script.');
    process.exit(1);
  }

  return entries.slice(0, count).map((e) => path.join(VOICE_AUDIO_DIR, e.name));
}

async function main() {
  const options = parseArgs();

  console.log(`\nEnrolling voice for: ${options.user}`);

  // Get audio files
  let audioFiles: string[];
  if (options.files) {
    audioFiles = options.files;
    // Verify all files exist
    for (const f of audioFiles) {
      try {
        await fs.access(f);
      } catch {
        console.error(`File not found: ${f}`);
        process.exit(1);
      }
    }
  } else {
    console.log(`Using ${options.count} most recent audio files from ${VOICE_AUDIO_DIR}\n`);
    audioFiles = await getRecentAudioFiles(options.count);
  }

  console.log(`Processing ${audioFiles.length} audio files:\n`);

  // Extract embeddings
  const embeddings: number[][] = [];
  for (let i = 0; i < audioFiles.length; i++) {
    const file = audioFiles[i];
    console.log(`  [${i + 1}/${audioFiles.length}] ${path.basename(file)}...`);

    try {
      const buffer = await fs.readFile(file);
      const embedding = await extractVoiceEmbedding(buffer);
      embeddings.push(embedding);
      console.log(`    Embedding extracted (${embedding.length} dimensions)`);
    } catch (err) {
      console.error(`    Failed: ${err}`);
    }
  }

  if (embeddings.length === 0) {
    console.error('\nNo embeddings extracted. Check audio files and try again.');
    process.exit(1);
  }

  // Create profile
  console.log(`\nCreating profile from ${embeddings.length} samples...`);
  await createVoiceProfile(options.user, embeddings);
  console.log(`Voice profile created for ${options.user}!`);
  console.log(`\nTest by sending a voice note — it should be tagged with your name.\n`);

  shutdownVoiceRecognition();
}

main().catch((err) => {
  console.error('Enrollment failed:', err);
  shutdownVoiceRecognition();
  process.exit(1);
});
