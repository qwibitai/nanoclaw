/**
 * @fileoverview Unit tests for surrogate sanitization utilities
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeSurrogates,
  surrogateReplacer,
  sanitizeObject,
  isValidUTF16,
  escapeXmlWithSanitize,
  safeJsonStringify,
  safeJsonParse,
} from '../surrogate-sanitize.js';

describe('sanitizeSurrogates', () => {
  it('should return non-string values unchanged', () => {
    expect(sanitizeSurrogates(null as any)).toBe(null);
    expect(sanitizeSurrogates(undefined as any)).toBe(undefined);
    expect(sanitizeSurrogates(123 as any)).toBe(123);
  });

  it('should return clean strings unchanged', () => {
    expect(sanitizeSurrogates('hello world')).toBe('hello world');
    expect(sanitizeSurrogates('emoji: 🎉')).toBe('emoji: 🎉');
    expect(sanitizeSurrogates('chinese: 你好')).toBe('chinese: 你好');
  });

  it('should replace lone high surrogates', () => {
    // Lone high surrogate (D800)
    const result = sanitizeSurrogates('test\uD800end');
    expect(result).toBe('test\uFFFDend');
    expect(isValidUTF16(result)).toBe(true);
  });

  it('should replace lone low surrogates', () => {
    // Lone low surrogate (DC00)
    const result = sanitizeSurrogates('test\uDC00end');
    expect(result).toBe('test\uFFFDend');
    expect(isValidUTF16(result)).toBe(true);
  });

  it('should preserve valid surrogate pairs (emojis)', () => {
    const emoji = '🎉'; // U+1F389 = \uD83C\uDF89
    expect(sanitizeSurrogates(emoji)).toBe(emoji);
  });

  it('should preserve valid surrogate pairs (CJK)', () => {
    const cjk = '𠮷'; // U+20BB7 = \uD842\uDFB7
    expect(sanitizeSurrogates(cjk)).toBe(cjk);
  });

  it('should handle multiple lone surrogates', () => {
    const result = sanitizeSurrogates('\uD800\uDC00\uD800');
    // First two form valid pair, third is lone
    expect(result).toBe('\uD800\uDC00\uFFFD');
  });

  it('should handle consecutive lone surrogates', () => {
    const result = sanitizeSurrogates('\uD800\uD801\uD802');
    expect(result).toBe('\uFFFD\uFFFD\uFFFD');
  });
});

describe('surrogateReplacer', () => {
  it('should sanitize string values', () => {
    const obj = { text: 'hello\uD800world' };
    const result = JSON.stringify(obj, surrogateReplacer);
    expect(result).toContain('\uFFFD');
  });

  it('should pass through non-string values', () => {
    expect(surrogateReplacer('key', 123)).toBe(123);
    expect(surrogateReplacer('key', true)).toBe(true);
    expect(surrogateReplacer('key', null)).toBe(null);
  });
});

describe('sanitizeObject', () => {
  it('should sanitize strings', () => {
    expect(sanitizeObject('test\uD800')).toBe('test\uFFFD');
  });

  it('should sanitize array elements', () => {
    const arr = ['a\uD800', 'b\uDC00', 'c'];
    const result = sanitizeObject(arr) as string[];
    expect(result[0]).toBe('a\uFFFD');
    expect(result[1]).toBe('b\uFFFD');
    expect(result[2]).toBe('c');
  });

  it('should sanitize object values', () => {
    const obj = { a: 'x\uD800', b: 'y\uDC00' };
    const result = sanitizeObject(obj) as Record<string, string>;
    expect(result.a).toBe('x\uFFFD');
    expect(result.b).toBe('y\uFFFD');
  });

  it('should sanitize object keys', () => {
    const obj = { 'key\uD800': 'value' };
    const result = sanitizeObject(obj) as Record<string, string>;
    expect(Object.keys(result)[0]).toBe('key\uFFFD');
  });

  it('should handle nested objects', () => {
    const obj = { outer: { inner: 'test\uD800' } };
    const result = sanitizeObject(obj) as any;
    expect(result.outer.inner).toBe('test\uFFFD');
  });

  it('should pass through primitives', () => {
    expect(sanitizeObject(123)).toBe(123);
    expect(sanitizeObject(true)).toBe(true);
    expect(sanitizeObject(null)).toBe(null);
  });
});

describe('isValidUTF16', () => {
  it('should return true for valid strings', () => {
    expect(isValidUTF16('hello')).toBe(true);
    expect(isValidUTF16('🎉')).toBe(true);
    expect(isValidUTF16('你好')).toBe(true);
  });

  it('should return false for lone high surrogates', () => {
    expect(isValidUTF16('test\uD800')).toBe(false);
  });

  it('should return false for lone low surrogates', () => {
    expect(isValidUTF16('test\uDC00')).toBe(false);
  });

  it('should return true for non-strings', () => {
    expect(isValidUTF16(null as any)).toBe(true);
    expect(isValidUTF16(123 as any)).toBe(true);
  });
});

describe('escapeXmlWithSanitize', () => {
  it('should escape XML special characters', () => {
    expect(escapeXmlWithSanitize('<>&"\'')).toBe('&lt;&gt;&amp;&quot;&apos;');
  });

  it('should sanitize surrogates before escaping', () => {
    const result = escapeXmlWithSanitize('<\uD800>');
    expect(result).toBe('&lt;\uFFFD&gt;');
  });
});

describe('safeJsonStringify', () => {
  it('should stringify objects with sanitized strings', () => {
    const obj = { text: 'hello\uD800world' };
    const result = safeJsonStringify(obj);
    expect(result).toContain('\uFFFD');
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('should support indentation', () => {
    const obj = { a: 1 };
    const result = safeJsonStringify(obj, 2);
    expect(result).toContain('\n');
  });
});

describe('safeJsonParse', () => {
  it('should parse valid JSON', () => {
    const result = safeJsonParse('{"a":1}');
    expect(result).toEqual({ a: 1 });
  });

  it('should sanitize strings during parsing', () => {
    const json = '{"text":"hello\\ud800world"}';
    const result = safeJsonParse(json) as { text: string };
    expect(result.text).toContain('\uFFFD');
  });

  it('should throw on invalid JSON', () => {
    expect(() => safeJsonParse('not json')).toThrow();
  });
});

describe('integration: JSONL transcript scenario', () => {
  it('should handle realistic bash output with binary data', () => {
    // Simulate bash output that might contain surrogates
    const bashOutput = {
      type: 'tool_result',
      content: 'file contents: \uD800\uDC00 binary: \uD800',
      timestamp: '2024-01-01T00:00:00Z',
    };

    // Stringify for storage
    const stored = safeJsonStringify(bashOutput);
    
    // Should be valid JSON
    expect(() => JSON.parse(stored)).not.toThrow();
    
    // Parse back
    const restored = safeJsonParse(stored) as any;
    
    // Content should be sanitized
    expect(isValidUTF16(restored.content)).toBe(true);
  });

  it('should process multiple JSONL lines', () => {
    const lines = [
      { id: 1, text: 'clean' },
      { id: 2, text: 'has\uD800surrogate' },
      { id: 3, text: 'emoji🎉works' },
    ];

    const sanitized = lines.map(line => safeJsonParse(safeJsonStringify(line)));
    
    expect((sanitized[0] as any).text).toBe('clean');
    expect((sanitized[1] as any).text).toContain('\uFFFD');
    expect((sanitized[2] as any).text).toBe('emoji🎉works');
  });
});
