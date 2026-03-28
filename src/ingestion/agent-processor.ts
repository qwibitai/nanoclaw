import { relative } from 'node:path';
import { runContainerAgent } from '../container-runner.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import { PathContext } from './path-parser.js';

export interface AgentProcessorOpts {
  vaultDir: string;
  uploadDir: string;
}

export class AgentProcessor {
  private vaultDir: string;
  private uploadDir: string;

  constructor(opts: AgentProcessorOpts) {
    this.vaultDir = opts.vaultDir;
    this.uploadDir = opts.uploadDir;
  }

  buildPrompt(
    filePath: string,
    fileName: string,
    context: PathContext,
    draftId: string,
  ): string {
    const relativePath = relative(this.uploadDir, filePath);
    const containerFilePath = `/workspace/extra/upload/${relativePath}`;
    const vaultDraftPath = `/workspace/extra/vault/drafts/${draftId}.md`;

    const metadataLines: string[] = [];
    if (context.courseCode)
      metadataLines.push(`- Course code: ${context.courseCode}`);
    if (context.courseName)
      metadataLines.push(`- Course name: ${context.courseName}`);
    if (context.semester) metadataLines.push(`- Semester: ${context.semester}`);
    if (context.year) metadataLines.push(`- Year: ${context.year}`);
    if (context.type) metadataLines.push(`- Material type: ${context.type}`);

    const metadataSection =
      metadataLines.length > 0
        ? `The folder structure suggests:\n${metadataLines.join('\n')}\n\nUse this as a starting point but verify against the document content.`
        : 'No metadata was inferred from the folder structure. Determine all metadata from the document content.';

    return `Process this document and generate study notes.

## Source File

Read this file: ${containerFilePath}
Original filename: ${fileName}

## Inferred Metadata

${metadataSection}

## Output

Write the generated note (with YAML frontmatter) to: ${vaultDraftPath}

The _targetPath in frontmatter should be: courses/${context.courseCode || '_unsorted'}/${context.type || 'unsorted'}/${fileName.replace(/\.[^.]+$/, '.md')}

Follow the instructions in your CLAUDE.md for note format and metadata schema.`;
  }

  async process(
    filePath: string,
    fileName: string,
    context: PathContext,
    draftId: string,
    reviewAgentGroup: RegisteredGroup,
  ): Promise<{ status: 'success' | 'error'; error?: string }> {
    const prompt = this.buildPrompt(filePath, fileName, context, draftId);

    logger.info({ fileName, draftId }, 'Starting agent processing');

    try {
      const output = await runContainerAgent(
        reviewAgentGroup,
        {
          prompt,
          groupFolder: reviewAgentGroup.folder,
          chatJid: `web:review:${draftId}`,
          isMain: false,
        },
        (_proc, _containerName) => {
          // No queue registration needed for ingestion containers
        },
      );

      if (output.status === 'error') {
        logger.error(
          { fileName, draftId, error: output.error },
          'Agent processing failed',
        );
        return { status: 'error', error: output.error };
      }

      logger.info({ fileName, draftId }, 'Agent processing completed');
      return { status: 'success' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ fileName, draftId, err }, 'Agent processing error');
      return { status: 'error', error: message };
    }
  }
}
