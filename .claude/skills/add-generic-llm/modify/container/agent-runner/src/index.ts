import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Claude provider imports (original)
import {
  query,
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// Conditional generic LLM provider
const USE_GENERIC_LLM =
  process.env.LLM_PROVIDER === 'generic' ||
  (!!process.env.LLM_API_KEY &&
    !!process.env.LLM_API_BASE &&
    !!process.env.LLM_MODEL);

if (USE_GENERIC_LLM) {
  // In generic mode, delegate to provider-generic-llm (compiled JS path)
  // Note: skills engine will replace this file, so we implement a tiny delegator here.
  const provider = await import('./provider-generic-llm.js');
  // provider-generic-llm has its own main() that reads stdin and writes output markers
  // To keep container entrypoint unchanged, we simply re-export its main.
  (provider as any).default?.() ?? (provider as any).main?.();
} else {
  // Fallback to original Claude implementation
  // This block mirrors the original index.ts content by importing its JS output.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const original = await import(path.join(__dirname, 'index.claude.js')).catch(
    () => null,
  );
  if (original?.main) {
    (original as any).main();
  } else {
    // If original module isn't available, inline minimal bootstrap to avoid crash.
    console.error(
      '[agent-runner] Missing Claude runner. Please rebuild container or disable generic LLM mode.',
    );
    process.exit(1);
  }
}
