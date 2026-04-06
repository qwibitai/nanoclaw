import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

type AuditCase = {
  allowlistedSnippets?: string[];
  filePath: string[];
  forbiddenPatterns?: RegExp[];
  forbiddenSnippets?: string[];
  requiredSnippets?: string[];
};

const localizedCodexCapabilityRegressionPatterns = {
  ja: [
    /`codex`[^。\n]{0,80}remote control[^。\n]{0,20}(?:サポートします|対応します|利用できます)/u,
    /`codex`[^。\n]{0,80}agent teams[^。\n]{0,20}(?:サポートします|対応します|利用できます)/u,
    /`codex`[^。\n]{0,80}provider skills[^。\n]{0,20}(?:サポートします|対応します|利用できます)/u,
  ],
  zh: [
    /`codex`[^。\n]{0,80}(?:支持|可用|可使用)[^。\n]{0,20}remote control/u,
    /`codex`[^。\n]{0,80}(?:支持|可用|可使用)[^。\n]{0,20}agent teams/u,
    /`codex`[^。\n]{0,80}(?:支持|可用|可使用)[^。\n]{0,20}provider skills/u,
    /`codex`[^。\n]{0,80}remote control[^。\n]{0,20}(?<!不)(?<!未)支持/u,
    /`codex`[^。\n]{0,80}agent teams[^。\n]{0,20}(?<!不)(?<!未)支持/u,
    /`codex`[^。\n]{0,80}provider skills[^。\n]{0,20}(?<!不)(?<!未)支持/u,
  ],
} as const;

const specGenericClaudeRuntimeRegressionPatterns = [
  /7\. Router invokes Claude(?: Agent SDK| Code runtime| runtime)?/u,
  /8\. Claude processes message/u,
  /\| `@Assistant \[message\]` \| `@Andy what's the weather\?` \| Talk to Claude(?: Code)? \|/u,
  /→ ✅ Triggers Claude/u,
  /attempting to manipulate Claude's behavior/u,
  /Claude's built-in safety training/u,
  /"Claude Code process exited with code 1"/u,
] as const;

const requirementsCoreProviderNeutralRegressionPatterns = [
  /-\s+\*\*Scheduled tasks\*\* that run Claude(?: Code)?(?: runtime)? and can message back/u,
  /Users can ask Claude to schedule recurring or one-time tasks from any group/u,
  /ask Claude to schedule recurring or one-time tasks/u,
  /Each group has a folder with its own canonical `CLAUDE\.md`/u,
  /Root `groups\/global\/CLAUDE\.md` is read by all groups/u,
  /Each group maintains(?: provider-scoped)? session directories under `data\/sessions\/\{group\}\/\.claude\/`/u,
  /Tasks execute Claude(?: Code)?(?: runtime)? in containerized group context/u,
] as const;

function readRepoFile(...segments: string[]): string {
  return readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

function stripAllowlistedSnippets(
  content: string,
  snippets: string[] = [],
): string {
  return snippets.reduce(
    (currentContent, snippet) => currentContent.split(snippet).join(''),
    content,
  );
}

function expectFileToMatchAudit(auditCase: AuditCase): void {
  const content = readRepoFile(...auditCase.filePath);

  for (const snippet of auditCase.requiredSnippets ?? []) {
    expect(content).toContain(snippet);
  }

  const scrubbedContent = stripAllowlistedSnippets(
    content,
    auditCase.allowlistedSnippets,
  );

  for (const snippet of auditCase.forbiddenSnippets ?? []) {
    expect(scrubbedContent).not.toContain(snippet);
  }

  for (const pattern of auditCase.forbiddenPatterns ?? []) {
    expect(scrubbedContent).not.toMatch(pattern);
  }
}

describe('provider documentation audit', () => {
  it('keeps the public docs aligned on canonical memory and provider selection', () => {
    // Arrange
    const files = [
      {
        filePath: ['README.md'],
        requiredSnippets: [
          'AGENT.md is the canonical memory file.',
          'CLAUDE.md remains a compatibility file for the `claude-code` provider.',
          'Only the main chat can write shared global memory.',
          '`claude-code`',
          '`codex`',
        ],
      },
      {
        filePath: ['README_ja.md'],
        requiredSnippets: [
          '`AGENT.md`が正本のメモリファイルで、`CLAUDE.md`は`claude-code`向けの互換ファイルです。共有グローバルメモリを書き込めるのはメインチャットだけです。',
          'NanoClawのコアはグループごとにプロバイダーを選択します。セッション状態は`data/sessions/<group>/claude-code/`や`data/sessions/<group>/codex/`のようなプロバイダー単位のディレクトリに分離されます。',
          '同梱のコンテナスキルとagent teamsはNanoClaw v1ではClaude専用です。`codex`はチャット、スケジュール、メモリをサポートしますが、remote control・agent teams・provider skillsは未対応として明示的に扱われます。',
        ],
      },
      {
        filePath: ['README_zh.md'],
        requiredSnippets: [
          '`AGENT.md` 是规范的记忆文件，`CLAUDE.md` 则是给 `claude-code` 使用的兼容文件。只有主聊天可以写入共享的全局记忆。',
          'NanoClaw 会按群组选择提供商。会话状态会隔离在 `data/sessions/<group>/claude-code/` 或 `data/sessions/<group>/codex/` 这样的提供商作用域目录中。',
          '内置容器技能和 agent teams 在 NanoClaw v1 中仍然只支持 Claude。`codex` 保留聊天、调度和记忆能力，但会把 remote control、agent teams 和 provider skills 明确报告为不支持。',
        ],
      },
      {
        filePath: ['docs', 'SPEC.md'],
        requiredSnippets: [
          'AGENT.md is the canonical memory file.',
          'CLAUDE.md remains a compatibility file for Claude Code.',
          'data/sessions/{group}/{providerId}/',
          'Only the main group can sync global memory changes back into `AGENT.md`.',
          'Bundled `container/skills/` content is synced only for `claude-code` in v1.',
          '7. Router invokes the active provider runtime:',
          '8. Provider processes message:',
          "| `@Assistant [message]` | `@Andy what's the weather?` | Talk to the active provider |",
        ],
      },
      {
        filePath: ['docs', 'REQUIREMENTS.md'],
        requiredSnippets: [
          'AGENT.md is the canonical memory file.',
          'CLAUDE.md remains a compatibility file for Claude Code.',
          'provider-scoped session directories',
          'Only the main chat writes canonical global memory.',
          '**Scheduled tasks** that run the active provider and can message back',
          'Tasks execute the active provider runtime in containerized group context',
          '`claude-code`',
          '`codex`',
        ],
      },
    ];

    // Act
    for (const file of files) {
      expectFileToMatchAudit(file);
    }

    // Assert
    expect(files).toHaveLength(5);
  });

  it('documents v1 capability boundaries for container skills, agent teams, and Codex fallbacks', () => {
    // Arrange
    const files = [
      {
        filePath: ['README.md'],
        requiredSnippets: [
          'Bundled container skills and agent teams are Claude-only in NanoClaw v1.',
          'Codex keeps chat, scheduling, and memory support but reports remote control, agent teams, and provider skills as unsupported.',
        ],
      },
      {
        filePath: ['container', 'skills', 'status', 'SKILL.md'],
        requiredSnippets: [
          'Claude-only in NanoClaw v1',
          'If the active provider is Codex, report bundled container skills, remote control, and agent teams as unsupported.',
        ],
      },
      {
        filePath: ['container', 'skills', 'capabilities', 'SKILL.md'],
        requiredSnippets: [
          'Claude-only in NanoClaw v1',
          'If the active provider is Codex, report bundled container skills, remote control, and agent teams as unsupported.',
        ],
      },
      {
        filePath: ['CONTRIBUTING.md'],
        requiredSnippets: [
          'Container skills remain Claude-only in v1.',
          'Codex does not load bundled provider skills or agent teams yet.',
        ],
      },
      {
        filePath: ['CLAUDE.md'],
        requiredSnippets: [
          'AGENT.md is the canonical group memory file.',
          'Bundled `container/skills/` content is synced only for `claude-code` in v1.',
        ],
      },
    ];

    // Act
    for (const file of files) {
      expectFileToMatchAudit(file);
    }

    // Assert
    expect(files).toHaveLength(5);
  });

  it('rejects stale Claude-era claims outside explicit migration allowlists', () => {
    // Arrange
    const files: AuditCase[] = [
      {
        filePath: ['README.md'],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical memory file.',
          '`data/sessions/<group>/.claude/`',
          'Codex supports remote control.',
          'Codex supports agent teams.',
          'Codex supports provider skills.',
        ],
      },
      {
        filePath: ['README_ja.md'],
        forbiddenSnippets: ['`data/sessions/<group>/.claude/`'],
        forbiddenPatterns: [
          /`CLAUDE\.md`[^。\n]{0,40}正本のメモリファイル/u,
          ...localizedCodexCapabilityRegressionPatterns.ja,
        ],
      },
      {
        filePath: ['README_zh.md'],
        forbiddenSnippets: ['`data/sessions/<group>/.claude/`'],
        forbiddenPatterns: [
          /`CLAUDE\.md`[^。\n]{0,40}规范的记忆文件/u,
          ...localizedCodexCapabilityRegressionPatterns.zh,
        ],
      },
      {
        filePath: ['docs', 'SPEC.md'],
        allowlistedSnippets: [
          'If only a legacy `CLAUDE.md` exists, NanoClaw seeds `AGENT.md` from it without overwriting the user file',
          '5. Legacy Claude installs may still use `data/sessions/{group}/.claude/` until migrated',
        ],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical memory file.',
          '`data/sessions/{group}/.claude/`',
          '`codex` supports remote control',
          '`codex` supports agent teams',
          '`codex` supports provider skills',
        ],
        forbiddenPatterns: [...specGenericClaudeRuntimeRegressionPatterns],
      },
      {
        filePath: ['docs', 'REQUIREMENTS.md'],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical memory file.',
          '`data/sessions/{group}/.claude/`',
          '`codex` supports remote control',
          '`codex` supports agent teams',
          '`codex` supports provider skills',
        ],
        forbiddenPatterns: [
          ...requirementsCoreProviderNeutralRegressionPatterns,
        ],
      },
      {
        filePath: ['docs', 'SECURITY.md'],
        allowlistedSnippets: [
          'Legacy Claude state may still appear under `data/sessions/{group}/.claude/` during migration.',
        ],
        forbiddenSnippets: ['`data/sessions/{group}/.claude/`'],
      },
      {
        filePath: ['docs', 'DEBUG_CHECKLIST.md'],
        allowlistedSnippets: [
          'Legacy Claude installs may still expose `data/sessions/<group>/.claude/` during migration.',
        ],
        forbiddenSnippets: ['`data/sessions/<group>/.claude/`'],
      },
      {
        filePath: ['CONTRIBUTING.md'],
        forbiddenSnippets: [
          "They are synced into each group's `.claude/skills/` directory when a container starts.",
        ],
      },
      {
        filePath: ['groups', 'main', 'AGENT.md'],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical memory file for this group.',
        ],
      },
      {
        filePath: ['groups', 'main', 'CLAUDE.md'],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical memory file for this group.',
        ],
      },
      {
        filePath: ['groups', 'global', 'AGENT.md'],
        forbiddenSnippets: ['CLAUDE.md is the canonical global memory file.'],
      },
      {
        filePath: ['groups', 'global', 'CLAUDE.md'],
        forbiddenSnippets: ['CLAUDE.md is the canonical global memory file.'],
      },
      {
        filePath: ['CLAUDE.md'],
        forbiddenSnippets: [
          'CLAUDE.md is the canonical group memory file.',
          '`data/sessions/{group}/.claude/`',
        ],
      },
    ];

    // Act
    for (const file of files) {
      expectFileToMatchAudit(file);
    }

    // Assert
    expect(files).toHaveLength(13);
  });

  it('keeps security and debugging guidance aligned with provider-scoped session boundaries', () => {
    // Arrange
    const files = [
      {
        filePath: ['docs', 'SECURITY.md'],
        requiredSnippets: [
          'data/sessions/{group}/{providerId}/',
          'Providers can choose their own in-container home directory, but they cannot widen NanoClaw mount allowlists or IPC policy.',
          'Legacy Claude state may still appear under `data/sessions/{group}/.claude/` during migration.',
        ],
      },
      {
        filePath: ['docs', 'DEBUG_CHECKLIST.md'],
        requiredSnippets: [
          'data/sessions/<group>/<providerId>/',
          '`claude-code` → `data/sessions/<group>/claude-code/`',
          '`codex` → `data/sessions/<group>/codex/`',
        ],
      },
    ];

    // Act
    for (const file of files) {
      expectFileToMatchAudit(file);
    }

    // Assert
    expect(files).toHaveLength(2);
  });

  it('keeps the shipped group templates aligned with canonical AGENT memory and Claude compatibility mirrors', () => {
    // Arrange
    const files = [
      {
        filePath: ['groups', 'main', 'AGENT.md'],
        requiredSnippets: [
          'AGENT.md is the canonical memory file for this group.',
          'CLAUDE.md is only a Claude compatibility mirror.',
          'Only the main chat should write canonical global memory.',
        ],
      },
      {
        filePath: ['groups', 'main', 'CLAUDE.md'],
        requiredSnippets: [
          'This file exists for `claude-code` compatibility.',
          'Edit `AGENT.md` when you want durable memory changes.',
          'Only the main chat should write canonical global memory.',
        ],
      },
      {
        filePath: ['groups', 'global', 'AGENT.md'],
        requiredSnippets: [
          'AGENT.md is the canonical global memory file.',
          'Only the main chat should edit this file directly.',
        ],
      },
      {
        filePath: ['groups', 'global', 'CLAUDE.md'],
        requiredSnippets: [
          'This file exists for `claude-code` compatibility.',
          'Edit `AGENT.md` when you want durable memory changes.',
        ],
      },
    ];

    // Act
    for (const file of files) {
      expectFileToMatchAudit(file);
    }

    // Assert
    expect(files).toHaveLength(4);
  });
});
