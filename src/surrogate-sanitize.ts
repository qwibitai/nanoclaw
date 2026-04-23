/**
 * @fileoverview Surrogate sanitization utilities
 * 
 * Handles lone UTF-16 surrogates that can appear in Bash tool output and break
 * JSON parsing when stored in session transcripts.
 * 
 * @module surrogate-sanitize
 * 
 * @example
 * ```ts
 * import { sanitizeSurrogates, safeJsonStringify } from './surrogate-sanitize';
 * 
 * // Sanitize a string
 * const clean = sanitizeSurrogates('text with \uD800 lone surrogate');
 * 
 * // Safe JSON operations
 * const json = safeJsonStringify({ content: bashOutput });
 * ```
 */

/**
 * Regex pattern matching lone surrogates:
 * - Lone high surrogates (U+D800-U+DBFF) not followed by low surrogate
 * - Lone low surrogates (U+DC00-U+DFFF) not preceded by high surrogate
 */
const LONE_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Replacement character (U+FFFD) for invalid Unicode sequences
 * @see https://en.wikipedia.org/wiki/Specials_(Unicode_block)#Replacement_character
 */
const REPLACEMENT_CHAR = '\uFFFD';

/**
 * Sanitizes a string by replacing lone surrogates with U+FFFD
 * 
 * @param str - Input string that may contain lone surrogates
 * @returns Sanitized string with lone surrogates replaced by U+FFFD
 * 
 * @example
 * ```ts
 * sanitizeSurrogates('test\uD800'); // Returns 'test\uFFFD'
 * sanitizeSurrogates('emoji🎉');    // Returns 'emoji🎉' (unchanged)
 * ```
 */
export function sanitizeSurrogates(str: string): string {
  if (typeof str !== 'string') {
    return str;
  }

  // Quick check: if no surrogates at all, return early
  if (!/[\uD800-\uDFFF]/.test(str)) {
    return str;
  }

  return str.replace(LONE_SURROGATE_PATTERN, REPLACEMENT_CHAR);
}

/**
 * JSON.stringify replacer that sanitizes all string values
 *
 * @param _key - Object key (unused)
 * @param value - Value to process
 * @returns Sanitized value if string, otherwise unchanged
 */
export function surrogateReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeSurrogates(value);
  }
  return value;
}

/**
 * Recursively sanitizes all strings in an object/array
 *
 * @param obj - Object or array to sanitize
 * @returns Deep copy with all strings sanitized
 */
export function sanitizeObject(obj: unknown): unknown {
  if (typeof obj === 'string') {
    return sanitizeSurrogates(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map(sanitizeObject);
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[sanitizeSurrogates(key)] = sanitizeObject(value);
    }
    return result;
  }

  return obj;
}

/**
 * Validates that a string contains no lone surrogates
 *
 * @param str - String to validate
 * @returns true if valid, false if contains lone surrogates
 */
export function isValidUTF16(str: string): boolean {
  if (typeof str !== 'string') {
    return true;
  }

  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);

    // High surrogate
    if (code >= 0xD800 && code <= 0xDBFF) {
      // Must be followed by low surrogate
      if (i + 1 >= str.length) {
        return false;
      }
      const next = str.charCodeAt(i + 1);
      if (next < 0xDC00 || next > 0xDFFF) {
        return false;
      }
      i++; // Skip the low surrogate
    }
    // Lone low surrogate
    else if (code >= 0xDC00 && code <= 0xDFFF) {
      return false;
    }
  }

  return true;
}

/**
 * Escapes XML special characters and sanitizes surrogates
 *
 * @param str - Input string
 * @returns XML-safe string with no lone surrogates
 */
export function escapeXmlWithSanitize(str: string): string {
  return sanitizeSurrogates(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Safely stringify JSON with surrogate sanitization
 *
 * @param obj - Object to stringify
 * @param space - Indentation (optional)
 * @returns JSON string with no lone surrogates
 */
export function safeJsonStringify(obj: unknown, space?: string | number): string {
  return JSON.stringify(obj, surrogateReplacer, space);
}

/**
 * Safely parse JSON, sanitizing any lone surrogates in the process
 *
 * @param text - JSON text to parse
 * @returns Parsed object with sanitized strings
 */
export function safeJsonParse(text: string): unknown {
  // First sanitize the input text
  const sanitized = sanitizeSurrogates(text);
  return JSON.parse(sanitized, (_key, value) => {
    if (typeof value === 'string') {
      return sanitizeSurrogates(value);
    }
    return value;
  });
}
