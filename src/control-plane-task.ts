export interface NormalizedControlPlaneTask {
  id: string;
  status: string;
  prompt: string;
  raw: Record<string, unknown>;
  displayId: string;
  title?: string;
}

export function normalizeControlPlaneTask(
  raw: unknown,
): NormalizedControlPlaneTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const id = pickString(record, ['id', 'taskId', 'uuid']);
  if (!id) return null;

  const status = (pickString(record, ['status']) || '').trim().toLowerCase();
  const title =
    pickString(record, ['title', 'name', 'summary']) || undefined;
  const displayId =
    pickString(record, ['taskNumber', 'identifier', 'slug']) || id;

  const prompt = buildPrompt(record, title);
  if (!prompt) return null;

  return {
    id,
    status,
    prompt,
    raw: record,
    displayId,
    title,
  };
}

export function isBacklogTask(task: NormalizedControlPlaneTask): boolean {
  return task.status === 'backlog';
}

function buildPrompt(
  record: Record<string, unknown>,
  title?: string,
): string | null {
  const directPrompt = pickString(record, [
    'prompt',
    'body',
    'content',
    'description',
    'details',
    'instructions',
  ]);
  if (directPrompt) return directPrompt.trim();

  const pieces = [
    title ? `Task: ${title}` : null,
    pickString(record, ['acceptanceCriteria', 'acceptance_criteria']),
    pickString(record, ['goal', 'objective']),
  ].filter((value): value is string => !!value && value.trim().length > 0);

  if (pieces.length === 0) return null;
  return pieces.join('\n\n').trim();
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
