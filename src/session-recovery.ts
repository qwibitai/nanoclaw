import { ContainerOutput } from './container-runner.js';

const SESSION_RESET_PATTERNS = [
  /No conversation found with session ID/i,
  /Start a new session with fewer images\./i,
  /exceeds the dimension limit for many-image requests/i,
];

function toTexts(value: string | null | undefined): string[] {
  if (!value) return [];
  return [value];
}

export function shouldResetSessionOnFailure(
  output: Pick<ContainerOutput, 'result' | 'error'>,
): boolean {
  const texts = [...toTexts(output.result), ...toTexts(output.error)];
  return texts.some((text) =>
    SESSION_RESET_PATTERNS.some((pattern) => pattern.test(text)),
  );
}
