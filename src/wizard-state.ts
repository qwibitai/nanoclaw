import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';

const STATE_PATH = path.join(STORE_DIR, 'wizard-state.json');

export interface WizardState {
  agentName: string;
  personality: string;
  customPersonality: string;
  provider: string;
  budgetTier: string;
  channel: string;
  completedSteps: string[];
}

const DEFAULT_STATE: WizardState = {
  agentName: '',
  personality: '',
  customPersonality: '',
  provider: '',
  budgetTier: '',
  channel: '',
  completedSteps: [],
};

export function readWizardState(): WizardState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf-8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function writeWizardState(state: WizardState): void {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

export function markStepComplete(step: string): void {
  const state = readWizardState();
  if (!state.completedSteps.includes(step)) {
    state.completedSteps.push(step);
  }
  writeWizardState(state);
}

export function isWizardComplete(): boolean {
  const state = readWizardState();
  return state.completedSteps.includes('done');
}
