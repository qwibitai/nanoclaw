import { VaultUtility, NoteOutput } from '../vault/vault-utility.js';

export interface DraftInput {
  id: string;
  data: Record<string, unknown>;
  content: string;
  targetPath: string;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class ReviewQueue {
  constructor(private readonly vault: VaultUtility) {}

  async addDraft(draft: DraftInput): Promise<void> {
    await this.vault.createNote(`drafts/${draft.id}.md`, {
      data: {
        ...draft.data,
        _targetPath: draft.targetPath,
        status: 'draft',
      },
      content: draft.content,
    });
  }

  async approveDraft(draftId: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    const targetPath = note.data._targetPath as string;
    const { _targetPath: _, ...remainingData } = note.data;

    await this.vault.createNote(targetPath, {
      data: { ...remainingData, status: 'approved' },
      content: note.content,
    });

    await this.vault.deleteNote(draftPath);
  }

  async rejectDraft(draftId: string): Promise<void> {
    await this.vault.deleteNote(`drafts/${draftId}.md`);
  }

  async removeFigure(draftId: string, figureFilename: string): Promise<void> {
    const draftPath = `drafts/${draftId}.md`;
    const note = await this.vault.readNote(draftPath);
    if (!note) {
      throw new Error(`Draft not found: ${draftId}`);
    }

    const embedPattern = new RegExp(
      `!\\[\\[${escapeRegex(figureFilename)}\\]\\]\\s*\\n?\\s*(?:\\*\\*Figure:\\*\\*[^\\n]*\\n?)?`,
      'g',
    );

    const updatedContent = note.content.replace(embedPattern, '');

    const figures = Array.isArray(note.data.figures)
      ? (note.data.figures as string[]).filter((f) => f !== figureFilename)
      : note.data.figures;

    await this.vault.createNote(draftPath, {
      data: { ...note.data, figures },
      content: updatedContent,
    });
  }

  async listDrafts(): Promise<NoteOutput[]> {
    const paths = await this.vault.listNotes('drafts');
    const drafts: NoteOutput[] = [];
    for (const p of paths) {
      const note = await this.vault.readNote(p);
      if (note) drafts.push(note);
    }
    return drafts;
  }
}
