import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename, access } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { AgentProcessor } from './agent-processor.js';
import {
  createIngestionJob,
  updateIngestionJobStatus,
  createReviewItem,
} from '../db.js';
import { RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
  getReviewAgentGroup: () => RegisteredGroup | undefined;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private agentProcessor: AgentProcessor;
  private typeMappings: TypeMappings;
  private uploadDir: string;
  private vaultDir: string;
  private getReviewAgentGroup: () => RegisteredGroup | undefined;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.getReviewAgentGroup = opts.getReviewAgentGroup;
    this.agentProcessor = new AgentProcessor({
      vaultDir: opts.vaultDir,
      uploadDir: opts.uploadDir,
    });
    this.typeMappings = new TypeMappings(opts.typeMappingsPath);
    this.watcher = new FileWatcher(opts.uploadDir, (filePath) => {
      this.processFile(filePath).catch((err) => {
        logger.error({ err }, `Error processing ${filePath}: ${err.message}`);
      });
    });
  }

  async start(): Promise<void> {
    await mkdir(this.uploadDir, { recursive: true });
    await this.watcher.start();
    logger.info(`Watching ${this.uploadDir} for new files`);
  }

  async stop(): Promise<void> {
    await this.watcher.stop();
  }

  async processFile(filePath: string): Promise<void> {
    const jobId = randomUUID();
    const draftId = randomUUID();
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    logger.info(`ingestion: Processing: ${relativePath}`);

    const context = parseUploadPath(relativePath, this.typeMappings);

    createIngestionJob(
      jobId,
      filePath,
      fileName,
      context.courseCode,
      context.courseName,
      context.semester,
      context.year,
      context.type,
    );

    try {
      // Copy original to vault attachments
      const courseDir = context.courseCode || '_unsorted';
      const attachmentDir = join('attachments', courseDir);
      await mkdir(join(this.vaultDir, attachmentDir), { recursive: true });
      await copyFile(filePath, join(this.vaultDir, attachmentDir, fileName));

      // Ensure drafts directory exists
      await mkdir(join(this.vaultDir, 'drafts'), { recursive: true });

      // Get the review agent group
      const reviewAgentGroup = this.getReviewAgentGroup();
      if (!reviewAgentGroup) {
        throw new Error('Review agent group not registered');
      }

      // Process with agent
      updateIngestionJobStatus(jobId, 'generating');
      const result = await this.agentProcessor.process(
        filePath,
        fileName,
        context,
        draftId,
        reviewAgentGroup,
      );

      if (result.status === 'error') {
        throw new Error(result.error || 'Agent processing failed');
      }

      // Verify the agent actually wrote the draft file
      const draftPath = join(this.vaultDir, 'drafts', `${draftId}.md`);
      try {
        await access(draftPath);
      } catch {
        throw new Error(`Agent completed but draft file not found at ${draftPath}`);
      }

      // Create review item in DB
      createReviewItem(
        draftId,
        jobId,
        `drafts/${draftId}.md`,
        fileName,
        context.type,
        context.courseCode,
        [],
      );

      // Move original out of upload folder
      const processedDir = join(this.uploadDir, '.processed');
      await mkdir(processedDir, { recursive: true });
      await rename(filePath, join(processedDir, `${jobId}-${fileName}`));

      updateIngestionJobStatus(jobId, 'completed');
      logger.info(`ingestion: Completed: ${relativePath} → draft ${draftId}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      updateIngestionJobStatus(jobId, 'failed', message);
      logger.error(`ingestion: Failed: ${relativePath} — ${message}`);
    }
  }
}
