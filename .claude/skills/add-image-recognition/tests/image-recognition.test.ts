import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');

describe('add-image-recognition skill', () => {
  it('types.ts has image_path in NewMessage', () => {
    expect(read('src/types.ts')).toContain('image_path?: string');
  });

  it('db.ts has image_path migration', () => {
    const content = read('src/db.ts');
    expect(content).toContain('ADD COLUMN image_path TEXT');
  });

  it('db.ts storeMessage includes image_path', () => {
    const content = read('src/db.ts');
    expect(content).toContain('image_path) VALUES');
    expect(content).toContain('msg.image_path || null');
  });

  it('db.ts SELECT queries include image_path', () => {
    const content = read('src/db.ts');
    expect(content).toContain('content, timestamp, image_path');
    expect(content).toContain("content != '' OR image_path IS NOT NULL");
  });

  it('router.ts formatMessages accepts imagePathTransformer', () => {
    const content = read('src/router.ts');
    expect(content).toContain('imagePathTransformer');
    expect(content).toContain('image="');
  });

  it('whatsapp.ts imports downloadMediaMessage', () => {
    const content = read('src/channels/whatsapp.ts');
    expect(content).toContain('downloadMediaMessage');
  });

  it('whatsapp.ts imports crypto', () => {
    const content = read('src/channels/whatsapp.ts');
    expect(content).toContain("import crypto from 'crypto'");
  });

  it('whatsapp.ts imports DATA_DIR', () => {
    const content = read('src/channels/whatsapp.ts');
    expect(content).toContain('DATA_DIR');
  });

  it('whatsapp.ts has image download logic', () => {
    const content = read('src/channels/whatsapp.ts');
    expect(content).toContain('Image downloaded');
    expect(content).toContain('image_path: imagePath');
  });

  it('index.ts imports DATA_DIR', () => {
    const content = read('src/index.ts');
    expect(content).toContain('DATA_DIR');
  });

  it('index.ts has hostToContainerImagePath', () => {
    const content = read('src/index.ts');
    expect(content).toContain('hostToContainerImagePath');
  });

  it('index.ts passes transformer to formatMessages', () => {
    const content = read('src/index.ts');
    expect(content).toContain('formatMessages(missedMessages, hostToContainerImagePath)');
    expect(content).toContain('formatMessages(messagesToSend, hostToContainerImagePath)');
  });

  it('container-runner.ts mounts images directory', () => {
    const content = read('src/container-runner.ts');
    expect(content).toContain('/workspace/images');
    expect(content).toContain("path.join(DATA_DIR, 'images')");
  });

  it('agent-runner has ContentBlock type', () => {
    const content = read('container/agent-runner/src/index.ts');
    expect(content).toContain('type ContentBlock');
    expect(content).toContain("type: 'image'");
  });

  it('agent-runner has buildContentBlocks function', () => {
    const content = read('container/agent-runner/src/index.ts');
    expect(content).toContain('function buildContentBlocks');
    expect(content).toContain('image/jpeg');
  });

  it('agent-runner uses buildContentBlocks in runQuery', () => {
    const content = read('container/agent-runner/src/index.ts');
    expect(content).toContain('stream.push(buildContentBlocks(prompt))');
    expect(content).toContain('stream.push(buildContentBlocks(text))');
  });
});
