import { readState, writeState } from './state.js';

export function resolvePathRemap(
  relPath: string,
  remap: Record<string, string>,
): string {
  return remap[relPath] ?? relPath;
}

export function loadPathRemap(): Record<string, string> {
  const state = readState();
  return state.path_remap ?? {};
}

export function recordPathRemap(remap: Record<string, string>): void {
  const state = readState();
  state.path_remap = { ...state.path_remap, ...remap };
  writeState(state);
}
