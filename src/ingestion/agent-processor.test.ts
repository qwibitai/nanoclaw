import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentProcessor } from './agent-processor.js';

// Mock the container runner
vi.mock('../container-runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../db.js', () => ({
  getAllRegisteredGroups: vi.fn(() => ({})),
  setRegisteredGroup: vi.fn(),
}));

describe('AgentProcessor', () => {
  let processor: AgentProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new AgentProcessor({
      vaultDir: '/tmp/test-vault',
      uploadDir: '/tmp/test-upload',
    });
  });

  it('builds a prompt with file path and metadata context', () => {
    const prompt = processor.buildPrompt(
      '/tmp/test-upload/03_TCP.pdf',
      '03_TCP.pdf',
      {
        courseCode: 'IS-1500',
        courseName: 'Digital Samhandling',
        semester: 3,
        year: 2,
        type: 'lecture',
        fileName: '03_TCP.pdf',
      },
      'draft-id-123',
    );

    expect(prompt).toContain('03_TCP.pdf');
    expect(prompt).toContain('IS-1500');
    expect(prompt).toContain('Digital Samhandling');
    expect(prompt).toContain('draft-id-123');
    expect(prompt).toContain('/workspace/extra/upload/03_TCP.pdf');
  });

  it('builds prompt with null metadata gracefully', () => {
    const prompt = processor.buildPrompt(
      '/tmp/test-upload/random.pdf',
      'random.pdf',
      {
        courseCode: null,
        courseName: null,
        semester: null,
        year: null,
        type: null,
        fileName: 'random.pdf',
      },
      'draft-id-456',
    );

    expect(prompt).toContain('random.pdf');
    expect(prompt).toContain('draft-id-456');
    expect(prompt).not.toContain('IS-1500');
  });
});
