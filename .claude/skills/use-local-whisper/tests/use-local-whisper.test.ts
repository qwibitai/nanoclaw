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
    expect(content).toContain('version: 2.0.0');
    expect(content).toContain('src/transcription.ts');
    expect(content).toContain('src/channels/telegram.ts');
    expect(content).toContain('src/channels/telegram.test.ts');
  });

  it('declares voice-transcription and telegram as dependencies', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'manifest.yaml'),
      'utf-8',
    );
    expect(content).toContain('depends:');
    expect(content).toContain('voice-transcription');
    expect(content).toContain('telegram');
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

  it('has the modified telegram channel file', () => {
    const filePath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.ts',
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has the modified telegram test file', () => {
    const filePath = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.test.ts',
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it('has intent files for all modified files', () => {
    const transcriptionIntent = path.join(
      skillDir,
      'modify',
      'src',
      'transcription.ts.intent.md',
    );
    const telegramIntent = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.ts.intent.md',
    );
    const testIntent = path.join(
      skillDir,
      'modify',
      'src',
      'channels',
      'telegram.test.ts.intent.md',
    );
    expect(fs.existsSync(transcriptionIntent)).toBe(true);
    expect(fs.existsSync(telegramIntent)).toBe(true);
    expect(fs.existsSync(testIntent)).toBe(true);

    const transcriptionContent = fs.readFileSync(transcriptionIntent, 'utf-8');
    expect(transcriptionContent).toContain('whisper.cpp');
    expect(transcriptionContent).toContain('transcribeAudioMessage');
    expect(transcriptionContent).toContain('transcribeAudio');
    expect(transcriptionContent).toContain('isVoiceMessage');
    expect(transcriptionContent).toContain('Invariants');

    const telegramContent = fs.readFileSync(telegramIntent, 'utf-8');
    expect(telegramContent).toContain('transcribeAudio');
    expect(telegramContent).toContain('Invariants');

    const testContent = fs.readFileSync(testIntent, 'utf-8');
    expect(testContent).toContain('mockTranscribeAudio');
    expect(testContent).toContain('Invariants');
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

  it('preserves the WhatsApp API (transcribeAudioMessage and isVoiceMessage)', () => {
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

  it('exports channel-agnostic transcribeAudio(Buffer)', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    expect(content).toContain('export async function transcribeAudio(');
    expect(content).toContain('audioBuffer: Buffer');
  });

  it('transcribeAudioMessage uses transcribeAudio internally', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'transcription.ts'),
      'utf-8',
    );

    // transcribeAudioMessage should call transcribeAudio(buffer)
    expect(content).toContain('await transcribeAudio(buffer)');
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

  it('modified telegram.ts imports transcribeAudio', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    expect(content).toContain("import { transcribeAudio }");
    expect(content).toContain("'../transcription.js'");
  });

  it('modified telegram.ts has async voice handler with transcription', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.ts'),
      'utf-8',
    );

    expect(content).toContain("'message:voice'");
    expect(content).toContain('transcribeAudio(buffer)');
    expect(content).toContain('[Voice:');
    expect(content).toContain(
      '[Voice message - transcription unavailable]',
    );
    expect(content).toContain('ctx.api.getFile');
  });

  it('modified telegram.test.ts mocks transcription module', () => {
    const content = fs.readFileSync(
      path.join(skillDir, 'modify', 'src', 'channels', 'telegram.test.ts'),
      'utf-8',
    );

    expect(content).toContain('mockTranscribeAudio');
    expect(content).toContain("vi.mock('../transcription.js'");
    expect(content).toContain('transcribes voice message successfully');
    expect(content).toContain('falls back when transcription returns null');
    expect(content).toContain('falls back when voice download fails');
    expect(content).toContain('includes caption with transcribed voice');
    expect(content).toContain('ignores voice messages from unregistered');
  });
});
