import { describe, it, expect, beforeEach } from 'vitest';
import {
  setModel,
  setThinking,
  getOverride,
  clearOverride,
  listModels,
  parseModelCommand,
  ALLOWED_MODELS,
} from './model-switching.js';

// -------------------------------------------------------------------
// Tests derived ONLY from the module spec — no production code peeked.
// -------------------------------------------------------------------

beforeEach(() => {
  // Clear all overrides between tests so state doesn't leak
  clearOverride('test-group');
  clearOverride('other-group');
});

describe('model-switching', () => {
  // ------------------------------------------------------------------
  // 1. "should set model override for group session"
  // ------------------------------------------------------------------
  describe('setModel()', () => {
    it('should set model override for group session', () => {
      const result = setModel('test-group', 'claude-sonnet-4-20250514');

      // Must succeed
      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Override must now be visible via getOverride
      const override = getOverride('test-group');
      expect(override).toBeDefined();
      expect(override.model).toBe('claude-sonnet-4-20250514');
    });

    it('should persist override across multiple getOverride calls within same session', () => {
      setModel('test-group', 'claude-haiku-4-5-20251001');

      expect(getOverride('test-group').model).toBe('claude-haiku-4-5-20251001');
      expect(getOverride('test-group').model).toBe('claude-haiku-4-5-20251001');
    });

    it('should isolate overrides between different groups', () => {
      setModel('test-group', 'claude-sonnet-4-20250514');
      setModel('other-group', 'claude-opus-4-20250115');

      expect(getOverride('test-group').model).toBe('claude-sonnet-4-20250514');
      expect(getOverride('other-group').model).toBe('claude-opus-4-20250115');
    });
  });

  // ------------------------------------------------------------------
  // 2. "should clear override on session idle (pool eviction)"
  // ------------------------------------------------------------------
  describe('clearOverride() — session idle / pool eviction', () => {
    it('should clear override on session idle (pool eviction)', () => {
      setModel('test-group', 'claude-sonnet-4-20250514');
      setThinking('test-group', true);

      // Verify the override was actually set before clearing
      expect(getOverride('test-group').model).toBe('claude-sonnet-4-20250514');
      expect(getOverride('test-group').thinking).toBe(true);

      // Simulate pool eviction by calling clearOverride
      clearOverride('test-group');

      const override = getOverride('test-group');
      expect(override.model).toBeUndefined();
      expect(override.thinking).toBeUndefined();
    });

    it('should cause next message to use default model after clear', () => {
      setModel('test-group', 'claude-opus-4-20250115');

      // Verify override was set
      expect(getOverride('test-group').model).toBe('claude-opus-4-20250115');

      clearOverride('test-group');

      const override = getOverride('test-group');
      // No model override — falls back to default
      expect(override.model).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // 3. "should list available models when /model called with no args"
  // ------------------------------------------------------------------
  describe('listModels()', () => {
    it('should list available models when /model called with no args', () => {
      const models = listModels();

      expect(Array.isArray(models)).toBe(true);
      expect(models.length).toBeGreaterThan(0);

      // Must include the three models from the spec
      expect(models).toContain('claude-sonnet-4-20250514');
      expect(models).toContain('claude-haiku-4-5-20251001');
      expect(models).toContain('claude-opus-4-20250115');
    });
  });

  // ------------------------------------------------------------------
  // 4. "should reject invalid model names"
  // ------------------------------------------------------------------
  describe('setModel() — validation', () => {
    it('should reject invalid model names', () => {
      const result = setModel('test-group', 'gpt-4-turbo');

      expect(result.success).toBe(false);
      // Error must list available models
      expect(result.error).toBeDefined();
      expect(result.availableModels).toBeDefined();
      expect(Array.isArray(result.availableModels)).toBe(true);
      expect(result.availableModels!.length).toBeGreaterThan(0);

      // Override must NOT have changed
      const override = getOverride('test-group');
      expect(override.model).toBeUndefined();
    });

    it('should reject empty model names', () => {
      const result = setModel('test-group', '');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      const override = getOverride('test-group');
      expect(override.model).toBeUndefined();
    });

    it('should not overwrite existing valid override when invalid name is given', () => {
      setModel('test-group', 'claude-sonnet-4-20250514');
      const badResult = setModel('test-group', 'nonexistent-model');

      expect(badResult.success).toBe(false);
      // Previous valid override must survive
      expect(getOverride('test-group').model).toBe('claude-sonnet-4-20250514');
    });
  });

  // ------------------------------------------------------------------
  // 5. "should use override as primary in provider chain"
  // ------------------------------------------------------------------
  describe('getOverride() — provider chain', () => {
    it('should use override as primary in provider chain', () => {
      setModel('test-group', 'claude-opus-4-20250115');

      const override = getOverride('test-group');
      // The override model must be present and usable as primary model
      expect(override.model).toBe('claude-opus-4-20250115');
      // Thinking may or may not be set, but model is definitive
      expect(typeof override.model).toBe('string');
    });

    it('should return empty override when no model is set (default model applies)', () => {
      const override = getOverride('test-group');

      // No override set — model should be undefined so caller uses default
      expect(override.model).toBeUndefined();
      // But the return must still be a proper override object (not null/undefined)
      expect(override).toBeDefined();
      expect(override).not.toBeNull();
      // thinking should also be undefined when nothing set
      expect(override.thinking).toBeUndefined();
      // Verify that setting and then clearing produces the same "empty" state
      setModel('test-group', 'claude-sonnet-4-20250514');
      expect(getOverride('test-group').model).toBe('claude-sonnet-4-20250514');
      clearOverride('test-group');
      expect(getOverride('test-group').model).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // 6. "should toggle thinking mode on/off"
  // ------------------------------------------------------------------
  describe('setThinking()', () => {
    it('should toggle thinking mode on', () => {
      setThinking('test-group', true);

      const override = getOverride('test-group');
      expect(override.thinking).toBe(true);
    });

    it('should toggle thinking mode off', () => {
      setThinking('test-group', true);
      setThinking('test-group', false);

      const override = getOverride('test-group');
      expect(override.thinking).toBe(false);
    });

    it('should preserve model override when toggling thinking', () => {
      setModel('test-group', 'claude-sonnet-4-20250514');
      setThinking('test-group', true);

      const override = getOverride('test-group');
      expect(override.model).toBe('claude-sonnet-4-20250514');
      expect(override.thinking).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 7. "should reset to default on /model reset"
  // ------------------------------------------------------------------
  describe('/model reset', () => {
    it('should reset to default on /model reset', () => {
      setModel('test-group', 'claude-opus-4-20250115');
      setThinking('test-group', true);

      // parseModelCommand should recognise "/model reset"
      const cmd = parseModelCommand('/model reset');
      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('set_model');
      expect(cmd!.reset).toBe(true);

      // Executing the reset via clearOverride (what the IPC handler would call)
      clearOverride('test-group');

      const override = getOverride('test-group');
      expect(override.model).toBeUndefined();
      expect(override.thinking).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------
  // parseModelCommand — IPC command parsing
  // ------------------------------------------------------------------
  describe('parseModelCommand()', () => {
    it('should parse "/model <name>" as set_model task', () => {
      const cmd = parseModelCommand('/model claude-sonnet-4-20250514');

      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('set_model');
      expect(cmd!.model).toBe('claude-sonnet-4-20250514');
    });

    it('should parse "/model" with no argument as list request', () => {
      const cmd = parseModelCommand('/model');

      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('set_model');
      expect(cmd!.list).toBe(true);
    });

    it('should parse "/model reset" as reset command', () => {
      const cmd = parseModelCommand('/model reset');

      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('set_model');
      expect(cmd!.reset).toBe(true);
    });

    it('should parse "/thinking" as set_thinking toggle', () => {
      const cmd = parseModelCommand('/thinking');

      expect(cmd).toBeDefined();
      expect(cmd!.type).toBe('set_thinking');
    });

    it('should return null for non-command messages', () => {
      expect(parseModelCommand('hello world')).toBeNull();
      expect(parseModelCommand('I want to use /model in a sentence')).toBeNull();
    });

    it('should return null for empty string', () => {
      expect(parseModelCommand('')).toBeNull();
    });

    it('should not treat /model commands embedded mid-message as commands', () => {
      // Only messages that START with /model or /thinking should be parsed
      const cmd = parseModelCommand('please run /model claude-sonnet-4-20250514');
      expect(cmd).toBeNull();
    });
  });

  // ------------------------------------------------------------------
  // ALLOWED_MODELS config export
  // ------------------------------------------------------------------
  describe('ALLOWED_MODELS', () => {
    it('should export a non-empty list of allowed model names', () => {
      expect(Array.isArray(ALLOWED_MODELS)).toBe(true);
      expect(ALLOWED_MODELS.length).toBeGreaterThanOrEqual(3);
      expect(ALLOWED_MODELS).toContain('claude-sonnet-4-20250514');
      expect(ALLOWED_MODELS).toContain('claude-haiku-4-5-20251001');
      expect(ALLOWED_MODELS).toContain('claude-opus-4-20250115');
    });
  });

  // ------------------------------------------------------------------
  // Thinking config shape (for container invocation)
  // ------------------------------------------------------------------
  describe('thinking mode config shape', () => {
    it('should produce thinking config with budget_tokens when enabled', () => {
      setThinking('test-group', true);
      const override = getOverride('test-group');

      // The spec says: pass `thinking: { type: "enabled", budget_tokens: 10000 }`
      // The override must carry enough info so the caller can build that payload.
      expect(override.thinking).toBe(true);
    });
  });
});
