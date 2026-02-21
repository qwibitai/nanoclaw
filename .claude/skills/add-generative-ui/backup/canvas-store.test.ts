import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it } from 'vitest';

import { CanvasEventError, CanvasStore } from './canvas-store.js';

let tempDir: string;
let store: CanvasStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-canvas-store-'));
  store = new CanvasStore(tempDir);
});

describe('CanvasStore', () => {
  it('starts with empty state', () => {
    const state = store.getState('main');
    expect(state.spec).toEqual({});
    expect(state.revision).toBe(0);
    expect(state.updatedAt).toBeNull();
  });

  it('applies a set event', () => {
    const state = store.applyEventsFromJsonl(
      'main',
      '{"type":"set","spec":{"type":"text","text":"Hello"}}\n',
    );

    expect(state.spec).toEqual({ type: 'text', text: 'Hello' });
    expect(state.revision).toBe(1);
    expect(state.updatedAt).toBeTruthy();
  });

  it('applies patch events incrementally', () => {
    store.applyEventsFromJsonl(
      'main',
      '{"type":"set","spec":{"title":"Initial","items":[]}}\n',
    );

    const updated = store.applyEventsFromJsonl(
      'main',
      '{"type":"patch","ops":[{"op":"replace","path":"/title","value":"Updated"},{"op":"add","path":"/items/0","value":"first"}]}\n',
    );

    expect(updated.spec).toEqual({
      title: 'Updated',
      items: ['first'],
    });
    expect(updated.revision).toBe(2);
  });

  it('applies multiple JSONL lines in order', () => {
    const state = store.applyEventsFromJsonl(
      'main',
      '{"type":"set","spec":{"count":1}}\n{"type":"patch","ops":[{"op":"replace","path":"/count","value":2}]}\n',
    );

    expect(state.spec).toEqual({ count: 2 });
    expect(state.revision).toBe(2);
  });

  it('throws line-aware errors for invalid JSONL', () => {
    expect(() =>
      store.applyEventsFromJsonl(
        'main',
        '{"type":"set","spec":{"ok":true}}\nnot-json\n',
      ),
    ).toThrow(CanvasEventError);

    try {
      store.applyEventsFromJsonl(
        'main',
        '{"type":"set","spec":{"ok":true}}\nnot-json\n',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CanvasEventError);
      const canvasErr = err as CanvasEventError;
      expect(canvasErr.line).toBe(2);
    }
  });
});
