import { describe, it, expect, beforeEach } from 'vitest';

import {
  registerChannel,
  getChannelFactory,
  getRegisteredChannelNames,
} from './registry.js';

// レジストリはモジュールレベルの状態なので、テストごとに新しいモジュールが必要。
// テストを分離するためにキャッシュバスティング付きの動的インポートを使用できる。
// ただし vitest は各ファイルを独自のコンテキストで実行し、登録順序を制御できるため、
// 公開APIを直接テストできる。

describe('channel registry', () => {
  // 注: レジストリはこのファイルのテスト間で共有されるモジュール状態。
  // 累積登録を考慮してテスト順序を調整している。

  it('getChannelFactory returns undefined for unknown channel', () => {
    expect(getChannelFactory('nonexistent')).toBeUndefined();
  });

  it('registerChannel and getChannelFactory round-trip', () => {
    const factory = () => null;
    registerChannel('test-channel', factory);
    expect(getChannelFactory('test-channel')).toBe(factory);
  });

  it('getRegisteredChannelNames includes registered channels', () => {
    registerChannel('another-channel', () => null);
    const names = getRegisteredChannelNames();
    expect(names).toContain('test-channel');
    expect(names).toContain('another-channel');
  });

  it('later registration overwrites earlier one', () => {
    const factory1 = () => null;
    const factory2 = () => null;
    registerChannel('overwrite-test', factory1);
    registerChannel('overwrite-test', factory2);
    expect(getChannelFactory('overwrite-test')).toBe(factory2);
  });
});
