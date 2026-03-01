import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyTask,
  selectModel,
  loadModelRoutingConfig,
  DEFAULT_ROUTES,
  ModelRoutingConfigSchema,
  type TaskType,
  type ModelRoutingConfig,
} from './model-router.js';

// Mock dependencies
vi.mock('./group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn(() => '/tmp/test-group'),
}));

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Disable semantic routing so these tests exercise keyword fallback only
  process.env.SEMANTIC_ROUTING_ENABLED = 'false';
});

// ---------------------------------------------------------------------------
// classifyTask
// ---------------------------------------------------------------------------
describe('classifyTask', () => {
  const cases: Array<[string, TaskType]> = [
    // Grunt work
    ['Format this data as CSV', 'grunt'],
    ['Convert the JSON to markdown table', 'grunt'],
    ['Clean up and dedupe this list', 'grunt'],
    ['Summarize this article', 'grunt'],

    // Quick checks
    ['Check the weather in Tokyo', 'quick-check'],
    ['What time is it in Singapore?', 'quick-check'],
    ['Is it raining outside?', 'quick-check'],

    // Research
    ['Research the best CRM tools for startups', 'research'],
    ['Deep dive into competitor pricing strategies', 'research'],
    ['Compare Stripe with Paddle for payments', 'research'],
    ['What are the alternatives to Vercel?', 'research'],

    // Analysis
    ['Analyze our revenue trends from last quarter', 'analysis'],
    ['Evaluate the performance of our email campaigns', 'analysis'],
    ['Audit the security of our API endpoints', 'analysis'],

    // Content
    ['Write a blog post about AI agents', 'content'],
    ['Draft a cold email for investor outreach', 'content'],
    ['Create a Twitter post about our launch', 'content'],
    ['Compose a follow-up email', 'content'],

    // Code
    ['Implement a rate limiter in TypeScript', 'code'],
    ['Debug the login endpoint', 'code'],
    ['Fix the bug in the payment flow', 'code'],
    ['Refactor the database queries', 'code'],

    // Conversation (fallback)
    ['Hey, how are you?', 'conversation'],
    ['Thanks for the help!', 'conversation'],
  ];

  for (const [prompt, expected] of cases) {
    it(`classifies "${prompt.slice(0, 40)}..." as ${expected}`, () => {
      expect(classifyTask(prompt)).toBe(expected);
    });
  }

  it('returns conversation for empty prompt', () => {
    expect(classifyTask('')).toBe('conversation');
  });

  it('returns conversation for gibberish', () => {
    expect(classifyTask('asdfghjkl zxcvbnm')).toBe('conversation');
  });

  it('picks higher-weight match when multiple patterns hit', () => {
    // "Research and analyze" matches both research (weight 20) and analysis (weight 15)
    const result = classifyTask('Research and analyze the market trends');
    expect(result).toBe('research');
  });
});

// ---------------------------------------------------------------------------
// selectModel
// ---------------------------------------------------------------------------
describe('selectModel', () => {
  it('returns default model for conversation', async () => {
    const result = await selectModel('Hey there', DEFAULT_ROUTES);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.taskType).toBe('conversation');
    expect(result.reason).toContain('classified as');
  });

  it('routes grunt work to cheap model', async () => {
    const result = await selectModel('Format this as CSV', DEFAULT_ROUTES);
    expect(result.model).toBe('minimax/minimax-m2.5');
    expect(result.taskType).toBe('grunt');
  });

  it('routes quick-check to cheap model', async () => {
    const result = await selectModel('Check the status', DEFAULT_ROUTES);
    expect(result.model).toBe('minimax/minimax-m2.5');
    expect(result.taskType).toBe('quick-check');
  });

  it('routes research to smart model', async () => {
    const result = await selectModel('Research competitor pricing', DEFAULT_ROUTES);
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.taskType).toBe('research');
  });

  it('explicit model override wins', async () => {
    const result = await selectModel(
      'Format as CSV',
      DEFAULT_ROUTES,
      'google/gemini-2.5-flash',
    );
    expect(result.model).toBe('google/gemini-2.5-flash');
    expect(result.reason).toBe('explicit override');
  });

  it('uses custom config routes', async () => {
    const custom: ModelRoutingConfig = {
      ...DEFAULT_ROUTES,
      routing: {
        ...DEFAULT_ROUTES.routing,
        grunt: 'google/gemini-2.5-flash',
      },
    };
    const result = await selectModel('Format this list', custom);
    expect(result.model).toBe('google/gemini-2.5-flash');
  });
});

// ---------------------------------------------------------------------------
// ModelRoutingConfigSchema validation
// ---------------------------------------------------------------------------
describe('ModelRoutingConfigSchema', () => {
  it('validates correct config', () => {
    const result = ModelRoutingConfigSchema.safeParse(DEFAULT_ROUTES);
    expect(result.success).toBe(true);
  });

  it('rejects missing task types', () => {
    const partial = {
      routing: { research: 'claude-sonnet-4-6' },
      default: 'claude-sonnet-4-6',
    };
    const result = ModelRoutingConfigSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects empty model strings', () => {
    const bad = {
      routing: { ...DEFAULT_ROUTES.routing, grunt: '' },
      default: 'claude-sonnet-4-6',
    };
    const result = ModelRoutingConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects missing default', () => {
    const bad = { routing: DEFAULT_ROUTES.routing };
    const result = ModelRoutingConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadModelRoutingConfig
// ---------------------------------------------------------------------------
describe('loadModelRoutingConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadModelRoutingConfig('test-group', () => '/nonexistent');
    expect(config).toEqual(DEFAULT_ROUTES);
  });

  it('returns defaults when config is invalid', async () => {
    const fsModule = await import('fs');
    const tmpDir = '/tmp/test-model-routing-invalid';
    fsModule.mkdirSync(tmpDir, { recursive: true });
    fsModule.writeFileSync(
      `${tmpDir}/model-routing.json`,
      JSON.stringify({ routing: { only: 'one' } }),
    );

    const config = loadModelRoutingConfig('test', () => tmpDir);
    expect(config).toEqual(DEFAULT_ROUTES);

    // Cleanup
    fsModule.rmSync(tmpDir, { recursive: true });
  });

  it('loads valid custom config', async () => {
    const fsModule = await import('fs');
    const tmpDir = '/tmp/test-model-routing-valid';
    fsModule.mkdirSync(tmpDir, { recursive: true });

    const custom: ModelRoutingConfig = {
      routing: {
        ...DEFAULT_ROUTES.routing,
        grunt: 'google/gemini-2.5-flash',
      },
      default: 'claude-haiku-4-5',
    };
    fsModule.writeFileSync(
      `${tmpDir}/model-routing.json`,
      JSON.stringify(custom),
    );

    const config = loadModelRoutingConfig('test', () => tmpDir);
    expect(config.routing.grunt).toBe('google/gemini-2.5-flash');
    expect(config.default).toBe('claude-haiku-4-5');

    // Cleanup
    fsModule.rmSync(tmpDir, { recursive: true });
  });
});
