import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('use-local-whisper skill package', () => {
  const skillDir = path.resolve(__dirname, '..');

  it('has a valid manifest', () => {
    const manifestPath = path.join(skillDir, 'manifest.yaml');
    expect(fs.existsSync(manifestPath)).toBe(true);

    const content = fs.readFileSync(manifestPath, 'utf-8');
    expect(content).toContain('skill: use-local-whisper');
    expect(content).toContain('version: 1.0.0');
    expect(content).toContain('src/transcription.ts');
    expect(content).toContain('voice-transcription');
  });

  it('declares voice-transcription as a dependency', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('depends:');
    expect(content).toContain('voice-transcription');
  });

  it('has no structured operations (no new npm deps needed)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('structured: {}');
  });

  it('has the modified transcription file', () => {
    const filePath = path.join(skillDir, 'modify', 'src', 'transcription.ts');
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has an intent file for the modified file', () => {
    const intentPath = path.join(skillDir, 'modify', 'src', 'transcription.ts.intent.md');
    expect(fs.existsSync(intentPath)).toBe(true);

    const content = fs.readFileSync(intentPath, 'utf-8');
    expect(content).toContain('whisper.cpp');
    expect(content).toContain('transcribeAudioMessage');
    expect(content).toContain('isVoiceMessage');
    expect(content).toContain('Invariants');
  });

  it('uses whisper-cli (not OpenAI) for transcription', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    // Uses local whisper.cpp CLI
    expect(content).toContain('whisper-cli');
    expect(content).toContain('execFileAsync');
    expect(content).toContain('WHISPER_BIN');
    expect(content).toContain('WHISPER_MODEL');
    expect(content).toContain('ggml-base.bin');

    // Does NOT use OpenAI
    expect(content).not.toContain('openai');
    expect(content).not.toContain('OpenAI');
    expect(content).not.toContain('OPENAI_API_KEY');
    expect(content).not.toContain('readEnvFile');
  });

  it('preserves the public API (transcribeAudioMessage and isVoiceMessage)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('export async function transcribeAudioMessage(');
    expect(content).toContain('msg: WAMessage');
    expect(content).toContain('sock: WASocket');
    expect(content).toContain('Promise<string | null>');
    expect(content).toContain('export function isVoiceMessage(');
    expect(content).toContain('downloadMediaMessage');
  });

  it('preserves fallback message strings', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('[Voice Message - transcription unavailable]');
  });

  it('includes ffmpeg conversion step', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('ffmpeg');
    expect(content).toContain("'-ar', '16000'");
    expect(content).toContain("'-ac', '1'");
  });

  it('cleans up temp files in finally block', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('finally');
    expect(content).toContain('unlinkSync');
  });
});
