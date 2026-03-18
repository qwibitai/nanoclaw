import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AdminEntry,
  computePriority,
  EscalationConfig,
  loadEscalationConfig,
  resolveNotificationTargets,
} from './escalation.js';

let tmpDir: string;

function cfgPath(name = 'escalation.yaml'): string {
  return path.join(tmpDir, name);
}

function writeYaml(content: string, name?: string): string {
  const p = cfgPath(name);
  fs.writeFileSync(p, content);
  return p;
}

// Minimal valid config for reuse in tests
function makeValidConfig(
  overrides: Partial<EscalationConfig> = {},
): EscalationConfig {
  return {
    admins: [
      {
        name: 'Alice',
        role: 'technical',
        email: 'alice@example.com',
        telegram: 'tg:111',
      },
      {
        name: 'Bob',
        role: 'domain',
        email: 'bob@example.com',
        telegram: 'tg:222',
      },
    ],
    routing: {
      domain: { primary: 'Bob', cc: 'Alice' },
      technical: { primary: 'Alice', cc: 'Bob' },
    },
    gap_types: {
      information_expected: {
        base_weight: 3,
        status: 'needs_input',
        routing: 'domain',
      },
      capability_expected: {
        base_weight: 2,
        status: 'needs_input',
        routing: 'technical',
      },
      capability_unexpected: {
        base_weight: 0,
        status: 'needs_approval',
        routing: 'technical',
      },
    },
    signals: {
      admin_initiated: { weight: 2 },
      customer_waiting: { weight: 2 },
      main_channel: { weight: 1 },
    },
    priority_levels: {
      critical: 5,
      high: 3,
      normal: 1,
      low: 0,
    },
    notification: {
      critical: ['telegram', 'email'],
      high: ['telegram', 'email'],
      normal: ['email'],
      low: [],
    },
    meanwhile: {
      needs_input: 'Checking with the team.',
      needs_approval: 'Let me check with the team.',
    },
    ...overrides,
  };
}

const VALID_YAML = `
admins:
  - name: Alice
    role: technical
    email: alice@example.com
    telegram: "tg:111"
  - name: Bob
    role: domain
    email: bob@example.com
    telegram: "tg:222"

routing:
  domain:
    primary: Bob
    cc: Alice
  technical:
    primary: Alice
    cc: Bob

gap_types:
  information_expected:
    base_weight: 3
    status: needs_input
    routing: domain
    description: Missing business data
  capability_expected:
    base_weight: 2
    status: needs_input
    routing: technical
  capability_unexpected:
    base_weight: 0
    status: needs_approval
    routing: technical

signals:
  admin_initiated:
    weight: 2
  customer_waiting:
    weight: 2
  main_channel:
    weight: 1

priority_levels:
  critical: 5
  high: 3
  normal: 1
  low: 0

notification:
  critical: [telegram, email]
  high: [telegram, email]
  normal: [email]
  low: []

meanwhile:
  needs_input: "Checking with the team."
  needs_approval: "Let me check with the team."
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'escalation-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// INVARIANT: loadEscalationConfig returns a valid EscalationConfig for valid YAML,
// null for missing/invalid files, and logs warnings for malformed entries.
describe('loadEscalationConfig', () => {
  it('parses valid escalation YAML into an EscalationConfig', () => {
    const p = writeYaml(VALID_YAML);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.admins).toHaveLength(2);
    expect(cfg!.admins[0].name).toBe('Alice');
    expect(cfg!.admins[1].name).toBe('Bob');
    expect(cfg!.routing.domain.primary).toBe('Bob');
    expect(cfg!.routing.technical.cc).toBe('Bob');
    expect(cfg!.gap_types.information_expected.base_weight).toBe(3);
    expect(cfg!.gap_types.capability_unexpected.status).toBe('needs_approval');
    expect(cfg!.signals.admin_initiated.weight).toBe(2);
    expect(cfg!.priority_levels.critical).toBe(5);
    expect(cfg!.notification.critical).toEqual(['telegram', 'email']);
    expect(cfg!.notification.low).toEqual([]);
    expect(cfg!.meanwhile?.needs_input).toBe('Checking with the team.');
  });

  it('returns null when the file does not exist', () => {
    const cfg = loadEscalationConfig(cfgPath('nonexistent.yaml'));
    expect(cfg).toBeNull();
  });

  it('returns null for malformed YAML', () => {
    const p = writeYaml('{{{{ not yaml at all ::::');
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when YAML is not an object (e.g. a string)', () => {
    const p = writeYaml('"just a string"');
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when admins section is missing', () => {
    const p = writeYaml(`
routing:
  domain:
    primary: Bob
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when admins array is empty', () => {
    const p = writeYaml(`
admins: []
routing:
  domain:
    primary: Bob
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('skips invalid admin entries but keeps valid ones', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
  - name: ""
    role: technical
  - role: domain
    email: nobody@example.com
routing:
  technical:
    primary: Alice
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: technical
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.admins).toHaveLength(1);
    expect(cfg!.admins[0].name).toBe('Alice');
  });

  it('returns null when all admins are invalid', () => {
    const p = writeYaml(`
admins:
  - name: ""
    role: technical
  - role: domain
routing:
  domain:
    primary: X
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when routing section is missing', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when gap_types section is missing', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  domain:
    primary: Alice
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('returns null when priority_levels section is missing', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  domain:
    primary: Alice
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).toBeNull();
  });

  it('skips invalid routing entries', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  good:
    primary: Alice
  bad:
    cc: only-cc-no-primary
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: good
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.routing.good).toBeDefined();
    expect(cfg!.routing.bad).toBeUndefined();
  });

  it('skips invalid gap type entries', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  technical:
    primary: Alice
gap_types:
  valid_gap:
    base_weight: 2
    status: needs_input
    routing: technical
  invalid_gap:
    base_weight: not_a_number
    status: needs_input
    routing: technical
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.gap_types.valid_gap).toBeDefined();
    expect(cfg!.gap_types.invalid_gap).toBeUndefined();
  });

  it('skips invalid signal entries', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  technical:
    primary: Alice
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: technical
signals:
  valid_signal:
    weight: 2
  invalid_signal:
    weight: not_a_number
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.signals.valid_signal).toBeDefined();
    expect(cfg!.signals.invalid_signal).toBeUndefined();
  });

  it('handles missing signals section gracefully', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  technical:
    primary: Alice
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: technical
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.signals).toEqual({});
  });

  it('handles missing notification section gracefully', () => {
    const p = writeYaml(`
admins:
  - name: Alice
    role: technical
    email: alice@example.com
routing:
  technical:
    primary: Alice
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: technical
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.notification).toEqual({});
  });

  it('preserves description fields on gap types and signals', () => {
    const p = writeYaml(VALID_YAML);
    const cfg = loadEscalationConfig(p);
    expect(cfg!.gap_types.information_expected.description).toBe(
      'Missing business data',
    );
  });

  it('parses admin with only email (no telegram)', () => {
    const p = writeYaml(`
admins:
  - name: EmailOnly
    role: domain
    email: emailonly@example.com
routing:
  domain:
    primary: EmailOnly
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.admins[0].telegram).toBeUndefined();
    expect(cfg!.admins[0].email).toBe('emailonly@example.com');
  });

  it('parses admin with only telegram (no email)', () => {
    const p = writeYaml(`
admins:
  - name: TgOnly
    role: technical
    telegram: "tg:999"
routing:
  technical:
    primary: TgOnly
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: technical
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.admins[0].email).toBeUndefined();
    expect(cfg!.admins[0].telegram).toBe('tg:999');
  });

  it('rejects admin with neither email nor telegram', () => {
    const p = writeYaml(`
admins:
  - name: NoContact
    role: technical
  - name: Valid
    role: domain
    email: valid@example.com
routing:
  domain:
    primary: Valid
gap_types:
  info:
    base_weight: 1
    status: needs_input
    routing: domain
priority_levels:
  low: 0
`);
    const cfg = loadEscalationConfig(p);
    expect(cfg).not.toBeNull();
    expect(cfg!.admins).toHaveLength(1);
    expect(cfg!.admins[0].name).toBe('Valid');
  });
});

// INVARIANT: computePriority must correctly sum base_weight + applicable signal weights,
// then map the score to the highest priority level whose threshold is met.
describe('computePriority', () => {
  const config = makeValidConfig();

  it('returns base weight score with no active signals', () => {
    const result = computePriority(config, 'information_expected', {});
    // base_weight=3, no signals => score=3 => high (threshold 3)
    expect(result.score).toBe(3);
    expect(result.level).toBe('high');
    expect(result.gapType.base_weight).toBe(3);
    expect(result.routing.primary).toBe('Bob');
  });

  it('maps capability_unexpected (weight 0) to low with no signals', () => {
    const result = computePriority(config, 'capability_unexpected', {});
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
  });

  it('maps capability_expected (weight 2) to normal with no signals', () => {
    const result = computePriority(config, 'capability_expected', {});
    expect(result.score).toBe(2);
    expect(result.level).toBe('normal');
  });

  it('adds admin_initiated signal weight', () => {
    const result = computePriority(config, 'capability_expected', {
      admin_initiated: true,
    });
    // base=2 + admin_initiated=2 => 4 => high (threshold 3)
    expect(result.score).toBe(4);
    expect(result.level).toBe('high');
  });

  it('adds customer_waiting signal weight', () => {
    const result = computePriority(config, 'capability_unexpected', {
      customer_waiting: true,
    });
    // base=0 + customer_waiting=2 => 2 => normal (threshold 1)
    expect(result.score).toBe(2);
    expect(result.level).toBe('normal');
  });

  it('adds main_channel signal weight', () => {
    const result = computePriority(config, 'capability_unexpected', {
      main_channel: true,
    });
    // base=0 + main_channel=1 => 1 => normal (threshold 1)
    expect(result.score).toBe(1);
    expect(result.level).toBe('normal');
  });

  it('stacks multiple signals correctly', () => {
    const result = computePriority(config, 'information_expected', {
      admin_initiated: true,
      customer_waiting: true,
    });
    // base=3 + admin=2 + customer=2 => 7 => critical (threshold 5)
    expect(result.score).toBe(7);
    expect(result.level).toBe('critical');
  });

  it('stacks all three signals', () => {
    const result = computePriority(config, 'capability_expected', {
      admin_initiated: true,
      customer_waiting: true,
      main_channel: true,
    });
    // base=2 + 2 + 2 + 1 => 7 => critical
    expect(result.score).toBe(7);
    expect(result.level).toBe('critical');
  });

  it('ignores signals set to false', () => {
    const result = computePriority(config, 'capability_unexpected', {
      admin_initiated: false,
      customer_waiting: false,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
  });

  it('ignores unknown signal names', () => {
    const result = computePriority(config, 'capability_unexpected', {
      unknown_signal: true,
    });
    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
  });

  it('throws for unknown gap type', () => {
    expect(() => computePriority(config, 'nonexistent_gap', {})).toThrow(
      'Unknown gap type: nonexistent_gap',
    );
  });

  it('throws when gap type references unknown routing category', () => {
    const badConfig = makeValidConfig({
      gap_types: {
        broken: {
          base_weight: 1,
          status: 'needs_input',
          routing: 'nonexistent_routing',
        },
      },
    });
    expect(() => computePriority(badConfig, 'broken', {})).toThrow(
      'unknown routing category',
    );
  });

  it('resolves routing entry correctly per gap type', () => {
    // information_expected routes to "domain" => primary=Bob
    const domainResult = computePriority(config, 'information_expected', {});
    expect(domainResult.routing.primary).toBe('Bob');
    expect(domainResult.routing.cc).toBe('Alice');

    // capability_expected routes to "technical" => primary=Alice
    const techResult = computePriority(config, 'capability_expected', {});
    expect(techResult.routing.primary).toBe('Alice');
    expect(techResult.routing.cc).toBe('Bob');
  });

  // Threshold boundary tests
  it('maps score exactly at critical threshold (5) to critical', () => {
    const result = computePriority(config, 'information_expected', {
      admin_initiated: true,
    });
    // base=3 + admin=2 => 5 => critical (threshold 5)
    expect(result.score).toBe(5);
    expect(result.level).toBe('critical');
  });

  it('maps score just below critical (4) to high', () => {
    const result = computePriority(config, 'capability_expected', {
      admin_initiated: true,
    });
    // base=2 + admin=2 => 4 => high (threshold 3)
    expect(result.score).toBe(4);
    expect(result.level).toBe('high');
  });

  it('maps score exactly at high threshold (3) to high', () => {
    const result = computePriority(config, 'information_expected', {});
    // base=3 => high (threshold 3)
    expect(result.score).toBe(3);
    expect(result.level).toBe('high');
  });

  it('maps score exactly at normal threshold (1) to normal', () => {
    const result = computePriority(config, 'capability_unexpected', {
      main_channel: true,
    });
    // base=0 + main_channel=1 => 1 => normal (threshold 1)
    expect(result.score).toBe(1);
    expect(result.level).toBe('normal');
  });
});

// INVARIANT: resolveNotificationTargets must return the correct admins with
// the channels they support, filtered by what the priority level allows.
describe('resolveNotificationTargets', () => {
  const config = makeValidConfig();

  it('returns empty array for low priority (no channels configured)', () => {
    const targets = resolveNotificationTargets(config, 'low');
    expect(targets).toEqual([]);
  });

  it('returns email-only targets for normal priority', () => {
    const targets = resolveNotificationTargets(config, 'normal');
    // Both Alice and Bob have email
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.channels).toContain('email');
      expect(t.channels).not.toContain('telegram');
    }
  });

  it('returns telegram and email targets for critical priority', () => {
    const targets = resolveNotificationTargets(config, 'critical');
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.channels).toContain('telegram');
      expect(t.channels).toContain('email');
    }
  });

  it('returns telegram and email targets for high priority', () => {
    const targets = resolveNotificationTargets(config, 'high');
    expect(targets.length).toBeGreaterThan(0);
    for (const t of targets) {
      expect(t.channels).toContain('telegram');
      expect(t.channels).toContain('email');
    }
  });

  it('assigns primary and cc roles from routing entries', () => {
    const targets = resolveNotificationTargets(config, 'critical');
    const roles = targets.map((t) => ({ name: t.admin.name, role: t.role }));
    // domain routing processed first: primary=Bob, cc=Alice
    // technical routing: primary=Alice (already seen as cc), cc=Bob (already seen)
    // Deduplication means first occurrence wins the role assignment
    expect(roles).toContainEqual({ name: 'Bob', role: 'primary' });
    expect(roles).toContainEqual({ name: 'Alice', role: 'cc' });
  });

  it('returns empty array for unknown priority level', () => {
    const targets = resolveNotificationTargets(config, 'nonexistent');
    expect(targets).toEqual([]);
  });

  it('filters out telegram channel for email-only admin', () => {
    const emailOnlyConfig = makeValidConfig({
      admins: [
        { name: 'EmailOnly', role: 'domain', email: 'e@x.com' } as AdminEntry,
      ],
      routing: {
        domain: { primary: 'EmailOnly' },
      },
    });
    const targets = resolveNotificationTargets(emailOnlyConfig, 'critical');
    expect(targets).toHaveLength(1);
    expect(targets[0].channels).toEqual(['email']);
    expect(targets[0].channels).not.toContain('telegram');
  });

  it('filters out email channel for telegram-only admin', () => {
    const tgOnlyConfig = makeValidConfig({
      admins: [
        {
          name: 'TgOnly',
          role: 'technical',
          telegram: 'tg:999',
        } as AdminEntry,
      ],
      routing: {
        technical: { primary: 'TgOnly' },
      },
    });
    const targets = resolveNotificationTargets(tgOnlyConfig, 'critical');
    expect(targets).toHaveLength(1);
    expect(targets[0].channels).toEqual(['telegram']);
  });

  it('deduplicates admins across routing categories', () => {
    // Alice appears as primary in "technical" and cc in "domain"
    const targets = resolveNotificationTargets(config, 'critical');
    const adminNames = targets.map((t) => t.admin.name);
    const uniqueNames = [...new Set(adminNames)];
    expect(adminNames.length).toBe(uniqueNames.length);
  });

  it('handles routing entry without cc', () => {
    const noCcConfig = makeValidConfig({
      routing: {
        solo: { primary: 'Alice' },
      },
    });
    const targets = resolveNotificationTargets(noCcConfig, 'critical');
    expect(targets).toHaveLength(1);
    expect(targets[0].admin.name).toBe('Alice');
    expect(targets[0].role).toBe('primary');
  });
});
