import { describe, it, expect, beforeEach } from 'vitest';
import { _initTestDatabase } from './db.js';
import {
  buildConsolidationGroup,
  isConsolidationFolder,
  CONSOLIDATION_FOLDER,
} from './consolidation-runner.js';

describe('consolidation-runner', () => {
  beforeEach(() => _initTestDatabase());

  it("buildConsolidationGroup returns object with folder='consolidation'", () => {
    const group = buildConsolidationGroup();
    expect(group.folder).toBe('consolidation');
    expect(group.folder).toBe(CONSOLIDATION_FOLDER);
  });

  it('buildConsolidationGroup has isMain=false', () => {
    const group = buildConsolidationGroup();
    expect(group.isMain).toBe(false);
  });

  it("isConsolidationFolder returns true for 'consolidation'", () => {
    expect(isConsolidationFolder('consolidation')).toBe(true);
    expect(isConsolidationFolder(CONSOLIDATION_FOLDER)).toBe(true);
  });

  it('isConsolidationFolder returns false for other folders', () => {
    expect(isConsolidationFolder('main')).toBe(false);
    expect(isConsolidationFolder('work')).toBe(false);
    expect(isConsolidationFolder('')).toBe(false);
    expect(isConsolidationFolder('CONSOLIDATION')).toBe(false);
  });
});
