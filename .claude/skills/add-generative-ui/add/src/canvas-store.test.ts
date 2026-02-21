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
  it('starts with an empty json-render spec', () => {
    const state = store.getState('main');
    expect(state.spec).toEqual({
      root: null,
      elements: {},
    });
    expect(state.revision).toBe(0);
    expect(state.updatedAt).toBeNull();
  });

  it('applies SpecStream JSONL operations', () => {
    const state = store.applyEventsFromJsonl(
      'main',
      [
        '{"op":"replace","path":"/root","value":"page"}',
        '{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero"]}}',
        '{"op":"add","path":"/elements/hero","value":{"component":"Heading","props":{"text":"Hello"}}}',
      ].join('\n'),
    );

    expect(state.spec).toEqual({
      root: 'page',
      elements: {
        page: {
          component: 'Container',
          children: ['hero'],
        },
        hero: {
          component: 'Heading',
          props: {
            text: 'Hello',
          },
        },
      },
    });
    expect(state.revision).toBe(3);
    expect(state.updatedAt).toBeTruthy();
  });

  it('applies incremental patches to existing spec', () => {
    store.applyEventsFromJsonl(
      'main',
      [
        '{"op":"replace","path":"/root","value":"page"}',
        '{"op":"add","path":"/elements/page","value":{"component":"Container","children":["hero"]}}',
        '{"op":"add","path":"/elements/hero","value":{"component":"Heading","props":{"text":"Initial"}}}',
      ].join('\n'),
    );

    const updated = store.applyEventsFromJsonl(
      'main',
      [
        '{"op":"replace","path":"/elements/hero/props/text","value":"Updated"}',
        '{"op":"add","path":"/elements/page/children/1","value":"cta"}',
        '{"op":"add","path":"/elements/cta","value":{"component":"Button","props":{"text":"Start"}}}',
      ].join('\n'),
    );

    expect(updated.spec).toEqual({
      root: 'page',
      elements: {
        page: {
          component: 'Container',
          children: ['hero', 'cta'],
        },
        hero: {
          component: 'Heading',
          props: {
            text: 'Updated',
          },
        },
        cta: {
          component: 'Button',
          props: {
            text: 'Start',
          },
        },
      },
    });
    expect(updated.revision).toBe(6);
  });

  it('applies multiple JSONL lines in order', () => {
    const state = store.applyEventsFromJsonl(
      'main',
      [
        '{"op":"replace","path":"/root","value":"app"}',
        '{"op":"add","path":"/elements/app","value":{"component":"Container","props":{"title":"v1"}}}',
        '{"op":"replace","path":"/elements/app/props/title","value":"v2"}',
      ].join('\n'),
    );

    expect(state.spec).toEqual({
      root: 'app',
      elements: {
        app: {
          component: 'Container',
          props: {
            title: 'v2',
          },
        },
      },
    });
    expect(state.revision).toBe(3);
  });

  it('throws line-aware errors for invalid JSONL', () => {
    expect(() =>
      store.applyEventsFromJsonl(
        'main',
        '{"op":"replace","path":"/root","value":"ok"}\nnot-json\n',
      ),
    ).toThrow(CanvasEventError);

    try {
      store.applyEventsFromJsonl(
        'main',
        '{"op":"replace","path":"/root","value":"ok"}\nnot-json\n',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CanvasEventError);
      const canvasErr = err as CanvasEventError;
      expect(canvasErr.line).toBe(2);
    }
  });

  it('throws line-aware errors for invalid operation shape', () => {
    expect(() =>
      store.applyEventsFromJsonl(
        'main',
        '{"op":"replace","path":"/root","value":"ok"}\n{"op":"set","path":"/root","value":"bad"}\n',
      ),
    ).toThrow(CanvasEventError);

    try {
      store.applyEventsFromJsonl(
        'main',
        '{"op":"replace","path":"/root","value":"ok"}\n{"op":"set","path":"/root","value":"bad"}\n',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(CanvasEventError);
      const canvasErr = err as CanvasEventError;
      expect(canvasErr.line).toBe(2);
    }
  });
});
