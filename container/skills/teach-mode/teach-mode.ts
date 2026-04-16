import fs from 'fs';
import path from 'path';

export interface ProcedureStep {
  action: 'navigate' | 'click' | 'find' | 'type' | 'extract' | 'wait';
  target: string;
  description: string;
}

export interface Procedure {
  name: string;
  trigger: string;
  steps: ProcedureStep[];
  learnedFrom: string;
  acquisition: 'teach';
}

export function parseStepFromNarration(narration: string): ProcedureStep | null {
  const lower = narration.toLowerCase().trim();

  if (lower.startsWith('go to ') || lower.startsWith('navigate to ') || lower.startsWith('open ')) {
    const url = narration.replace(/^(go to|navigate to|open)\s+/i, '').trim();
    return { action: 'navigate', target: url, description: narration };
  }

  if (lower.startsWith('click ') || lower.startsWith('press ') || lower.startsWith('tap ')) {
    const target = narration.replace(/^(click|press|tap)\s+(on\s+)?/i, '').trim();
    return { action: 'click', target, description: narration };
  }

  if (lower.startsWith('find ') || lower.startsWith('look for ') || lower.startsWith('locate ')) {
    const target = narration.replace(/^(find|look for|locate)\s+/i, '').trim();
    return { action: 'find', target, description: narration };
  }

  if (lower.startsWith('type ') || lower.startsWith('enter ') || lower.startsWith('input ')) {
    const target = narration.replace(/^(type|enter|input)\s+/i, '').trim();
    return { action: 'type', target, description: narration };
  }

  if (lower.startsWith('wait ')) {
    return { action: 'wait', target: narration.replace(/^wait\s+/i, ''), description: narration };
  }

  return null;
}

export function buildProcedure(
  name: string,
  steps: ProcedureStep[],
  groupId: string,
): Procedure {
  return {
    name: name.replace(/\s+/g, '_').toLowerCase(),
    trigger: `user asks to ${name}`,
    steps,
    learnedFrom: `${new Date().toISOString()} teach mode in ${groupId}`,
    acquisition: 'teach',
  };
}

export function saveProcedureViaIpc(
  procedure: Procedure,
  ipcDir: string,
): void {
  const filename = `teach-${Date.now()}-${procedure.name}.json`;
  const filePath = path.join(ipcDir, 'tasks', filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      type: 'learn_feedback',
      feedback: `Learned procedure: ${procedure.name} — ${procedure.steps.length} steps via teach mode`,
      procedure,
    }),
  );
}
