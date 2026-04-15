import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { searchActions } from './actions-http.js';
import type { RegisteredAction } from '../api/action.js';

// Exhaustive coverage for the ToolSearch-style query grammar implemented
// by searchActions(). The HTTP-level tests in actions-http.test.ts cover
// the transport; these tests pin down every branch of the algorithm.

const noop: RegisteredAction['handler'] = async () => null;

function act(
  description?: string,
  inputSchema?: Record<string, z.ZodType>,
): RegisteredAction {
  return { description, inputSchema, handler: noop };
}

function mk(
  entries: Record<
    string,
    { description?: string; inputSchema?: Record<string, z.ZodType> }
  >,
): Map<string, RegisteredAction> {
  const map = new Map<string, RegisteredAction>();
  for (const [name, opts] of Object.entries(entries)) {
    map.set(name, act(opts.description, opts.inputSchema));
  }
  return map;
}

function names(
  results: Array<{ name: string }>,
): string[] {
  return results.map((r) => r.name);
}

// ─── Empty / degenerate inputs ─────────────────────────────────────

describe('searchActions — empty / degenerate', () => {
  it('empty string query returns []', () => {
    const m = mk({ a: {}, b: {} });
    expect(searchActions(m, '', 10)).toEqual([]);
  });

  it('whitespace-only query returns []', () => {
    const m = mk({ a: {}, b: {} });
    expect(searchActions(m, '   \t\n  ', 10)).toEqual([]);
  });

  it('empty action map with any query returns []', () => {
    const m = new Map<string, RegisteredAction>();
    expect(searchActions(m, 'anything', 10)).toEqual([]);
    expect(searchActions(m, 'select:foo', 10)).toEqual([]);
    expect(searchActions(m, '+required', 10)).toEqual([]);
  });

  it('maxResults=0 returns []', () => {
    const m = mk({ a: { description: 'abc' }, b: { description: 'abc' } });
    expect(searchActions(m, 'abc', 0)).toEqual([]);
  });
});

// ─── select: mode ──────────────────────────────────────────────────

describe('searchActions — select mode', () => {
  const actions = mk({
    alpha: { description: 'first' },
    beta: { description: 'second', inputSchema: { x: z.string() } },
    gamma: { description: 'third' },
  });

  it('fetches a single name', () => {
    const r = searchActions(actions, 'select:beta', 10);
    expect(names(r)).toEqual(['beta']);
    expect(r[0].description).toBe('second');
  });

  it('preserves list order regardless of map iteration order', () => {
    expect(names(searchActions(actions, 'select:gamma,alpha', 10))).toEqual([
      'gamma',
      'alpha',
    ]);
    expect(names(searchActions(actions, 'select:beta,alpha,gamma', 10))).toEqual(
      ['beta', 'alpha', 'gamma'],
    );
  });

  it('silently drops unknown names in the list', () => {
    expect(
      names(searchActions(actions, 'select:ghost,beta,phantom', 10)),
    ).toEqual(['beta']);
  });

  it('returns [] if every name is unknown', () => {
    expect(searchActions(actions, 'select:ghost,phantom', 10)).toEqual([]);
  });

  it('trims whitespace around names', () => {
    expect(
      names(searchActions(actions, 'select: alpha , beta ,gamma ', 10)),
    ).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('drops empty slots from trailing/leading/duplicate commas', () => {
    expect(names(searchActions(actions, 'select:,alpha,,beta,', 10))).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('caps at maxResults', () => {
    expect(
      names(searchActions(actions, 'select:alpha,beta,gamma', 2)),
    ).toEqual(['alpha', 'beta']);
  });

  it('select with max_results=1 returns single result even if many named', () => {
    expect(names(searchActions(actions, 'select:alpha,beta,gamma', 1))).toEqual(
      ['alpha'],
    );
  });

  it('empty select prefix (no names) returns []', () => {
    expect(searchActions(actions, 'select:', 10)).toEqual([]);
    expect(searchActions(actions, 'select:   ', 10)).toEqual([]);
  });

  it('is case-sensitive for action names', () => {
    // Actions registered with lowercase keys; uppercase lookup misses.
    expect(searchActions(actions, 'select:BETA', 10)).toEqual([]);
  });

  it('emits inputSchema (via emit layer) only for actions that have one', () => {
    const r = searchActions(actions, 'select:alpha,beta', 10);
    expect(r.find((a) => a.name === 'alpha')?.inputSchema).toBeUndefined();
    expect(r.find((a) => a.name === 'beta')?.inputSchema).toBeDefined();
  });
});

// ─── Keyword mode — scoring ────────────────────────────────────────

describe('searchActions — keyword mode', () => {
  it('scores name matches 2x higher than description matches', () => {
    const m = mk({
      alpha_invoice: { description: 'unrelated' }, // name hit = 2
      receipts: { description: 'invoice-like receipts' }, // description hit = 1
    });
    const r = searchActions(m, 'invoice', 10);
    expect(names(r)).toEqual(['alpha_invoice', 'receipts']);
  });

  it('filters out zero-score results (no match anywhere)', () => {
    const m = mk({
      foo: { description: 'bar' },
      abc: { description: 'def' },
    });
    expect(searchActions(m, 'nonexistent', 10)).toEqual([]);
  });

  it('is case-insensitive across both tokens and haystack', () => {
    const m = mk({
      SearchCrm: { description: 'Lookup CUSTOMER' },
    });
    const r = searchActions(m, 'CUSTOMER searchcrm', 10);
    expect(names(r)).toEqual(['SearchCrm']);
  });

  it('sums multiple term hits (each term counted independently)', () => {
    const m = mk({
      invoice_pay: {}, // matches "invoice" (2) + "pay" (2) = 4
      invoice: {}, // matches "invoice" (2) = 2
      payments: {}, // matches "pay" (2) = 2
    });
    const r = searchActions(m, 'invoice pay', 10);
    expect(names(r)).toEqual(['invoice_pay', 'invoice', 'payments']);
  });

  it('breaks ties alphabetically by name', () => {
    const m = mk({
      zebra_x: {},
      alpha_x: {},
      mike_x: {},
    });
    const r = searchActions(m, 'x', 10);
    expect(names(r)).toEqual(['alpha_x', 'mike_x', 'zebra_x']);
  });

  it('description-only matches are ranked below name matches', () => {
    const m = mk({
      name_hit: { description: 'nothing relevant' },
      desc_only: { description: 'matches target in description' },
    });
    // "target" only appears in desc_only's description (score 1).
    // "hit" appears in name_hit's name (score 2).
    const r = searchActions(m, 'target hit', 10);
    expect(r[0].name).toBe('name_hit');
    expect(names(r)).toContain('desc_only');
  });

  it('actions with undefined description still match by name', () => {
    const m = mk({
      foo_bar: {},
    });
    expect(names(searchActions(m, 'foo', 10))).toEqual(['foo_bar']);
  });

  it('actions with empty string description behave like undefined', () => {
    const m = mk({
      foo_bar: { description: '' },
    });
    expect(names(searchActions(m, 'foo', 10))).toEqual(['foo_bar']);
  });

  it('maxResults caps the ranked list', () => {
    const m = mk({
      match_1: { description: 'relevant' },
      match_2: { description: 'relevant' },
      match_3: { description: 'relevant' },
    });
    expect(searchActions(m, 'relevant', 2).length).toBe(2);
    expect(searchActions(m, 'relevant', 1).length).toBe(1);
  });

  it('substring matching means partial tokens still match', () => {
    const m = mk({ search_crm: {} });
    // "crm" is a substring of the name
    expect(names(searchActions(m, 'crm', 10))).toEqual(['search_crm']);
  });

  it('handles many tokens without collapsing them', () => {
    const m = mk({
      all_four: {}, // will hit on a, l, f, o individually via substring; but 4 distinct words
      none: {},
    });
    const r = searchActions(m, 'all four all four', 10);
    // "all_four" contains "all" and "four" — each term scored independently
    expect(names(r)).toContain('all_four');
  });
});

// ─── + required-substring mode ─────────────────────────────────────

describe('searchActions — + required mode', () => {
  it('single required: only includes actions whose name contains the token', () => {
    const m = mk({
      invoice_pay: {},
      invoice_void: {},
      payments: {},
    });
    const r = searchActions(m, '+invoice', 10);
    expect(names(r).sort()).toEqual(['invoice_pay', 'invoice_void']);
  });

  it('required substring must appear in NAME, not description', () => {
    const m = mk({
      alpha: { description: 'manages invoices' },
      beta_invoice: { description: 'unrelated' },
    });
    const r = searchActions(m, '+invoice', 10);
    expect(names(r)).toEqual(['beta_invoice']);
  });

  it('multiple required substrings — all must appear in name', () => {
    const m = mk({
      alpha_beta_gamma: {},
      alpha_beta: {},
      alpha_gamma: {},
      beta_gamma: {},
    });
    const r = searchActions(m, '+alpha +beta', 10);
    expect(names(r).sort()).toEqual(['alpha_beta', 'alpha_beta_gamma']);
  });

  it('required + ranking terms — all required names included, ranked by remaining', () => {
    const m = mk({
      invoice_void: { description: 'void an invoice' },
      invoice_pay: { description: 'create a payment' },
    });
    // +invoice → both included; "void" ranks invoice_void higher
    const r = searchActions(m, '+invoice void', 10);
    expect(names(r)).toEqual(['invoice_void', 'invoice_pay']);
  });

  it('required with no ranking terms: ranks by the required terms themselves', () => {
    const m = mk({
      invoice: {}, // +invoice — score hits "invoice" in name = 2
      alpha_invoice_beta: {}, // same "invoice" hit = 2
    });
    const r = searchActions(m, '+invoice', 10);
    // Both match; alphabetical tie-break
    expect(names(r)).toEqual(['alpha_invoice_beta', 'invoice']);
  });

  it('required filter excluding everything returns []', () => {
    const m = mk({ foo: {}, bar: {} });
    expect(searchActions(m, '+nonexistent', 10)).toEqual([]);
  });

  it('+required caps at maxResults', () => {
    const m = mk({
      invoice_a: {},
      invoice_b: {},
      invoice_c: {},
      invoice_d: {},
    });
    expect(searchActions(m, '+invoice', 2).length).toBe(2);
  });

  it('bare "+" token (no substring after) is treated as a zero-length required — matches everything', () => {
    const m = mk({ foo: {}, bar: {} });
    // "+" alone: tok.length === 1, falls into ranking group, not required.
    // Zero ranking terms → rankTerms falls back to required (empty) → score 0 for all.
    // required is empty, so no filter; score 0 means not scored (since score > 0 check fails).
    expect(searchActions(m, '+', 10)).toEqual([]);
  });

  it('+required is case-insensitive on the haystack', () => {
    const m = mk({ Search_CRM: {} });
    expect(names(searchActions(m, '+crm', 10))).toEqual(['Search_CRM']);
  });

  it('required + ranking alphabetical tie-break', () => {
    const m = mk({
      invoice_zebra: {},
      invoice_alpha: {},
      invoice_mike: {},
    });
    // +invoice, no ranking → all tie at score 2 → alpha order
    const r = searchActions(m, '+invoice', 10);
    expect(names(r)).toEqual(['invoice_alpha', 'invoice_mike', 'invoice_zebra']);
  });
});

// ─── Grammar edge cases ────────────────────────────────────────────

describe('searchActions — grammar edges', () => {
  it('select: is checked before + (select takes priority even with + inside names)', () => {
    const m = mk({ '+weird_name': {} });
    // Note: our names are alphanumeric/underscore in practice, but the map
    // accepts anything. select: matches literally.
    expect(names(searchActions(m, 'select:+weird_name', 10))).toEqual([
      '+weird_name',
    ]);
  });

  it('multiple spaces between tokens collapse', () => {
    const m = mk({ foo_bar: {} });
    expect(names(searchActions(m, 'foo    bar', 10))).toEqual(['foo_bar']);
  });

  it('tabs and newlines as whitespace separators', () => {
    const m = mk({ foo_bar: {} });
    expect(names(searchActions(m, 'foo\tbar\nbaz', 10))).toEqual(['foo_bar']);
  });

  it('single-character tokens still match (length > 0, not length > 1)', () => {
    const m = mk({ alpha: {}, beta: {} });
    // "a" is a substring of "alpha" and "beta"
    expect(names(searchActions(m, 'a', 10)).sort()).toEqual(['alpha', 'beta']);
  });
});
