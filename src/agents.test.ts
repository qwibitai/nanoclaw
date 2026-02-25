import { describe, it, expect, beforeEach, vi } from 'vitest';
import { _initTestDatabase, getAgentDefinition, getProviderImage, setAgentDefinition, setProviderImage } from './db.js';
import { getLeadAgentId, loadAgentsConfig, resolveAgentImage } from './agents.js';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config — we'll override AGENTS_CONFIG_PATH per test via fs mock
vi.mock('./config.js', () => ({
  AGENTS_CONFIG_PATH: '/fake/agents.yaml',
}));

// We'll control fs.readFileSync to return test YAML
const mockReadFileSync = vi.fn();
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: (...args: unknown[]) => {
        // Only intercept our config path
        if (args[0] === '/fake/agents.yaml') {
          return mockReadFileSync();
        }
        return actual.readFileSync(args[0] as string, args[1] as BufferEncoding);
      },
    },
  };
});

beforeEach(() => {
  _initTestDatabase();
  mockReadFileSync.mockReset();
});

describe('loadAgentsConfig', () => {
  it('loads valid config and seeds DB', () => {
    mockReadFileSync.mockReturnValue(`
images:
  claude: cambot-agent-claude:latest

lead: claude-default

agents:
  claude-default:
    provider: claude
    model: claude-sonnet-4-6
    secrets:
      - ANTHROPIC_API_KEY
      - CLAUDE_CODE_OAUTH_TOKEN
`);

    loadAgentsConfig();

    // Provider image seeded
    expect(getProviderImage('claude')).toBe('cambot-agent-claude:latest');

    // Agent definition seeded
    const def = getAgentDefinition('claude-default');
    expect(def).toBeDefined();
    expect(def!.provider).toBe('claude');
    expect(def!.model).toBe('claude-sonnet-4-6');
    expect(def!.secretKeys).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);

    // Lead agent set
    expect(getLeadAgentId()).toBe('claude-default');
  });

  it('loads config with multiple agents and providers', () => {
    mockReadFileSync.mockReturnValue(`
images:
  claude: cambot-agent-claude:latest
  openai: cambot-agent-openai:latest

lead: claude-default

agents:
  claude-default:
    provider: claude
    model: claude-sonnet-4-6
    secrets:
      - ANTHROPIC_API_KEY
  claude-deep:
    provider: claude
    model: claude-opus-4-6
    personality: Think deeply.
    secrets:
      - ANTHROPIC_API_KEY
  gpt-creative:
    provider: openai
    model: gpt-4o
    personality: Creative and expressive.
    secrets:
      - OPENAI_API_KEY
`);

    loadAgentsConfig();

    expect(getProviderImage('claude')).toBe('cambot-agent-claude:latest');
    expect(getProviderImage('openai')).toBe('cambot-agent-openai:latest');

    expect(getAgentDefinition('claude-default')).toBeDefined();
    expect(getAgentDefinition('claude-deep')!.personality).toBe('Think deeply.');
    expect(getAgentDefinition('gpt-creative')!.provider).toBe('openai');
  });

  it('throws when lead agent does not exist', () => {
    mockReadFileSync.mockReturnValue(`
images:
  claude: cambot-agent-claude:latest

lead: nonexistent-agent

agents:
  claude-default:
    provider: claude
    model: claude-sonnet-4-6
    secrets:
      - ANTHROPIC_API_KEY
`);

    expect(() => loadAgentsConfig()).toThrow('Lead agent "nonexistent-agent" not found');
  });

  it('throws when agent references unknown provider', () => {
    mockReadFileSync.mockReturnValue(`
images:
  claude: cambot-agent-claude:latest

lead: gpt-agent

agents:
  gpt-agent:
    provider: openai
    model: gpt-4o
    secrets:
      - OPENAI_API_KEY
`);

    expect(() => loadAgentsConfig()).toThrow(
      'Agent "gpt-agent" references provider "openai" with no image defined',
    );
  });

  it('throws on invalid YAML structure', () => {
    mockReadFileSync.mockReturnValue(`
images:
  claude: cambot-agent-claude:latest
# missing lead and agents
`);

    expect(() => loadAgentsConfig()).toThrow();
  });
});

describe('resolveAgentImage', () => {
  beforeEach(() => {
    // Seed DB directly instead of going through loadAgentsConfig
    setProviderImage('claude', 'cambot-agent-claude:latest');
    setAgentDefinition({
      id: 'claude-default',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      secretKeys: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    });
  });

  it('resolves agent to container image and secrets', () => {
    const opts = resolveAgentImage('claude-default');
    expect(opts.containerImage).toBe('cambot-agent-claude:latest');
    expect(opts.secretKeys).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('throws for unknown agent', () => {
    expect(() => resolveAgentImage('nonexistent')).toThrow('Agent "nonexistent" not found');
  });

  it('throws when provider image is missing', () => {
    setAgentDefinition({
      id: 'orphaned',
      provider: 'missing-provider',
      model: 'model',
      secretKeys: [],
    });

    expect(() => resolveAgentImage('orphaned')).toThrow(
      'No container image for provider "missing-provider"',
    );
  });
});
