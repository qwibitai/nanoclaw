import { describe, test, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

import { _initTestDatabase, setRegisteredGroup } from './db.js';
import { processTaskIpc, IpcDeps } from './ipc.js';
import { RegisteredGroup } from './types.js';

// Mock github-issues module at the top level
vi.mock('./github-issues.js', () => ({
  createGitHubIssue: vi.fn(),
  DEV_CASE_ISSUE_REPO: { owner: 'Garsson-io', repo: 'kaizen' },
}));

// Mock cases module for case_create tests
vi.mock('./cases.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cases.js')>();
  return {
    ...actual,
    createCaseWorkspace: vi.fn().mockReturnValue({
      workspacePath: '/tmp/workspace',
      worktreePath: '/tmp/worktree',
      branchName: 'case/test-branch',
    }),
    generateCaseId: vi.fn().mockReturnValue('case-test-123'),
    generateCaseName: vi.fn().mockReturnValue('260317-0530-test-case'),
    insertCase: vi.fn(),
    getActiveCasesByGithubIssue: vi.fn().mockReturnValue([]),
  };
});

import { createGitHubIssue } from './github-issues.js';
import { insertCase, generateCaseName } from './cases.js';

const mockedCreateGitHubIssue = vi.mocked(createGitHubIssue);
const mockedInsertCase = vi.mocked(insertCase);
const mockedGenerateCaseName = vi.mocked(generateCaseName);

const MAIN_GROUP: RegisteredGroup = {
  name: 'Main',
  folder: 'telegram_main',
  trigger: 'always',
  added_at: '2024-01-01T00:00:00.000Z',
  isMain: true,
};

const WORK_GROUP: RegisteredGroup = {
  name: 'Work',
  folder: 'telegram_work',
  trigger: '@Andy',
  added_at: '2024-01-01T00:00:00.000Z',
};

let groups: Record<string, RegisteredGroup>;
let sendMessage: ReturnType<typeof vi.fn<IpcDeps['sendMessage']>>;
let deps: IpcDeps;

beforeEach(() => {
  _initTestDatabase();

  groups = {
    'tg:111': MAIN_GROUP,
    'tg:222': WORK_GROUP,
  };

  setRegisteredGroup('tg:111', MAIN_GROUP);
  setRegisteredGroup('tg:222', WORK_GROUP);

  sendMessage = vi.fn().mockResolvedValue(undefined);

  deps = {
    sendMessage,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: () => [],
    writeGroupsSnapshot: vi.fn(),
  };

  mockedCreateGitHubIssue.mockReset();
});

// INVARIANT: create_github_issue IPC calls createGitHubIssue on the host
// and writes result back for the MCP tool to read
// SUT: processTaskIpc 'create_github_issue' handler
describe('create_github_issue IPC handler', () => {
  test('calls createGitHubIssue with correct parameters', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Work agent needs help',
        body: 'Detailed problem description',
        labels: ['work-agent', 'needs-dev'],
        requestId: 'req-test-123',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).toHaveBeenCalledWith({
      owner: 'Garsson-io',
      repo: 'kaizen',
      title: 'Work agent needs help',
      body: 'Detailed problem description',
      labels: ['work-agent', 'needs-dev'],
    });
  });

  test('writes result file for MCP tool to read', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    // Mock fs operations for result file
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test issue',
        body: 'Body',
        labels: ['work-agent'],
        requestId: 'req-abc',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    // Find the writeFileSync call that writes the result
    const resultWriteCall = writeSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('req-abc'),
    );
    expect(resultWriteCall).toBeDefined();
    const writtenResult = JSON.parse(resultWriteCall![1] as string);
    expect(writtenResult.success).toBe(true);
    expect(writtenResult.issueUrl).toContain('issues/99');

    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  test('sends Telegram notification on success', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/99',
      issueNumber: 99,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
        labels: [],
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:222',
      expect.stringContaining('issues/99'),
    );
  });

  test('does not send notification on failure', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: false,
      error: 'Token not set',
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
        labels: [],
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });

  test('rejects request with missing title', async () => {
    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        body: 'Missing title',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).not.toHaveBeenCalled();
  });

  test('uses default labels when none provided', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/1',
      issueNumber: 1,
    });

    await processTaskIpc(
      {
        type: 'create_github_issue',
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Test',
        body: 'Body',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: ['work-agent', 'needs-dev'],
      }),
    );
  });
});

// INVARIANT: Dev cases auto-create a GitHub issue for tracking
// SUT: processTaskIpc 'case_create' handler with caseType=dev
describe('case_create auto-creates GitHub issue for dev cases', () => {
  beforeEach(() => {
    // Mock fs for result file writing
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    mockedInsertCase.mockReset();
  });

  test('dev case auto-creates GitHub issue and links it', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/50',
      issueNumber: 50,
    });

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Fix the broken widget',
        caseType: 'dev',
        chatJid: 'tg:111',
        initiator: 'agent',
        requestId: 'req-dev-1',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // GitHub issue should be created with description as title and kaizen label
    expect(mockedCreateGitHubIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'Garsson-io',
        repo: 'kaizen',
        title: 'Fix the broken widget',
        labels: ['kaizen'],
      }),
    );

    // Case should be inserted with the issue number
    expect(mockedInsertCase).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: 50,
        type: 'dev',
      }),
    );
  });

  test('dev case with context structures GitHub issue body', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/55',
      issueNumber: 55,
    });

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Always present category options in selection questions',
        context:
          'Nir asked: when the agent asks the customer to choose a material, it should list the options instead of asking open-ended questions.\n\nRules:\n- If ≤5 options: list all\n- If >5: show 3 + ellipsis',
        caseType: 'dev',
        chatJid: 'tg:111',
        requestId: 'req-dev-ctx',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const call = mockedCreateGitHubIssue.mock.calls[0][0];
    expect(call.title).toBe(
      'Always present category options in selection questions',
    );
    expect(call.body).toContain('## TL;DR');
    expect(call.body).toContain(
      'Always present category options in selection questions',
    );
    expect(call.body).toContain('## Details');
    expect(call.body).toContain('Nir asked');
    expect(call.body).toContain('≤5 options');
  });

  test('dev case without context uses simple body format', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/56',
      issueNumber: 56,
    });

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Fix the broken widget',
        caseType: 'dev',
        chatJid: 'tg:111',
        requestId: 'req-dev-no-ctx',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    const call = mockedCreateGitHubIssue.mock.calls[0][0];
    expect(call.body).not.toContain('## TL;DR');
    expect(call.body).toContain('Fix the broken widget');
    expect(call.body).toContain('Auto-created by dev case');
  });

  test('dev case includes issue URL in result file', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/51',
      issueNumber: 51,
    });

    const writeSpy = vi.mocked(fs.writeFileSync);

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Improve logging',
        caseType: 'dev',
        chatJid: 'tg:111',
        requestId: 'req-dev-2',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // Find the result file write
    const resultWrite = writeSpy.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('req-dev-2'),
    );
    expect(resultWrite).toBeDefined();
    const result = JSON.parse(resultWrite![1] as string);
    expect(result.github_issue).toBe(51);
    expect(result.issue_url).toBe(
      'https://github.com/Garsson-io/kaizen/issues/51',
    );
  });

  test('dev case includes issue URL in Telegram notification', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: true,
      issueUrl: 'https://github.com/Garsson-io/kaizen/issues/52',
      issueNumber: 52,
    });

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Add feature X',
        caseType: 'dev',
        chatJid: 'tg:111',
        requestId: 'req-dev-3',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('https://github.com/Garsson-io/kaizen/issues/52'),
    );
  });

  // INVARIANT: Dev case from non-main group routes to approval gate
  // SUT: processTaskIpc case_create authorization via case-auth.ts
  test('dev case from non-main group routes to approval gate and notifies main', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Fix widget rendering',
        caseType: 'dev',
        chatJid: 'tg:222',
        requestId: 'req-dev-routing',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    // Non-main dev case → suggested status, main group notified for approval
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:111',
      expect.stringContaining('Dev case needs approval'),
    );
  });

  // INVARIANT: Work case notifications go to source group, not main group
  test('work case created from non-main group notifies source group', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Process client order',
        caseType: 'work',
        chatJid: 'tg:222',
        requestId: 'req-work-routing',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    // Notification should go to source group (tg:222), not main
    expect(sendMessage).toHaveBeenCalledWith(
      'tg:222',
      expect.stringContaining('work case created'),
    );
  });

  test('work case does NOT create GitHub issue', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Research market data',
        caseType: 'work',
        chatJid: 'tg:222',
        requestId: 'req-work-1',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedCreateGitHubIssue).not.toHaveBeenCalled();

    expect(mockedInsertCase).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: null,
        type: 'work',
      }),
    );
  });

  test('dev case continues without issue if GitHub API fails', async () => {
    mockedCreateGitHubIssue.mockResolvedValue({
      success: false,
      error: 'GITHUB_TOKEN not configured',
    });

    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Fix something',
        caseType: 'dev',
        chatJid: 'tg:111',
        requestId: 'req-dev-fail',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // Case should still be created, just without github_issue
    expect(mockedInsertCase).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: null,
        type: 'dev',
        priority: null,
        gap_type: null,
      }),
    );
  });

  test('dev case skips issue creation if githubIssue already provided', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Work on kaizen #34',
        caseType: 'dev',
        chatJid: 'tg:111',
        githubIssue: 34,
        requestId: 'req-dev-existing',
      } as any,
      'telegram_main',
      true,
      deps,
    );

    // Should NOT call createGitHubIssue since one was provided
    expect(mockedCreateGitHubIssue).not.toHaveBeenCalled();

    // Case should use the provided issue number
    expect(mockedInsertCase).toHaveBeenCalledWith(
      expect.objectContaining({
        github_issue: 34,
        type: 'dev',
      }),
    );
  });
});

// INVARIANT: case_create passes shortName to generateCaseName when provided.
// SUT: processTaskIpc case_create handler
// VERIFICATION: Mock generateCaseName is called with (description, shortName).
describe('case_create passes shortName to generateCaseName', () => {
  beforeEach(() => {
    vi.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    vi.spyOn(fs, 'writeFileSync').mockReturnValue(undefined);
    mockedGenerateCaseName.mockClear();
  });

  test('shortName is passed through to generateCaseName', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Convert photo to CMYK for Demarco',
        shortName: 'Demarco T. CMYK Magnificent',
        caseType: 'work',
        chatJid: 'tg:222',
        requestId: 'req-short-1',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedGenerateCaseName).toHaveBeenCalledWith(
      'Convert photo to CMYK for Demarco',
      'Demarco T. CMYK Magnificent',
    );
  });

  test('undefined shortName falls back gracefully', async () => {
    await processTaskIpc(
      {
        type: 'case_create',
        description: 'Research market data',
        caseType: 'work',
        chatJid: 'tg:222',
        requestId: 'req-short-2',
      } as any,
      'telegram_work',
      false,
      deps,
    );

    expect(mockedGenerateCaseName).toHaveBeenCalledWith(
      'Research market data',
      undefined,
    );
  });
});
