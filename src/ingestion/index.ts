import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, rename } from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { FileWatcher } from './file-watcher.js';
import { DoclingClient } from './docling-client.js';
import { parseUploadPath } from './path-parser.js';
import { TypeMappings } from './type-mappings.js';
import { ReviewQueue, DraftInput } from './review-queue.js';
import { VaultUtility } from '../vault/vault-utility.js';
import { createIngestionJob, updateIngestionJobStatus, createReviewItem } from '../db.js';
import { logger } from '../logger.js';

export interface IngestionPipelineOpts {
  uploadDir: string;
  vaultDir: string;
  typeMappingsPath: string;
}

export class IngestionPipeline {
  private watcher: FileWatcher;
  private docling: DoclingClient;
  private typeMappings: TypeMappings;
  private vault: VaultUtility;
  private reviewQueue: ReviewQueue;
  private uploadDir: string;
  private vaultDir: string;

  constructor(opts: IngestionPipelineOpts) {
    this.uploadDir = opts.uploadDir;
    this.vaultDir = opts.vaultDir;
    this.vault = new VaultUtility(opts.vaultDir);
    this.reviewQueue = new ReviewQueue(this.vault);
    this.docling = new DoclingClient();
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
    const relativePath = relative(this.uploadDir, filePath);
    const fileName = basename(filePath);

    logger.info(`ingestion: Processing: ${relativePath}`);

    const context = parseUploadPath(relativePath, this.typeMappings);

    createIngestionJob(
      jobId, filePath, fileName,
      context.courseCode, context.courseName,
      context.semester, context.year, context.type,
    );

    try {
      updateIngestionJobStatus(jobId, 'extracting');

      // Copy original to attachments
      const courseDir = context.courseCode || '_unsorted';
      const attachmentDir = join('attachments', courseDir);
      await mkdir(join(this.vaultDir, attachmentDir), { recursive: true });
      await copyFile(filePath, join(this.vaultDir, attachmentDir, fileName));

      // Extract text and figures via Docling
      let markdown: string;
      let figures: string[] = [];
      let figurePaths: string[] = [];

      if (this.docling.isSupported(fileName)) {
        updateIngestionJobStatus(jobId, 'extracting');
        const result = await this.docling.extract(filePath);
        markdown = result.markdown;
        figures = result.figures;
        figurePaths = result.figurePaths;

        // Copy figures to vault attachments
        if (figures.length > 0) {
          const figDir = join(attachmentDir, 'figures', fileName.replace(/\.[^.]+$/, ''));
          await mkdir(join(this.vaultDir, figDir), { recursive: true });
          for (let i = 0; i < figures.length; i++) {
            await copyFile(figurePaths[i], join(this.vaultDir, figDir, figures[i]));
          }
        }
      } else {
        markdown = `<!-- Unsupported format: ${fileName} -->\n\nOriginal file: [[${fileName}]]`;
      }

      updateIngestionJobStatus(jobId, 'generating');

      // Create draft note
      const draftId = randomUUID();
      const targetFolder = context.type || 'unsorted';
      const courseFolder = context.courseCode || '_unsorted';
      const targetPath = `courses/${courseFolder}/${targetFolder}/${fileName.replace(/\.[^.]+$/, '.md')}`;

      const figureEmbeds = figures.map((f) => `![[${f}]]\n\n**Figure:** _Description pending._`).join('\n\n');
      const fullContent = markdown + (figureEmbeds ? `\n\n## Figures\n\n${figureEmbeds}` : '');

      const draft: DraftInput = {
        id: draftId,
        data: {
          title: fileName.replace(/\.[^.]+$/, ''),
          type: context.type,
          course: context.courseCode,
          course_name: context.courseName,
          semester: context.semester,
          year: context.year,
          source: fileName,
          language: 'auto',
          status: 'draft',
          figures,
          created: new Date().toISOString().split('T')[0],
        },
        content: fullContent,
        targetPath,
      };

      await this.reviewQueue.addDraft(draft);

      createReviewItem(draftId, jobId, `drafts/${draftId}.md`, fileName, context.type, context.courseCode, figures);

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
